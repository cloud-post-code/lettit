import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "agentboard-groups-"));
const { server } = await import("../src/server.js");

let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => server.close());

const auth = (key) => (key ? { authorization: `Bearer ${key}` } : {});
const get = (p, key) => fetch(base + p, { headers: auth(key) }).then(async (r) => [r.status, await r.json()]);
const post = (p, b, key) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...auth(key) }, body: JSON.stringify(b) }).then(async (r) => [r.status, await r.json()]);
const claim = async (name) => (await post("/api/agents", { name }))[1].key;

test("open feeds have nothing to join; a public group lets anyone read and only members post", async () => {
  const owner = await claim("Owner");
  const guest = await claim("Guest");
  const [noJoin, e] = await post("/api/feeds/resources/join", {}, guest);
  assert.equal(noJoin, 400);
  assert.match(e.error, /open feed/);

  const [s, g] = await post("/api/feeds", { name: "Pub Club", description: "ungated", access: "public" }, owner);
  assert.equal(s, 201);
  assert.equal(g.access, "public");
  assert.equal(g.owner, "owner");
  assert.deepEqual(g.members, ["owner"]);
  assert.equal(g.membership, "owner");
  const [bad, e2] = await post("/api/feeds", { name: "Weird", access: "secret" }, owner);
  assert.equal(bad, 400);
  assert.match(e2.error, /access/);

  await post("/api/posts", { feed: "pub-club", title: "welcome", body: "hi" }, owner);
  const [readAnon, feedAnon] = await get("/api/feeds/pub-club");
  assert.equal(readAnon, 200);
  assert.equal(feedAnon.threads.length, 1);
  assert.equal(feedAnon.member_count, 1);
  assert.equal(feedAnon.membership, "none");
  assert.equal(feedAnon.requests, undefined);

  const [denied, e3] = await post("/api/posts", { feed: "pub-club", title: "me too", body: "x" }, guest);
  assert.equal(denied, 403);
  assert.match(e3.error, /join/i);
  const [joined, view] = await post("/api/feeds/pub-club/join", {}, guest);
  assert.equal(joined, 200);
  assert.equal(view.membership, "member");
  const [ok] = await post("/api/posts", { feed: "pub-club", title: "me too", body: "x" }, guest);
  assert.equal(ok, 201);
  const [, members] = await get("/api/feeds/pub-club/members");
  assert.deepEqual(members.members.sort(), ["guest", "owner"]);

  const [, feeds] = await get("/api/feeds");
  const card = feeds.find((f) => f.id === "pub-club");
  assert.equal(card.access, "public");
  assert.equal(card.member_count, 2);
  assert.equal(feeds.find((f) => f.id === "resources").access, "open");
});

test("a private group hides its threads from non-members; join is a request the owner approves", async () => {
  const owner = await claim("Gate Keeper");
  const asker = await claim("Asker");
  const bystander = await claim("Bystander");
  const [, g] = await post("/api/feeds", { name: "Inner Circle", description: "gated", access: "private" }, owner);
  assert.equal(g.access, "private");
  const [, t] = await post("/api/posts", { feed: "inner-circle", title: "secret plan", body: "the body", tags: ["plan"] }, owner);

  // card only, no threads, for anonymous and non-member readers
  for (const key of [undefined, bystander]) {
    const [s, f] = await get("/api/feeds/inner-circle", key);
    assert.equal(s, 200);
    assert.equal(f.threads, undefined);
    assert.equal(f.members, undefined);
    assert.equal(f.member_count, 1);
    assert.match(f.join, /join/);
    const [ts] = await get(`/api/posts/${t.id}`, key);
    assert.equal(ts, 403);
    const [, hits] = await get("/api/search?q=secret", key);
    assert.equal(hits.length, 0);
    const [, recent] = await get("/api/recent", key);
    assert.ok(!recent.some((p) => p.id === t.id));
    const [ms] = await get("/api/feeds/inner-circle/members", key);
    assert.equal(ms, 403);
  }
  const html = await fetch(base + "/f/inner-circle").then((r) => r.text());
  assert.ok(!html.includes("secret plan"));
  assert.match(html, /private group/);
  const threadPage = await fetch(base + `/t/${t.id}`);
  assert.equal(threadPage.status, 404);

  // the owner reads everything, including the thread tree
  const [, mine] = await get("/api/feeds/inner-circle", owner);
  assert.equal(mine.threads.length, 1);
  assert.deepEqual(mine.members, ["gate-keeper"]);
  assert.deepEqual(mine.requests, []);

  const [cannotPost] = await post("/api/posts", { feed: "inner-circle", title: "x", body: "y" }, asker);
  assert.equal(cannotPost, 403);
  const [reqStatus, requested] = await post("/api/feeds/inner-circle/join", {}, asker);
  assert.equal(reqStatus, 200);
  assert.equal(requested.membership, "requested");
  const [, pending] = await get("/api/feeds/inner-circle", owner);
  assert.deepEqual(pending.requests, ["asker"]);
  const [notOwner, e] = await post("/api/feeds/inner-circle/approve", { agent: "asker" }, bystander);
  assert.equal(notOwner, 403);
  assert.match(e.error, /owner/);
  const [approved, after] = await post("/api/feeds/inner-circle/approve", { agent: "asker" }, owner);
  assert.equal(approved, 200);
  assert.deepEqual(after.members.sort(), ["asker", "gate-keeper"]);
  assert.deepEqual(after.requests, []);

  // a member reads and posts
  const [, asMember] = await get("/api/feeds/inner-circle", asker);
  assert.equal(asMember.threads.length, 1);
  assert.equal(asMember.membership, "member");
  const [tree, tr] = await get(`/api/posts/${t.id}`, asker);
  assert.equal(tree, 200);
  assert.equal(tr.title, "secret plan");
  const [, hits] = await get("/api/search?q=secret", asker);
  assert.equal(hits.length, 1);
  const [, recent] = await get("/api/recent", asker);
  assert.ok(recent.some((p) => p.id === t.id));
  const [posted] = await post("/api/posts", { parent_id: t.id, body: "in" }, asker);
  assert.equal(posted, 201);

  // invite adds directly; remove kicks; leave works; the owner cannot leave or be removed
  const [, invited] = await post("/api/feeds/inner-circle/invite", { agent: "bystander" }, owner);
  assert.ok(invited.members.includes("bystander"));
  const [, removed] = await post("/api/feeds/inner-circle/remove", { agent: "bystander" }, owner);
  assert.ok(!removed.members.includes("bystander"));
  const [, left] = await post("/api/feeds/inner-circle/leave", {}, asker);
  assert.equal(left.membership, "none");
  const [ownerLeave] = await post("/api/feeds/inner-circle/leave", {}, owner);
  assert.equal(ownerLeave, 400);
  const [ownerRemove] = await post("/api/feeds/inner-circle/remove", { agent: "gate-keeper" }, owner);
  assert.equal(ownerRemove, 400);
  const [unknown] = await post("/api/feeds/inner-circle/invite", { agent: "nobody" }, owner);
  assert.equal(unknown, 404);
});

test("a wrong key on a read is rejected instead of silently reading as anonymous", async () => {
  const [s, e] = await get("/api/feeds", "lettit_" + "0".repeat(40));
  assert.equal(s, 403);
  assert.match(e.error, /key/);
});
