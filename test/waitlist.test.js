// The landing page's waitlist: POST /api/waitlist stores the row, /admin/waitlist.csv reads them back.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { freshSchema, sql } from "./_db.js";

delete process.env.POSTHOG_API_KEY;
process.env.ADMIN_USER = "chris";
process.env.ADMIN_PASSWORD = "very-secret-admin-pw";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lettit-waitlist-"));
const schema = await freshSchema({ cleanup: true });
process.env.DATABASE_URL = schema.url;
const { server } = await import("../src/server.js");
const analytics = await import("../src/analytics.js");
const db = await sql(schema.url);

let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => server.close());

const join = (body, headers = {}) => fetch(base + "/api/waitlist", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }).then(async (r) => [r.status, await r.json()]);
const basic = (u, p) => ({ authorization: "Basic " + Buffer.from(`${u}:${p}`).toString("base64") });
const rows = () => db("select email, code, interests, created from waitlist order by created");

test("a valid email lands in the waitlist table", async () => {
  const [s, b] = await join({ email: "  Ann@Example.com " });
  assert.equal(s, 201);
  assert.equal(b.email, "ann@example.com");
  assert.equal(b.repeat, false);
  assert.equal(b.code, null);
  assert.deepEqual(b.interests, []);
  const r = await rows();
  assert.equal(r.length, 1);
  assert.equal(r[0].email, "ann@example.com");
});

test("a bad email or a short code is refused and stores nothing", async () => {
  const [s1, b1] = await join({ email: "not-an-email" });
  assert.equal(s1, 400);
  assert.match(b1.error, /email/i);
  const [s2, b2] = await join({ email: "zed@example.com", code: "ab" });
  assert.equal(s2, 400);
  assert.match(b2.error, /code/i);
  const [s3] = await join({});
  assert.equal(s3, 400);
  assert.equal((await rows()).length, 1);
});

test("joining again updates code and picks, keeps one row and its signup date", async () => {
  const [before_] = await rows();
  const [s, b] = await join({ email: "ANN@example.com", code: "ab12cd", interests: ["Travel", "Running"] });
  assert.equal(s, 201);
  assert.equal(b.repeat, true);
  assert.equal(b.code, "AB12CD");
  assert.deepEqual(b.interests, ["Travel", "Running"]);
  const r = await rows();
  assert.equal(r.length, 1);
  assert.equal(r[0].code, "AB12CD");
  assert.deepEqual(r[0].interests, ["Travel", "Running"]);
  assert.equal(String(r[0].created), String(before_.created));
});

test("the admin CSV needs the admin password and lists newest first", async () => {
  await join({ email: "bob@example.com", interests: ["Home espresso"] });
  const anon = await fetch(base + "/admin/waitlist.csv");
  assert.equal(anon.status, 401);
  const r = await fetch(base + "/admin/waitlist.csv", { headers: basic("chris", "very-secret-admin-pw") });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /^text\/csv/);
  const lines = (await r.text()).trim().split("\n");
  assert.equal(lines[0], "email,code,interests,created");
  assert.equal(lines.length, 3);
  assert.match(lines[1], /^bob@example\.com,,Home espresso,/);
  assert.match(lines[2], /^ann@example\.com,AB12CD,Travel;Running,/);
});

test("a join records waitlist_joined without the address", async () => {
  await join({ email: "cat@example.com", code: "WXYZ" });
  await analytics.flush();
  const [ev] = await db("select distinct_id, properties from events where event = 'waitlist_joined' order by id desc limit 1");
  assert.ok(ev, "waitlist_joined captured");
  assert.equal(ev.properties.invite, true);
  assert.equal(ev.properties.repeat, false);
  assert.ok(!JSON.stringify(ev).includes("cat@example.com"));
});

test("the 21st join from one address in the window is 429", async () => {
  const ip = { "x-forwarded-for": "203.0.113.9" };
  let last;
  for (let i = 0; i < 21; i++) last = await join({ email: `p${i}@example.com` }, ip);
  assert.equal(last[0], 429);
  assert.equal((await join({ email: "p99@example.com" }))[0], 201, "other addresses are not limited");
});

test("the served form script posts to the API instead of pretending", async () => {
  const js = await (await fetch(base + "/common.js")).text();
  assert.match(js, /fetch\(['"]\/api\/waitlist['"]/);
  assert.ok(!js.includes("Promise.resolve(p)"));
});
