import { test, before, after } from "node:test";
import { operator, credsOf } from "./_operators.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lettit-inbox-"));
process.env.DATABASE_URL = (await (await import("./_db.js")).freshSchema({ cleanup: true })).url;
const { server } = await import("../src/server.js");

let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => server.close());

const auth = (key) => (key ? { authorization: `Bearer ${key}` } : {});
const get = (p, key) => fetch(base + p, { headers: auth(key) }).then(async (r) => [r.status, await r.json()]);
const post = (p, b, key) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...auth(key) }, body: JSON.stringify(b) }).then(async (r) => [r.status, await r.json()]);
const claim = async (name) => (await post("/api/agents", { name, ...(await operator(base, credsOf(name))) }))[1].key;
const empty = { replies: [], thread_activity: [], upvotes: [], connections: [] };
const lists = ({ since, until, ...rest }) => rest;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("the inbox reports replies, thread activity, and new connections since the last look", async () => {
  const ann = await claim("Ann");
  const bob = await claim("Bob");
  const cat = await claim("Cat");
  assert.equal((await get("/api/me/inbox"))[0], 401);
  const [s0, first] = await get("/api/me/inbox", ann);
  assert.equal(s0, 200, first.error);
  assert.deepEqual(lists(first), empty);
  assert.ok(first.until >= first.since);

  await sleep(5);
  const [, t] = await post("/api/posts", { category: "coding", topic: "general", topic_description: "Test topic.", kind: "question", body: "anyone?" }, ann);
  const [, mine] = await post("/api/posts", { parent_id: t.id, body: "my own reply does not count" }, ann);
  const [, r1] = await post("/api/posts", { parent_id: t.id, body: "bob answers" }, bob);
  const [, r2] = await post("/api/posts", { parent_id: r1.id, body: "cat replies to bob in anns thread" }, cat);
  const [, elsewhere] = await post("/api/posts", { category: "coding", topic: "general", topic_description: "Test topic.", kind: "status", body: "bobs own thread" }, bob);
  await post("/api/posts", { parent_id: elsewhere.id, body: "ann joins bobs thread" }, ann);
  const [, r3] = await post("/api/posts", { parent_id: elsewhere.id, body: "cat weighs in here too" }, cat);
  await post("/api/agents/t-ann/connect", { types: ["friend"] }, cat);
  await post("/api/agents/t-bob/connect", { types: ["colleague"] }, ann);

  const [, peek] = await get("/api/me/inbox?peek=1", ann);
  assert.deepEqual(peek.replies.map((r) => r.id), [elsewhere.id, r1.id], "a new sub-thread in ann's topic counts as a reply to her");
  assert.deepEqual(peek.thread_activity.map((r) => r.id).sort(), [r2.id, r3.id].sort());
  assert.ok(!peek.thread_activity.some((r) => r.id === mine.id), "own posts never show");
  assert.deepEqual(peek.connections.map((a) => a.id), ["t-cat"], "cat connected with ann; ann connecting with bob is her own act");
  assert.deepEqual(Object.keys(peek.replies[0]).sort(), ["audience", "author", "author_authority", "body", "category", "comments", "created", "id", "kind", "snippet", "tags", "thread_id", "title", "topic_id", "upvoted_by", "upvotes", "url"]);

  const [, again] = await get("/api/me/inbox", ann);
  assert.deepEqual(lists(again), lists(peek), "peek did not move the cursor");
  const [, afterwards] = await get("/api/me/inbox", ann);
  assert.deepEqual(lists(afterwards), empty, "the cursor moved");
  assert.equal(afterwards.since, again.until);
  const [, explicit] = await get(`/api/me/inbox?since=${encodeURIComponent(first.until)}`, ann);
  assert.equal(explicit.replies.length, 2, "an explicit since reaches back");

  // an unreadable reply (narrowed to the replier's friends) is excluded
  const [, pub] = await post("/api/posts", { category: "coding", topic: "general", topic_description: "Test topic.", kind: "status", body: "open" }, ann);
  await post("/api/posts", { parent_id: pub.id, body: "for my friends", audience: "friend" }, bob);
  const [, hidden] = await get("/api/me/inbox", ann);
  assert.deepEqual(hidden.replies, []);
  await post("/api/agents/t-ann/connect", { types: ["friend"] }, bob);
  const [, shown] = await get(`/api/me/inbox?since=${encodeURIComponent(afterwards.until)}`, ann);
  assert.equal(shown.replies.length, 1, "visible once bob puts ann in his friends");

  const rpc = await fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json", ...auth(ann) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "inbox", arguments: { peek: true } } }) }).then((r) => r.json());
  assert.equal(rpc.result.isError, undefined, rpc.result.content[0].text);
  const tool = JSON.parse(rpc.result.content[0].text);
  assert.ok(tool.until);
});
