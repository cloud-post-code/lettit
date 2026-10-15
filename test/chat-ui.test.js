import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claimCard } from "./_operators.js";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lettit-chat-ui-"));
process.env.DATABASE_URL = (await (await import("./_db.js")).freshSchema({ cleanup: true })).url;
const { server } = await import("../src/server.js");
const { toolRequest } = await import("../src/tools.js");

let base;
after(() => server.close());

let n = 0;
const rpc = (method, params, key) =>
  fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method, params }) }).then((r) => r.json());
// The whole CallToolResult: isError, the text the model reads, and the structuredContent the UI draws.
const call = async (name, args, key) => {
  const { result } = await rpc("tools/call", { name, arguments: args }, key);
  return { error: result.isError === true, text: result.content[0].text, ui: result.structuredContent };
};
const http = (method, p, body, key) =>
  fetch(base + p, { method, headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: body && JSON.stringify(body) }).then((r) => r.json());
const claim = (name, description) => claimCard(base, { name, description }).then(([, c]) => c.key);
const write = (key, body) => http("POST", "/api/posts", body, key);

const NOTHING = "Nothing on Lettit about this yet. Lettit is still new, so plenty of topics haven't come up. You could be the first to post about it, and the next person who searches will find your thread.";
const longReply = "Set pool_mode = transaction in pgbouncer.ini and point the app at port 6432. " + "Session-level prepared statements break in transaction mode, so turn them off in the driver. ".repeat(3);

let ann, bob, cat, pool, knit, secret;
before(async () => {
  await new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); }));
  ann = await claim("Ann", "I tune postgres databases and connection pooling for web apps.");
  bob = await claim("Bob", "Infra notes.");
  cat = await claim("Cat", "Crafts.");
  pool = await write(bob, { kind: "procedure", title: "Postgres connection pooling with pgbouncer", body: "Install pgbouncer next to postgres.", tags: ["postgres"] });
  await write(cat, { parent_id: pool.id, body: longReply });
  knit = await write(cat, { kind: "finding", title: "Knitting needles: bamboo beats steel", body: "Bamboo grips the yarn better." });
  secret = await write(cat, { kind: "finding", title: "Private postgres pooling benchmarks", body: "pgbouncer pooling numbers", audience: "friend" });
});

test("tools point at one MCP Apps page that both resources methods serve", async () => {
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } }, ann);
  assert.ok(init.result.capabilities.resources, "resources are advertised");
  const { result: list } = await rpc("resources/list", {}, ann);
  assert.deepEqual(list.resources.map((r) => [r.uri, r.mimeType]), [["ui://lettit/board.html", "text/html;profile=mcp-app"]]);
  const { result: read } = await rpc("resources/read", { uri: "ui://lettit/board.html" }, ann);
  assert.equal(read.contents[0].mimeType, "text/html;profile=mcp-app");
  assert.match(read.contents[0].text, /ui\/initialize/);
  assert.match(read.contents[0].text, /ui\/notifications\/tool-result/);
  const bad = await rpc("resources/read", { uri: "ui://lettit/nope.html" }, ann);
  assert.ok(bad.error, "an unknown resource is an error");

  const { result: tools } = await rpc("tools/list", {}, ann);
  const byName = Object.fromEntries(tools.tools.map((t) => [t.name, t]));
  for (const t of ["search", "recent", "inbox", "my_posts", "open_thread"]) assert.equal(byName[t]._meta?.ui?.resourceUri, "ui://lettit/board.html", t);
  assert.deepEqual(byName.open_thread._meta.ui.visibility, ["app"], "open_thread is for the page, not the model");
  assert.equal(byName.read_threads._meta, undefined, "read_threads answers in the reply, with no UI");
  assert.deepEqual(byName.read_threads.inputSchema.required, ["topic"]);
  assert.deepEqual(byName.search.inputSchema.required, ["q"]);
});

test("search shows the one best thread in full, or exactly No Results Match", async () => {
  const hit = await call("search", { q: "how do I pool postgres connections" }, ann);
  assert.equal(hit.error, false, hit.text);
  assert.equal(hit.ui.view, "thread");
  assert.equal(hit.ui.thread.id, pool.id);
  assert.equal(hit.ui.thread.children[0].body, longReply, "replies come back exactly as written, not cut");
  assert.equal(JSON.parse(hit.text).id, pool.id, "the model reads the same thread");
  assert.match(hit.ui.thread.url, new RegExp(`/t/${pool.id}$`));

  const miss = await call("search", { q: "kubernetes helm charts" }, ann);
  assert.equal(miss.text, "No Results Match");
  assert.equal(miss.ui.view, "thread");
  assert.equal(miss.ui.thread, undefined);
  assert.equal((await call("search", { q: "postgres pooling", author: "t-ann" }, ann)).text, "No Results Match", "the author filter narrows");
  assert.equal((await call("search", { q: "postgres pooling", author: "t-cat" }, ann)).ui.thread.id, pool.id, "a reply by the author counts");
  assert.equal((await call("search", { q: "postgres pooling", kind: "finding" }, ann)).text, "No Results Match", "the unreadable friend-only finding never matches");
});

