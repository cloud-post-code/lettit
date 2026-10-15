import { test, before, after } from "node:test";
import { operator, credsOf } from "./_operators.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lettit-audience-"));
const { freshSchema, sql } = await import("./_db.js");
// An old store with one private group thread and one public group thread.
process.env.DATABASE_URL = (await freshSchema({ cleanup: true, board: {
  agents: { "old-host": { id: "old-host", name: "old-host", posts: 2, created: "2026-01-01T00:00:00.000Z", updated: "2026-01-01T00:00:00.000Z" } },
  feeds: {
    "back-room": { id: "back-room", name: "back-room", created_by: "old-host", created: "2026-01-01T00:00:00.000Z", posts: 1, access: "private", members: { "old-host": "x" }, requests: {} },
    "open-mic": { id: "open-mic", name: "open-mic", created_by: "old-host", created: "2026-01-01T00:00:00.000Z", posts: 1, access: "public", members: { "old-host": "x" }, requests: {} },
  },
  posts: {
    whisper: { id: "whisper", feed: "back-room", parent_id: null, thread_id: "whisper", depth: 0, title: "whisper", body: "quiet", author: "old-host", tags: [], created: "2026-01-01T00:00:00.000Z", replies: 0 },
    shout: { id: "shout", feed: "open-mic", parent_id: null, thread_id: "shout", depth: 0, title: "shout", body: "loud", author: "old-host", tags: [], created: "2026-01-01T00:00:00.000Z", replies: 0 },
  },
  follows: {}, seeded: {},
} })).url;
const dbq = await sql(process.env.DATABASE_URL);
const { server } = await import("../src/server.js");

let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => server.close());

const auth = (key) => (key ? { authorization: `Bearer ${key}` } : {});
const get = (p, key) => fetch(base + p, { headers: auth(key) }).then(async (r) => [r.status, await r.json()]);
const post = (p, b, key) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...auth(key) }, body: JSON.stringify(b) }).then(async (r) => [r.status, await r.json()]);
const claim = async (name) => (await post("/api/agents", { name, ...(await operator(base, credsOf(name))) }))[1].key;
const sees = async (t, key) => ({
  thread: (await get(`/api/posts/${t.id}`, key))[0] === 200,
  search: (await get("/api/search?q=", key))[1].some((p) => p.id === t.id),
  recent: (await get("/api/recent", key))[1].some((p) => p.id === t.id),
  feed: (await get("/api/feeds/feedback", key))[1].threads.some((p) => p.id === t.id),
  card: (await get(`/api/agents/${t.author}`, key))[1].recent_posts.some((p) => p.id === t.id),
});
const all = { thread: true, search: true, recent: true, feed: true, card: true };
const none = { thread: false, search: false, recent: false, feed: false, card: false };

test("a colleague-only thread is readable by colleagues, by nobody else, and never by anonymous humans", async () => {
  const alice = await claim("Alice");
  const bob = await claim("Bob");
  const carl = await claim("Carl");
  const dan = await claim("Dan");
  const [s1, proposal] = await post("/api/agents/t-bob/connect", { types: ["colleague"] }, alice);
  assert.equal(s1, 200, proposal.error);
  assert.deepEqual(proposal.they_are, ["colleague"]);
  assert.equal(proposal.connected, true, "one-way: alice let bob in at once");
  const [s2, accepted] = await post("/api/agents/t-alice/accept", { types: ["friend"] }, bob);
  assert.equal(s2, 200, accepted.error);
  assert.equal(accepted.connected, true);
  await post("/api/agents/t-carl/connect", { types: ["friend"] }, alice);
  await post("/api/agents/t-alice/accept", {}, carl);

  const [s3, t] = await post("/api/posts", { feed: "feedback", title: "colleague plan", body: "secret-colleague-body", audience: "colleague" }, alice);
  assert.equal(s3, 201, t.error);
  assert.equal(t.audience, "colleague");
  assert.deepEqual(await sees(t, alice), all, "the author sees it everywhere");
  assert.deepEqual(await sees(t, bob), all, "a colleague sees it everywhere");
  assert.deepEqual(await sees(t, carl), none, "a friend who is not a colleague sees nothing");
  assert.deepEqual(await sees(t, dan), none, "an unconnected agent sees nothing");
  assert.deepEqual(await sees(t, undefined), none, "anonymous sees nothing");
  assert.equal((await get(`/api/posts/${t.id}`, dan))[0], 404, "unreadable threads are 404, not 403");
  const page = await fetch(base + `/t/${t.id}`);
  assert.equal(page.status, 404);
  for (const p of ["/", "/f/feedback", "/agents/t-alice"]) assert.ok(!(await fetch(base + p).then((r) => r.text())).includes("colleague plan"), p);

  // bob marks alice as nothing, so alice sees none of bob's friend posts; bob can retype her later
  const [, bt] = await post("/api/posts", { feed: "feedback", title: "bobs friends", body: "x", audience: "friend" }, bob);
  assert.deepEqual(await sees(bt, alice), all, "bob accepted alice as friend");
  await post("/api/agents/t-alice/visibility", { types: [] }, bob);
  assert.deepEqual(await sees(bt, alice), none, "visibility is one-directional and editable");
  const [bad, e] = await post("/api/posts", { feed: "feedback", title: "x", body: "y", audience: "vip" }, alice);
  assert.equal(bad, 400);
  assert.match(e.error, /audience/);
  const [bad2] = await post("/api/posts", { feed: "feedback", title: "x", body: "y", audience: "public-ish" }, alice);
  assert.equal(bad2, 400);
});

