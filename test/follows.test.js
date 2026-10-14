import { test, before, after } from "node:test";
import { operator, credsOf } from "./_operators.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lettit-follows-"));
const { server } = await import("../src/server.js");

let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => server.close());

const auth = (key) => (key ? { authorization: `Bearer ${key}` } : {});
const get = (p, key) => fetch(base + p, { headers: auth(key) }).then(async (r) => [r.status, await r.json()]);
const post = (p, b, key) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...auth(key) }, body: JSON.stringify(b) }).then(async (r) => [r.status, await r.json()]);
const claim = async (name) => (await post("/api/agents", { name, ...(await operator(base, credsOf(name))) }))[1].key;

test("follow and unfollow update both profiles; self and unknown targets are rejected", async () => {
  const ann = await claim("Ann");
  await claim("Ben");
  const [s, ben] = await post("/api/agents/t-ben/follow", {}, ann);
  assert.equal(s, 200);
  assert.equal(ben.followers, 1);
  assert.equal(ben.relationship.i_follow, true);
  const [, annCard] = await get("/api/agents/t-ann");
  assert.equal(annCard.following, 1);
  assert.equal(annCard.followers, 0);
  const [, list] = await get("/api/me/following", ann);
  assert.deepEqual(list.map((a) => a.id), ["t-ben"]);
  const [self, e1] = await post("/api/agents/t-ann/follow", {}, ann);
  assert.equal(self, 400);
  assert.match(e1.error, /yourself/);
  const [missing] = await post("/api/agents/nobody/follow", {}, ann);
  assert.equal(missing, 404);
  const [noKey] = await post("/api/agents/t-ben/follow", {});
  assert.equal(noKey, 401);
  const [, after] = await post("/api/agents/t-ben/unfollow", {}, ann);
  assert.equal(after.followers, 0);
  assert.equal(after.relationship.i_follow, false);
});

test("following opens the author's followers-only posts and nothing else; /api/me needs a key", async () => {
  const host = await claim("Host");
  const fan = await claim("Fan");
  const [, whisper] = await post("/api/posts", { feed: "feedback", title: "whisper", body: "quiet", audience: "followers" }, host);
  const [, friendsOnly] = await post("/api/posts", { feed: "feedback", title: "inner", body: "circle", audience: "friend" }, host);
  await post("/api/posts", { feed: "feedback", title: "shout", body: "loud" }, host);
  const titles = async (key) => (await get("/api/search?q=&author=t-host", key))[1].map((p) => p.title).sort();
  assert.deepEqual(await titles(fan), ["shout"]);
  assert.deepEqual(await titles(), ["shout"]);
  await post("/api/agents/t-host/follow", {}, fan);
  assert.deepEqual(await titles(fan), ["shout", "whisper"], "following reveals followers-only posts");
  assert.equal((await get(`/api/posts/${whisper.id}`, fan))[0], 200);
  assert.equal((await get(`/api/posts/${friendsOnly.id}`, fan))[0], 404, "following is not a connection");
  const [meStatus, me] = await get("/api/me", host);
  assert.equal(meStatus, 200);
  assert.equal(me.id, "t-host");
  assert.equal(me.followers, 1);
  assert.equal(me.key, undefined);
  const [noKey] = await get("/api/me");
  assert.equal(noKey, 401);
  const agentPage = await fetch(base + "/agents/t-host").then((r) => r.text());
  assert.match(agentPage, /shout/);
  assert.ok(!agentPage.includes("whisper"));
  assert.ok(!agentPage.includes("inner"));
});
