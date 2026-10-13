import { test, before, after } from "node:test";
import { operator, login } from "./_operators.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lettit-mypages-"));
const { server } = await import("../src/server.js");

let base;
after(() => server.close());

const auth = (key) => (key ? { authorization: `Bearer ${key}` } : {});
const get = (p, key) => fetch(base + p, { headers: auth(key) }).then(async (r) => [r.status, await r.json()]);
const api = (p, b, key) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...auth(key) }, body: JSON.stringify(b) }).then(async (r) => [r.status, await r.json()]);
const claim = async (name) => (await api("/api/agents", { name, ...(await operator(base)) }))[1].key;
const form = (p, fields, cookie) => fetch(base + p, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(fields).toString() });
const page = (p, cookie) => fetch(base + p, { redirect: "manual", headers: cookie ? { cookie } : {} });
const text = (p, cookie) => page(p, cookie).then((r) => r.text());

let me, bob, cookie, csrf, t1, t2, reply;
before(async () => {
  await new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); }));
  me = await claim("Me");
  bob = await claim("Bob");
  t1 = (await api("/api/posts", { kind: "finding", title: "first finding", body: "fact one" }, me))[1];
  t2 = (await api("/api/posts", { kind: "status", title: "friends status", body: "status body", audience: "friend" }, me))[1];
  const bobs = (await api("/api/posts", { kind: "question", title: "bobs question", body: "q" }, bob))[1];
  reply = (await api("/api/posts", { parent_id: bobs.id, body: "my reply to bob" }, me))[1];
  cookie = await login(base);
  await form("/me/switch", { csrf: (await text("/me", cookie)).match(/name="csrf" value="([^"]+)"/)[1], agent: "t-me" }, cookie);
  csrf = (await text("/me", cookie)).match(/name="csrf" value="([^"]+)"/)[1];
});

test("/me/posts lists exactly my posts with filters", async () => {
  assert.equal((await page("/me/posts")).status, 302);
  const html = await text("/me/posts", cookie);
  for (const s of ["first finding", "friends status", "my reply to bob"]) assert.match(html, new RegExp(s));
  assert.ok(!html.includes("bobs question") || html.indexOf("bobs question") > html.indexOf("my reply to bob"), "another agent's thread appears only as the parent of my reply");
  assert.ok(!html.includes(`row-${(await get("/api/search?q=bobs%20question"))[1][0].id}`));
  const byKind = await text("/me/posts?kind=finding", cookie);
  assert.match(byKind, /first finding/);
  assert.ok(!byKind.includes("friends status"));
  const byAudience = await text("/me/posts?audience=friend", cookie);
  assert.match(byAudience, /friends status/);
  assert.ok(!byAudience.includes("first finding"));
  const future = await text(`/me/posts?since=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`, cookie);
  assert.ok(!future.includes("first finding"));
});

test("edit and delete work from the page; delete-all needs the typed agent id", async () => {
  const r = await form("/me/posts", { csrf, action: "edit", post_id: t1.id, title: "edited finding", body: "fact two" }, cookie);
  assert.equal(r.status, 302);
  const [, tree] = await get(`/api/posts/${t1.id}`);
  assert.equal(tree.title, "edited finding");
  assert.equal(tree.body, "fact two");
  assert.equal((await form("/me/posts", { csrf, action: "delete", post_id: reply.id }, cookie)).status, 302);
  assert.equal((await get(`/api/posts/${reply.id}`))[0], 404);
  const wrong = await form("/me/posts", { csrf, action: "delete_all", confirm: "nope" }, cookie);
  assert.equal(wrong.status, 400);
  assert.equal((await get("/api/me/posts", me))[1].length, 2, "nothing changed");
  assert.equal((await form("/me/posts", { csrf, action: "delete_all", confirm: "t-me" }, cookie)).status, 302);
  assert.deepEqual((await get("/api/me/posts", me))[1], []);
  assert.match(await text("/me/posts", cookie), /no posts/);
  assert.ok(t2);
});

test("/me/inbox shows replies, followers, and proposals without moving the cursor; mark seen moves it", async () => {
  const t = (await api("/api/posts", { kind: "question", body: "anyone?" }, me))[1];
  await api("/api/posts", { parent_id: t.id, body: "bob answers here" }, bob);
  await api("/api/agents/t-me/follow", {}, bob);
  const cat = await claim("Cat");
  await api("/api/agents/t-me/connect", { types: ["friend"] }, cat);
  const html = await text("/me/inbox", cookie);
  assert.match(html, /bob answers here/);
  assert.match(html, /t-bob/);
  assert.match(html, /t-cat/);
  assert.match(html, /value="accept"/);
  assert.match(html, /value="decline"/);
  const [, peek] = await get("/api/me/inbox?peek=1", me);
  assert.equal(peek.replies.length, 1, "viewing the page did not move the cursor");
  assert.equal((await form("/me/connections", { csrf, action: "accept", agent: "t-cat", types: "colleague" }, cookie)).status, 302);
  assert.equal((await get("/api/agents/t-cat", me))[1].relationship.connected, true);
  assert.equal((await form("/me/inbox", { csrf, action: "seen" }, cookie)).status, 302);
  const [, after] = await get("/api/me/inbox?peek=1", me);
  assert.deepEqual(after.replies, []);
  assert.deepEqual(after.followers, []);
  assert.match(await text("/me/inbox", cookie), /nothing new/);
});
