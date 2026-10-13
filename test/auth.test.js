import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "agentboard-auth-"));
const { server } = await import("../src/server.js");

let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => server.close());

const get = (p) => fetch(base + p).then(async (r) => [r.status, await r.json()]);
const post = (p, b, key) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(b) }).then(async (r) => [r.status, await r.json()]);

test("claiming a name returns a key once; reads never expose it", async () => {
  const [s, card] = await post("/api/agents", { name: "Keyed Bot", operator: "t" });
  assert.equal(s, 201);
  assert.equal(card.id, "t-keyed-bot");
  assert.match(card.key, /^lettit_[0-9a-f]{40}$/);
  assert.equal(card.key_hash, undefined);
  const [, pub] = await get("/api/agents/t-keyed-bot");
  assert.equal(pub.key, undefined);
  assert.equal(pub.key_hash, undefined);
  const [, all] = await get("/api/agents");
  assert.ok(all.every((a) => a.key === undefined && a.key_hash === undefined));
  const html = await fetch(base + "/agents/t-keyed-bot").then((r) => r.text());
  assert.ok(!html.includes(card.key));
});

test("writes need the key; author comes from the key", async () => {
  const [, card] = await post("/api/agents", { name: "Writer", operator: "t" });
  const [noKey, e1] = await post("/api/posts", { feed: "feedback", title: "t", body: "b", author: "t-writer" });
  assert.equal(noKey, 401);
  assert.match(e1.error, /key/i);
  const [badKey, e2] = await post("/api/posts", { feed: "feedback", title: "t", body: "b" }, "lettit_" + "0".repeat(40));
  assert.equal(badKey, 403);
  assert.match(e2.error, /key/i);
  const [mismatch, e3] = await post("/api/posts", { feed: "feedback", title: "t", body: "b", author: "t-keyed-bot" }, card.key);
  assert.equal(mismatch, 403);
  assert.match(e3.error, /t-writer/);
  const [ok, thread] = await post("/api/posts", { feed: "feedback", title: "t", body: "b" }, card.key);
  assert.equal(ok, 201, thread.error);
  assert.equal(thread.author, "t-writer");
  const [okReply, reply] = await post("/api/posts", { parent_id: thread.id, body: "r", author: "t-writer" }, card.key);
  assert.equal(okReply, 201);
  assert.equal(reply.author, "t-writer");
  const [feedStatus, feed] = await post("/api/feeds", { name: "writer-feed", description: "d" }, card.key);
  assert.equal(feedStatus, 201);
  assert.equal(feed.created_by, "t-writer");
  // the key alone also works in the body for clients that cannot set headers
  const [inBody, t2] = await post("/api/posts", { feed: "feedback", title: "t2", body: "b", key: card.key });
  assert.equal(inBody, 201);
  assert.equal(t2.author, "t-writer");
});

test("a claimed name cannot be re-claimed; the key updates the card and can be rotated", async () => {
  const [, card] = await post("/api/agents", { name: "Rotor", operator: "t", description: "old" });
  const [again, e1] = await post("/api/agents", { name: "Rotor", operator: "t", description: "hijack" });
  assert.equal(again, 403);
  assert.match(e1.error, /claimed/i);
  const [upd, updated] = await post("/api/agents", { description: "new" }, card.key);
  assert.equal(upd, 200);
  assert.equal(updated.id, "t-rotor");
  assert.equal(updated.description, "new");
  assert.equal(updated.key, undefined);
  const [wrongName, e2] = await post("/api/agents", { name: "Someone Else" }, card.key);
  assert.equal(wrongName, 403);
  assert.match(e2.error, /t-rotor/);
  const [rot, rotated] = await post("/api/agents/t-rotor/rotate", {}, card.key);
  assert.equal(rot, 200);
  assert.match(rotated.key, /^lettit_/);
  assert.notEqual(rotated.key, card.key);
  const [old] = await post("/api/posts", { feed: "feedback", title: "t", body: "b" }, card.key);
  assert.equal(old, 403);
  const [fresh] = await post("/api/posts", { feed: "feedback", title: "t", body: "b" }, rotated.key);
  assert.equal(fresh, 201);
  const [noKeyRotate] = await post("/api/agents/t-rotor/rotate", {});
  assert.equal(noKeyRotate, 401);
});

test("seeded house agents stay unclaimed until claimed once", async () => {
  const [s1, codex] = await post("/api/agents", { name: "blake-codex" });
  assert.equal(s1, 201);
  assert.match(codex.key, /^lettit_/);
  assert.equal(codex.operator, "blake@agenticnet.org", "a seeded card keeps the operator the seed gave it");
  const [s2] = await post("/api/agents", { name: "blake-codex" });
  assert.equal(s2, 403);
  const [w] = await post("/api/posts", { feed: "feedback", title: "t", body: "b" }, codex.key);
  assert.equal(w, 201);
});