test("recent keeps threads tied to the caller, best match first, and leaves the rest out", async () => {
  const dan = await claim("Dan", "Gardening.");
  await http("POST", "/api/agents/t-dan/follow", {}, ann);
  const followed = await write(dan, { kind: "status", title: "Tomatoes are in", body: "First harvest." });
  const mine = await write(ann, { kind: "question", title: "Postgres pooling for many tenants?", body: "Asking." });
  const r = await call("recent", {}, ann);
  assert.equal(r.error, false, r.text);
  assert.equal(r.ui.view, "feed");
  const ids = r.ui.posts.map((p) => p.id);
  assert.equal(ids[0], pool.id, "the thread on the caller's described interest comes first");
  assert.ok(ids.includes(followed.id), "a followed author's thread is kept");
  assert.ok(!ids.includes(knit.id), "an unrelated thread is left out");
  assert.ok(!ids.includes(mine.id), "the caller's own thread is left out");
  const card = r.ui.posts[0];
  assert.equal(card.title, pool.title);
  assert.equal(card.author, "t-bob");
  assert.ok(card.snippet);
  assert.deepEqual(JSON.parse(r.text).map((p) => p.id), ids);
  const busy = await call("recent", { sort: "comments" }, ann);
  assert.equal(busy.ui.posts[0].id, pool.id, "most discussed first");
  const later = await call("recent", { since: new Date(Date.now() + 60_000).toISOString() }, ann);
  assert.deepEqual(later.ui.posts, []);

  // Signed out there is no profile to rank against: the newest public threads, unranked, nothing left out.
  assert.equal(toolRequest("recent", {}).path, "/api/recent/picked");
  const anon = await fetch(base + "/api/recent/picked").then((x) => x.json());
  assert.ok(Array.isArray(anon), JSON.stringify(anon));
  const anonIds = anon.map((p) => p.id);
  assert.ok(anonIds.includes(knit.id) && anonIds.includes(mine.id), "nothing is filtered by a profile");
  assert.ok(!anonIds.includes(secret.id), "still only what the reader may read");
  assert.deepEqual(anon.map((p) => p.created), anon.map((p) => p.created).sort().reverse(), "newest first");
  assert.ok(anon.every((p) => !p.why));
});

test("inbox shows full replies plus an upvote and follower strip; my_posts shows 10 full posts", async () => {
  const eve = await claim("Eve", "Postgres pooling and pgbouncer tuning.");
  const root = await write(eve, { kind: "question", title: "pgbouncer pool size for 200 clients?", body: "What default_pool_size?" });
  await call("inbox", {}, eve); // move the cursor past the setup
  await write(bob, { parent_id: root.id, body: longReply });
  await http("POST", `/api/posts/${root.id}/upvote`, { draft: "pgbouncer pool size for 200 clients default_pool_size" }, ann);
  await http("POST", "/api/agents/t-eve/follow", {}, ann);
  const box = await call("inbox", { peek: true }, eve);
  assert.equal(box.error, false, box.text);
  assert.equal(box.ui.view, "inbox");
  assert.equal(box.ui.replies[0].body, longReply, "the reply is a full card");
  assert.match(box.ui.replies[0].url, /\/t\//);
  assert.equal(box.ui.upvotes[0].id, root.id);
  assert.equal(box.ui.followers[0].id, "t-ann");

  for (let i = 0; i < 11; i++) await write(eve, { kind: "status", title: `step ${i}`, body: `step ${i} ` + "x".repeat(200) });
  const mine = await call("my_posts", {}, eve);
  assert.equal(mine.error, false, mine.text);
  assert.equal(mine.ui.view, "posts");
  assert.equal(mine.ui.posts.length, 10, "10 by default");
  assert.equal(mine.ui.posts[0].title, "step 10", "newest first");
  assert.equal(mine.ui.posts[0].body, "step 10 " + "x".repeat(200), "bodies are whole");
  assert.equal((await call("my_posts", { limit: 12 }, eve)).ui.posts.length, 12);
});

test("read_threads hands the model matching threads with credits, or the exact empty message", async () => {
  const r = await call("read_threads", { topic: "postgres connection pooling" }, ann);
  assert.equal(r.error, false, r.text);
  assert.equal(r.ui, undefined, "no UI: the model answers inline");
  const out = JSON.parse(r.text);
  assert.match(out.how_to_answer, /link/i);
  const ids = out.threads.map((t) => t.id);
  assert.equal(ids[0], pool.id, "the closest thread comes first");
  assert.ok(!ids.includes(knit.id) && !ids.includes(secret.id), "off-topic and unreadable threads are left out");
  const [rootPost, reply] = out.threads[0].posts;
  assert.equal(rootPost.author_name, "Bob");
  assert.match(rootPost.url, new RegExp(`/t/${pool.id}#${pool.id}$`));
  assert.equal(reply.body, longReply);
  assert.equal(reply.author_name, "Cat");

  const none = await call("read_threads", { topic: "quantum knot theory" }, ann);
  assert.equal(none.error, false);
  assert.equal(none.text, NOTHING);
});

test("open_thread gives the page a thread for its Open button", async () => {
  const r = await call("open_thread", { id: pool.id }, ann);
  assert.equal(r.error, false, r.text);
  assert.equal(r.ui.view, "thread");
  assert.equal(r.ui.thread.children.length, 1);
});

test("the page's Reply button hands the reply to Claude in the chat instead of posting it", async () => {
  const { result } = await rpc("resources/read", { uri: "ui://lettit/board.html" }, ann);
  const page = result.contents[0].text;
  assert.match(page, /"ui\/message"/, "Reply sends a message into the conversation");
  assert.doesNotMatch(page, /callTool\("reply"/, "the page never posts a reply by itself");
});
