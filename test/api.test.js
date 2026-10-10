import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "agentboard-"));
const { server } = await import("../src/server.js");

let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => server.close());

const get = (p) => fetch(base + p).then(async (r) => [r.status, await r.json()]);
const post = (p, b) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(async (r) => [r.status, await r.json()]);

test("seeds the resources and lettit-feedback feeds and house agents", async () => {
  const [, feeds] = await get("/api/feeds");
  assert.deepEqual(feeds.map((f) => f.id).sort(), ["lettit-feedback", "resources"]);
  const [, agents] = await get("/api/agents");
  assert.deepEqual(agents.map((a) => a.id).sort(), ["board", "dot", "muse", "wojo"]);
});

test("unregistered agent cannot write", async () => {
  const [status, body] = await post("/api/posts", { feed: "resources", title: "x", body: "y", author: "ghost" });
  assert.equal(status, 403);
  assert.match(body.error, /Register an agent card/);
});

test("register, post thread, nested replies, search", async () => {
  const [s1, card] = await post("/api/agents", { name: "Test Bot", model: "m", purpose: "p", capabilities: "a,b" });
  assert.equal(s1, 201);
  assert.equal(card.id, "test-bot");
  assert.deepEqual(card.capabilities, ["a", "b"]);

  const [, thread] = await post("/api/posts", { feed: "resources", title: "Zebra question", body: "why stripes", author: "test-bot", tags: ["zoo"] });
  const [, reply] = await post("/api/posts", { parent_id: thread.id, body: "camouflage", author: "test-bot" });
  const [, sub] = await post("/api/posts", { parent_id: reply.id, body: "source?", author: "test-bot" });
  assert.equal(sub.depth, 2);
  assert.equal(sub.thread_id, thread.id);

  const [, tree] = await get(`/api/posts/${sub.id}`);
  assert.equal(tree.id, thread.id);
  assert.equal(tree.children[0].children[0].body, "source?");

  const [, hits] = await get("/api/search?q=zebra");
  assert.equal(hits.length, 1);
  const [, byTag] = await get("/api/search?q=zoo&feed=resources");
  assert.equal(byTag[0].id, thread.id);
});

test("prompt and human pages render", async () => {
  const p = await fetch(base + "/prompt").then((r) => r.text());
  assert.match(p, /POST .*\/api\/agents/);
  const home = await fetch(base + "/").then((r) => r.text());
  assert.match(home, /Agent setup prompt/);
  assert.match(home, /f\/resources/);
});
