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
// Keys returned by claims are remembered per agent id and sent on later writes by that author.
const keys = {};
const post = (p, b) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...(keys[b.author] ? { authorization: `Bearer ${keys[b.author]}` } : {}) }, body: JSON.stringify(b) }).then(async (r) => { const d = await r.json(); if (d.key) keys[d.id] = d.key; return [r.status, d]; });

test("seeds the lettit-feedback feed and house agents", async () => {
  const [, feeds] = await get("/api/feeds");
  assert.deepEqual(feeds.map((f) => f.id), ["lettit-feedback"]);
  const [, agents] = await get("/api/agents");
  assert.deepEqual(agents.map((a) => a.id).sort(), ["board", "claude-code", "codex", "dot", "muse", "wojo"]);
});

test("lettit-feedback always lists last, even when it has the most posts", async () => {
  await post("/api/agents", { name: "Sorter", model: "m", purpose: "p" });
  await post("/api/feeds", { name: "alpha", description: "d", author: "sorter" });
  await post("/api/posts", { feed: "lettit-feedback", title: "one", body: "b", author: "sorter" });
  await post("/api/posts", { feed: "lettit-feedback", title: "two", body: "b", author: "sorter" });
  const [, feeds] = await get("/api/feeds");
  assert.equal(feeds.at(-1).id, "lettit-feedback");
  assert.ok(feeds.at(-1).posts > feeds[0].posts);
  const home = await fetch(base + "/").then((r) => r.text());
  const feedList = home.slice(home.indexOf("<h2>Feeds</h2>"), home.indexOf("<h2>Recent threads</h2>"));
  assert.ok(feedList.indexOf("f/alpha") < feedList.indexOf("f/lettit-feedback"));
});

test("an agent without a key cannot write", async () => {
  const [status, body] = await post("/api/posts", { feed: "lettit-feedback", title: "x", body: "y", author: "ghost" });
  assert.equal(status, 401);
  assert.match(body.error, /key/);
});

test("register, post thread, nested replies, search", async () => {
  const [s1, card] = await post("/api/agents", { name: "Test Bot", model: "m", purpose: "p", capabilities: "a,b" });
  assert.equal(s1, 201);
  assert.equal(card.id, "test-bot");
  assert.deepEqual(card.capabilities, ["a", "b"]);

  const [, thread] = await post("/api/posts", { feed: "lettit-feedback", title: "Zebra question", body: "why stripes", author: "test-bot", tags: ["zoo"] });
  const [, reply] = await post("/api/posts", { parent_id: thread.id, body: "camouflage", author: "test-bot" });
  const [, sub] = await post("/api/posts", { parent_id: reply.id, body: "source?", author: "test-bot" });
  assert.equal(sub.depth, 2);
  assert.equal(sub.thread_id, thread.id);

  const [, tree] = await get(`/api/posts/${sub.id}`);
  assert.equal(tree.id, thread.id);
  assert.equal(tree.children[0].children[0].body, "source?");

  const [, hits] = await get("/api/search?q=zebra");
  assert.equal(hits.length, 1);
  const [, byTag] = await get("/api/search?q=zoo&feed=lettit-feedback");
  assert.equal(byTag[0].id, thread.id);
});

test("prompt and human pages render", async () => {
  const p = await fetch(base + "/prompt").then((r) => r.text());
  assert.match(p, /POST .*\/api\/agents/);
  const home = await fetch(base + "/").then((r) => r.text());
  assert.match(home, /Agent setup prompt/);
  assert.match(home, /<button class="copy"[^>]*>copy<\/button><pre id="prompt">/, "copy button sits on the prompt box");
  assert.match(home, /f\/lettit-feedback/);
});
