// The landing page waitlist: POST /api/waitlist keeps every address in Postgres (one row per email), and the
// operator reads the list, the community picks, and a CSV export on the /admin dashboard.
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
const db = await sql(schema.url);

let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => server.close());

const BROWSER = "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const basic = (u, p) => ({ authorization: "Basic " + Buffer.from(`${u}:${p}`).toString("base64") });
const admin = (p = "/admin") => fetch(base + p, { headers: { ...basic("chris", "very-secret-admin-pw"), "user-agent": BROWSER } });
const join = (body, headers = {}) => fetch(base + "/api/waitlist", { method: "POST", headers: { "content-type": "application/json", "user-agent": BROWSER, ...headers }, body: JSON.stringify(body) });
const text = (s) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

test("the landing page posts to the API instead of pretending", async () => {
  const js = await (await fetch(base + "/common.js")).text();
  assert.match(js, /fetch\('\/api\/waitlist'/);
  assert.ok(!/Promise\.resolve\(p\)/.test(js), "the stub is gone");
  assert.ok(!/Check your inbox/.test(js), "no promise of an email nothing sends");
});

test("a join is kept: lowercased email, picks, visitor, and a 201", async () => {
  const r = await join({ email: "  Ada@Example.COM ", communities: ["Travel", "Running", "Travel", ""] }, { referer: "https://lettit.test/?utm=x" });
  assert.equal(r.status, 201);
  const j = await r.json();
  assert.deepEqual({ ok: j.ok, email: j.email, communities: j.communities, already: j.already }, { ok: true, email: "ada@example.com", communities: ["Travel", "Running"], already: false });
  const [row] = await db("select email, communities, code, visitor, referrer, joins from waitlist where email = $1", ["ada@example.com"]);
  assert.equal(row.code, null);
  assert.deepEqual(row.communities, ["Travel", "Running"]);
  assert.equal(row.joins, 1);
  assert.equal(row.referrer, "https://lettit.test/?utm=x");
  assert.ok(row.visitor, "the visitor id is kept so the funnel can tie the signup to the pageview");
});

test("joining again does not duplicate: same row, picks refreshed, counted", async () => {
  const r = await join({ email: "ada@example.com", communities: ["Home espresso"], code: "abcd1" });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).already, true);
  const rows = await db("select communities, code, joins from waitlist where email = $1", ["ada@example.com"]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].communities, ["Home espresso"]);
  assert.equal(rows[0].code, "ABCD1");
  assert.equal(rows[0].joins, 2);
  // a rejoin with no picks keeps the old ones
  await join({ email: "ada@example.com" });
  assert.deepEqual((await db("select communities from waitlist where email = $1", ["ada@example.com"]))[0].communities, ["Home espresso"]);
});

test("a bad address is a 400 and nothing is kept", async () => {
  for (const email of ["", "nope", "a@b", "   ", null]) {
    const r = await join({ email });
    assert.equal(r.status, 400, `email ${JSON.stringify(email)}`);
    assert.match((await r.json()).error, /valid email/);
  }
  assert.equal(Number((await db("select count(*) as c from waitlist"))[0].c), 1);
});

test("GET /api/waitlist says how to use it instead of listing anyone", async () => {
  const r = await fetch(base + "/api/waitlist");
  assert.equal(r.status, 404);
  assert.match((await r.json()).error, /POST \/api\/waitlist/);
  assert.ok(!(await fetch(base + "/api/waitlist").then((x) => x.text())).includes("ada@example.com"));
});

test("the dashboard shows the list, the picks, and the totals", async () => {
  await join({ email: "grace@example.com", communities: ["Travel", "Indie hackers"] });
  const r = await admin();
  assert.equal(r.status, 200);
  const html = await r.text();
  const t = text(html);
  assert.match(t, /2 On the waitlist/);
  assert.match(t, /Waitlist 2 total · 2 in the last 30 days · 1 with an invite code/);
  assert.ok(html.includes('href="mailto:grace@example.com"'));
  assert.ok(html.includes("ada@example.com"));
  assert.ok(html.includes("ABCD1"));
  assert.match(t, /Travel 1/);
  assert.match(t, /Home espresso 1/);
  assert.ok(html.includes('href="/admin?export=waitlist"'));
  // newest first
  assert.ok(html.indexOf("grace@example.com") < html.indexOf("ada@example.com"));
});

test("the CSV export has everyone and needs the same credentials", async () => {
  const anon = await fetch(base + "/admin?export=waitlist");
  assert.equal(anon.status, 401);
  const r = await admin("/admin?export=waitlist");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/csv/);
  assert.match(r.headers.get("content-disposition"), /lettit-waitlist-\d{4}-\d{2}-\d{2}\.csv/);
  const lines = (await r.text()).trim().split("\r\n");
  assert.equal(lines[0], "email,communities,invite_code,joins,joined_at,last_seen_at");
  assert.equal(lines.length, 3);
  assert.match(lines[1], /^grace@example\.com,Travel; Indie hackers,,1,/);
  assert.match(lines[2], /^ada@example\.com,Home espresso,ABCD1,3,/);
});

test("the dashboard with nobody on the list still renders", async () => {
  await db("delete from waitlist");
  const t = text(await (await admin()).text());
  assert.match(t, /0 On the waitlist/);
  assert.match(t, /nobody yet/);
  assert.match(t, /no picks yet/);
});

test("one address is limited to 20 joins an hour", async () => {
  const h = { "x-forwarded-for": "203.0.113.9" };
  let last;
  for (let i = 0; i < 20; i++) last = await join({ email: `p${i}@example.com` }, h);
  assert.equal(last.status, 201);
  const over = await join({ email: "p21@example.com" }, h);
  assert.equal(over.status, 429);
  assert.equal(Number((await db("select count(*) as c from waitlist where email = 'p21@example.com'"))[0].c), 0);
  // another address is not affected
  assert.equal((await join({ email: "p22@example.com" }, { "x-forwarded-for": "203.0.113.10" })).status, 201);
});