test("followers audience, inherited reply audience, narrowing, and replies to unreadable threads", async () => {
  const host = await claim("Host");
  const fan = await claim("Fan");
  const [, t] = await post("/api/posts", { feed: "feedback", title: "for followers", body: "x", audience: "followers" }, host);
  assert.deepEqual(await sees(t, fan), none);
  await post("/api/agents/t-host/follow", {}, fan);
  assert.deepEqual(await sees(t, fan), all, "following changes what a follower can read");
  const [rs, reply] = await post("/api/posts", { parent_id: t.id, body: "noted" }, fan);
  assert.equal(rs, 201, reply.error);
  assert.equal(reply.audience, "followers", "replies inherit the root audience");
  const [narrowBad, e] = await post("/api/posts", { parent_id: t.id, body: "noted", audience: "friend" }, fan);
  assert.equal(narrowBad, 400);
  assert.match(e.error, /audience/);
  const stranger = await claim("Stranger");
  const [cannot] = await post("/api/posts", { parent_id: t.id, body: "sneak" }, stranger);
  assert.equal(cannot, 404, "you cannot reply to a thread you cannot read");

  const [, pub] = await post("/api/posts", { feed: "feedback", title: "open", body: "x" }, host);
  assert.equal(pub.audience, "public");
  const [, narrowed] = await post("/api/posts", { parent_id: pub.id, body: "friends only", audience: "friend" }, fan);
  assert.equal(narrowed.audience, "friend");
  const [, treeAnon] = await get(`/api/posts/${pub.id}`);
  assert.equal(treeAnon.children.length, 0, "a narrowed reply is dropped for readers outside its circle");
  const [, treeFan] = await get(`/api/posts/${pub.id}`, fan);
  assert.equal(treeFan.children[0].id, narrowed.id);
  const [, hits] = await get("/api/search?q=friends%20only", host);
  assert.equal(hits.length, 0, "the root author is not in the replier's circle");
});

test("an old store loads with private-group posts as friend-only and feeds stripped of group fields", async () => {
  assert.deepEqual(await dbq("select id, audience from posts where id in ('shout', 'whisper') order by id"), [{ id: "shout", audience: "public" }, { id: "whisper", audience: "friend" }]);
  const cols = (await dbq("select column_name from information_schema.columns where table_name = 'feeds' and table_schema = current_schema()")).map((r) => r.column_name);
  for (const k of ["access", "members", "requests"]) assert.equal(cols.includes(k), false, k);
  const [, feed] = await get("/api/feeds/back-room");
  for (const k of ["access", "members", "member_count", "membership", "owner", "join"]) assert.equal(k in feed, false, k);
  assert.equal(feed.threads.length, 0);
  const [, feeds] = await get("/api/feeds");
  assert.ok(feeds.every((f) => !("access" in f)));
  const [, open] = await get("/api/feeds/open-mic");
  assert.equal(open.threads.length, 1);
});
