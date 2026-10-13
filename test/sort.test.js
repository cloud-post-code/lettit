import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "agentboard-sort-"));
const { server } = await import("../src/server.js");

let base;
after(() => server.close());

const auth = (key) => (key ? { authorization: `Bearer ${key}` } : {});
const get = (p, key) => fetch(base + p, { headers: auth(key) }).then(async (r) => [r.status, await r.json()]);
const post = (p, b, key) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...auth(key) }, body: JSON.stringify(b) }).then(async (r) => [r.status, await r.json()]);
const page = (p) => fetch(base + p).then((r) => r.text());
const claim = async (name) => (await post("/api/agents", { name, operator: "t" }))[1].key;
// The feed also holds a seeded thread with no comments; compare only the threads made here.
const mine = new Set();
const ids = (list) => list.map((t) => t.id).filter((id) => mine.has(id));

let quiet, busy, mid, key;
before(async () => {
  await new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); }));
  key = await claim("Ranker");
  const other = await claim("Chatter");
  quiet = (await post("/api/posts", { feed: "feedback", title: "quiet thread", body: "b" }, key))[1];
  mid = (await post("/api/posts", { feed: "feedback", title: "middling thread", body: "b" }, key))[1];
  busy = (await post("/api/posts", { feed: "feedback", title: "busy thread", body: "b" }, key))[1];
  for (const t of [quiet, mid, busy]) mine.add(t.id);
  // busy: one direct reply with two nested comments under it = 3 comments; plus a deleted one that must not count
  const [, r] = await post("/api/posts", { parent_id: busy.id, body: "r" }, other);
  await post("/api/posts", { parent_id: r.id, body: "rr" }, key);
  await post("/api/posts", { parent_id: r.id, body: "rr2" }, other);
  const [, dead] = await post("/api/posts", { parent_id: busy.id, body: "gone" }, key);
  await post(`/api/posts/${dead.id}/delete`, {}, key);
  // mid: two direct replies = 2 comments (more direct replies than busy, fewer comments in total)
  await post("/api/posts", { parent_id: mid.id, body: "a" }, other);
  await post("/api/posts", { parent_id: mid.id, body: "b" }, other);
});

test("listed threads carry a total comment count that spans depths and skips deleted comments", async () => {
  const [, f] = await get("/api/feeds/feedback");
  const by = Object.fromEntries(f.threads.map((t) => [t.id, t]));
  assert.equal(by[busy.id].comments, 3);
  assert.equal(by[busy.id].replies, 1);
  assert.equal(by[mid.id].comments, 2);
  assert.equal(by[quiet.id].comments, 0);
});

test("sort=comments ranks by comment count on feeds, recent, and posts; the default stays newest first", async () => {
  const [, newest] = await get("/api/feeds/feedback");
  assert.deepEqual(ids(newest.threads), [busy.id, mid.id, quiet.id]);
  const [, byNew] = await get("/api/feeds/feedback?sort=new");
  assert.deepEqual(ids(byNew.threads), ids(newest.threads));
  // make the tie-break observable: busy is newest, so put quiet (0) last and mid (2) between
  const [, ranked] = await get("/api/feeds/feedback?sort=comments");
  assert.deepEqual(ids(ranked.threads), [busy.id, mid.id, quiet.id]);
  const [, recent] = await get("/api/recent?sort=comments");
  assert.deepEqual(ids(recent), [busy.id, mid.id, quiet.id]);
  const [, posts] = await get("/api/posts?sort=comments");
  assert.equal(posts[0].id, busy.id);
  const [bad, e] = await get("/api/feeds/feedback?sort=hot");
  assert.equal(bad, 400);
  assert.match(e.error, /sort/);
});

test("sort=comments puts an older busy thread above a newer quiet one", async () => {
  const [, late] = await post("/api/posts", { feed: "feedback", title: "latest quiet thread", body: "b" }, key);
  mine.add(late.id);
  const [, newest] = await get("/api/feeds/feedback");
  assert.equal(newest.threads[0].id, late.id);
  const [, ranked] = await get("/api/feeds/feedback?sort=comments");
  assert.deepEqual(ids(ranked.threads), [busy.id, mid.id, late.id, quiet.id]);
});

test("the feed and home pages honour sort=comments and show the toggle", async () => {
  const feedPage = await page("/f/feedback?sort=comments");
  assert.ok(feedPage.indexOf("busy thread") < feedPage.indexOf("latest quiet thread"));
  assert.match(feedPage, /3 comments/);
  assert.match(feedPage, /href="\/f\/feedback\?sort=new"/);
  const feedDefault = await page("/f/feedback");
  assert.ok(feedDefault.indexOf("latest quiet thread") < feedDefault.indexOf("busy thread"));
  assert.match(feedDefault, /href="\/f\/feedback\?sort=comments"/);
  const home = await page("/?sort=comments");
  assert.ok(home.indexOf("busy thread") < home.indexOf("latest quiet thread"));
  assert.match(home, /href="\/\?sort=new"/);
  const homeDefault = await page("/");
  assert.match(homeDefault, /href="\/\?sort=comments"/);
});
