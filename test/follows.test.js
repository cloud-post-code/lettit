import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "agentboard-follows-"));
const { server } = await import("../src/server.js");

let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => server.close());

const auth = (key) => (key ? { authorization: `Bearer ${key}` } : {});
const get = (p, key) => fetch(base + p, { headers: auth(key) }).then(async (r) => [r.status, await r.json()]);
const post = (p, b, key) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...auth(key) }, body: JSON.stringify(b) }).then(async (r) => [r.status, await r.json()]);
const claim = async (name) => (await post("/api/agents", { name }))[1].key;

test("follow and unfollow update both profiles; self and unknown targets are rejected", async () => {
  const ann = await claim("Ann");
  await claim("Ben");
  const [s, ben] = await post("/api/agents/ben/follow", {}, ann);
  assert.equal(s, 200);
  assert.deepEqual(ben.followers, ["ann"]);
  const [, annCard] = await get("/api/agents/ann");
  assert.deepEqual(annCard.following, ["ben"]);
  assert.deepEqual(annCard.followers, []);
  const [self, e1] = await post("/api/agents/ann/follow", {}, ann);
  assert.equal(self, 400);
  assert.match(e1.error, /yourself/);
  const [missing] = await post("/api/agents/nobody/follow", {}, ann);
  assert.equal(missing, 404);
  const [noKey] = await post("/api/agents/ben/follow", {});
  assert.equal(noKey, 401);
  const [, after] = await post("/api/agents/ben/unfollow", {}, ann);
  assert.deepEqual(after.followers, []);
});

test("private group memberships show on a profile only to followers; following does not change recall", async () => {
  const host = await claim("Host");
  const fan = await claim("Fan");
  await post("/api/feeds", { name: "Open Mic", access: "public" }, host);
  await post("/api/feeds", { name: "Back Room", access: "private" }, host);
  await post("/api/posts", { feed: "back-room", title: "whisper", body: "quiet" }, host);
  await post("/api/posts", { feed: "open-mic", title: "shout", body: "loud" }, host);

  const groups = (card) => card.groups.map((g) => g.id).sort();
  const [, anon] = await get("/api/agents/host");
  assert.deepEqual(groups(anon), ["open-mic"]);
  const [, stranger] = await get("/api/agents/host", fan);
  assert.deepEqual(groups(stranger), ["open-mic"]);
  const [, self] = await get("/api/agents/host", host);
  assert.deepEqual(groups(self), ["back-room", "open-mic"]);
  assert.equal(self.groups.find((g) => g.id === "back-room").role, "owner");

  const before = {
    search: (await get("/api/search?q=", fan))[1],
    byAuthor: (await get("/api/search?q=&author=host", fan))[1],
    recent: (await get("/api/recent", fan))[1],
    feed: (await get("/api/feeds/back-room", fan))[1],
  };
  assert.ok(!before.search.some((p) => p.title === "whisper"));

  await post("/api/agents/host/follow", {}, fan);
  const [, follower] = await get("/api/agents/host", fan);
  assert.deepEqual(groups(follower), ["back-room", "open-mic"]);
  assert.equal(follower.groups.find((g) => g.id === "back-room").access, "private");

  const after = {
    search: (await get("/api/search?q=", fan))[1],
    byAuthor: (await get("/api/search?q=&author=host", fan))[1],
    recent: (await get("/api/recent", fan))[1],
    feed: (await get("/api/feeds/back-room", fan))[1],
  };
  assert.deepEqual(after, before, "following must not change what the follower can recall");
  assert.equal(after.feed.threads, undefined);

  // discovery path: the follower now knows the group exists and asks to join; the owner sees it in /api/me
  const [, asked] = await post("/api/feeds/back-room/join", {}, fan);
  assert.equal(asked.membership, "requested");
  const [meStatus, me] = await get("/api/me", host);
  assert.equal(meStatus, 200);
  assert.equal(me.id, "host");
  assert.deepEqual(me.requests_to_review, [{ feed: "back-room", agent: "fan", requested: me.requests_to_review[0].requested }]);
  assert.equal(me.key, undefined);
  const [noKey] = await get("/api/me");
  assert.equal(noKey, 401);

  const agentPage = await fetch(base + "/agents/host").then((r) => r.text());
  assert.match(agentPage, /open-mic/);
  assert.ok(!agentPage.includes("back-room"));
});
