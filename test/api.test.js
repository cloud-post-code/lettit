import { test, before, after } from "node:test";
import { claimCard } from "./_operators.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "agentboard-"));
process.env.DATABASE_URL = (await (await import("./_db.js")).freshSchema({ cleanup: true })).url;
const { server } = await import("../src/server.js");

let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => server.close());

const get = (p) => fetch(base + p).then(async (r) => [r.status, await r.json()]);
// Keys returned by claims are remembered per agent id and sent on later writes by that author.
const keys = {};
const post = (p, b) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...(keys[b.author] ? { authorization: `Bearer ${keys[b.author]}` } : {}) }, body: JSON.stringify(b) }).then(async (r) => { const d = await r.json(); if (d.key) keys[d.id] = d.key; return [r.status, d]; });
const claim = async (card) => { const [s, d] = await claimCard(base, card); if (d.key) keys[d.id] = d.key; return [s, d]; };

test("seeds the kind feeds and house agents", async () => {
  const [, feeds] = await get("/api/feeds");
  assert.deepEqual(feeds.map((f) => f.id).sort(), ["feedback", "findings", "handoffs", "procedures", "questions", "status"]);
  const [, agents] = await get("/api/agents");
  assert.deepEqual(agents.map((a) => a.id).sort(), ["blake", "board"]);
});

test("feedback always lists last, even when it has the most posts", async () => {
  await claim({ name: "Sorter" });
  await post("/api/feeds", { name: "alpha", description: "d", author: "t-sorter" });
  await post("/api/posts", { feed: "feedback", title: "one", body: "b", author: "t-sorter" });
  await post("/api/posts", { feed: "feedback", title: "two", body: "b", author: "t-sorter" });
  const [, feeds] = await get("/api/feeds");
  assert.equal(feeds.at(-1).id, "feedback");
  assert.ok(feeds.at(-1).posts > feeds[0].posts);
  const home = await fetch(base + "/agent").then((r) => r.text());
  const feedList = home.slice(home.indexOf("kinds:"), home.indexOf("<h2>Recent threads</h2>"));
  assert.ok(feedList.indexOf("f/alpha") < feedList.indexOf("f/feedback"));
  assert.ok(feedList.indexOf("f/findings") < feedList.indexOf("f/feedback"));
});

test("an agent without a key cannot write", async () => {
  const [status, body] = await post("/api/posts", { feed: "feedback", title: "x", body: "y", author: "ghost" });
  assert.equal(status, 401);
  assert.match(body.error, /key/);
});

test("register, post thread, nested replies, search", async () => {
  const [s1, card] = await claim({ name: "Test Bot", description: "d" });
  assert.equal(s1, 201);
  assert.equal(card.id, "t-test-bot");
  assert.equal(card.description, "d");

  const [, thread] = await post("/api/posts", { feed: "feedback", title: "Zebra question", body: "why stripes", author: "t-test-bot", tags: ["zoo"] });
  const [, reply] = await post("/api/posts", { parent_id: thread.id, body: "camouflage", author: "t-test-bot" });
  const [, sub] = await post("/api/posts", { parent_id: reply.id, body: "source?", author: "t-test-bot" });
  assert.equal(sub.depth, 2);
  assert.equal(sub.thread_id, thread.id);

  const [, tree] = await get(`/api/posts/${sub.id}`);
  assert.equal(tree.id, thread.id);
  assert.equal(tree.children[0].children[0].body, "source?");

  const [, hits] = await get("/api/search?q=zebra");
  assert.equal(hits.length, 1);
  const [, byTag] = await get("/api/search?q=zoo&feed=feedback");
  assert.equal(byTag[0].id, thread.id);
});

test("prompt and human pages render", async () => {
  const p = await fetch(base + "/prompt").then((r) => r.text());
  assert.match(p, /POST .*\/api\/agents/);
  const landing = await fetch(base + "/").then((r) => r.text());
  assert.match(landing, /id="prompt"/, "the landing page carries the starter prompt");
  assert.match(landing, /href="\/login"/, "and a sign-in button");
  for (const bad of ['href="/agents"', 'href="/api/feeds"', "Recent threads", 'href="/join"']) assert.ok(!landing.includes(bad), `landing has no ${bad}`);
  const home = await fetch(base + "/agent").then((r) => r.text());
  assert.ok(!home.includes('id="prompt"'), "the board page shows no prompt box");
  for (const bad of ['href="/me"', 'href="/login"', 'href="/start"']) assert.ok(!home.includes(bad), `the board page has no ${bad}`);
  assert.match(home, /href="\/agents"/);
  assert.match(home, /href="\/api\/feeds"/);
  assert.match(home, /sort=comments/);
  assert.match(home, /f\/feedback/);
  assert.match(home, /href="\/join"/, "the join QR links to /join");
  assert.equal((await fetch(base + "/start")).status, 404);
});
