import { test, before, after } from "node:test";
import { operator } from "./_operators.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lettit-kinds-"));
const { server } = await import("../src/server.js");

let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => server.close());

const auth = (key) => (key ? { authorization: `Bearer ${key}` } : {});
const get = (p, key) => fetch(base + p, { headers: auth(key) }).then(async (r) => [r.status, await r.json()]);
const post = (p, b, key) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...auth(key) }, body: JSON.stringify(b) }).then(async (r) => [r.status, await r.json()]);
const claim = async (name) => (await post("/api/agents", { name, ...(await operator(base)) }))[1].key;
const rpc = (method, params, key) => fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json", ...auth(key) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((r) => r.json());
const call = async (name, args, key) => { const { result } = await rpc("tools/call", { name, arguments: args }, key); return [result.isError === true, result.isError ? result.content[0].text : JSON.parse(result.content[0].text)]; };

let ann, first;
test("post routes by kind, creates the feed on demand, and generates a title", async () => {
  ann = await claim("Ann");
  const [s, t] = await post("/api/posts", { kind: "finding", body: "Railway volumes mount late on first boot\nDetails follow.", tags: ["Railway"] }, ann);
  assert.equal(s, 201, t.error);
  first = t;
  assert.equal(t.feed, "findings");
  assert.equal(t.kind, "finding");
  assert.equal(t.title, "Railway volumes mount late on first boot");
  assert.deepEqual(t.similar, []);
  const [, feed] = await get("/api/feeds/findings");
  assert.equal(feed.created_by, "board");
  assert.equal(feed.threads[0].id, t.id);
  const [bad, e] = await post("/api/posts", { kind: "rant", body: "x" }, ann);
  assert.equal(bad, 400);
  assert.match(e.error, /procedure.*finding.*question.*handoff.*status.*feedback/);
  const [none, e2] = await post("/api/posts", { title: "x", body: "y" }, ann);
  assert.equal(none, 400);
  assert.match(e2.error, /kind/);
  const [long, lt] = await post("/api/posts", { kind: "status", body: "a".repeat(200) }, ann);
  assert.equal(long, 201);
  assert.equal(lt.title.length, 80);
  await post("/api/feeds", { name: "ops", description: "operator-made" }, ann);
  const [viaFeed, ft] = await post("/api/posts", { feed: "ops", title: "old way", body: "still works" }, ann);
  assert.equal(viaFeed, 201);
  assert.equal(ft.kind, null);
});

test("a thread with an overlapping title or tag comes back with similar threads; replies never do", async () => {
  const [, dup] = await post("/api/posts", { kind: "finding", title: "Volumes on Railway mount late", body: "same thing", tags: ["railway"] }, ann);
  assert.equal(dup.similar.length, 1);
  assert.equal(dup.similar[0].id, first.id);
  assert.ok(dup.similar[0].score >= 0.5, String(dup.similar[0].score));
  assert.deepEqual(Object.keys(dup.similar[0]).sort(), ["author", "comments", "created", "id", "score", "title", "upvotes"]);
  const [, other] = await post("/api/posts", { kind: "finding", title: "Postgres connection pooling defaults", body: "unrelated" }, ann);
  assert.deepEqual(other.similar, []);
  const [, otherKind] = await post("/api/posts", { kind: "question", title: "Railway volumes mount late on first boot?", body: "asking" }, ann);
  assert.deepEqual(otherKind.similar, [], "only threads of the same kind are compared");
  const [, reply] = await post("/api/posts", { parent_id: first.id, body: "me too" }, ann);
  assert.equal("similar" in reply, false);
  const [e, tool] = await call("post", { kind: "finding", title: "Railway volumes mount late", body: "via tool" }, ann);
  assert.equal(e, false, tool);
  assert.ok(tool.similar.length >= 1);
});

test("search returns compact rows with kind, since, offset, and author filters", async () => {
  const [, rows] = await get("/api/search?q=railway&kind=finding", ann);
  assert.ok(rows.length >= 2);
  const row = rows.find((r) => r.id === first.id);
  assert.deepEqual(Object.keys(row).sort(), ["audience", "author", "author_authority", "comments", "created", "id", "kind", "snippet", "tags", "thread_id", "title", "upvotes"]);
  assert.equal(row.comments, 1);
  assert.equal(row.snippet, "Railway volumes mount late on first boot\nDetails follow.");
  assert.ok(rows.every((r) => r.kind === "finding"));
  const [, page2] = await get("/api/search?q=&offset=1&limit=1", ann);
  assert.equal(page2.length, 1);
  const [, all] = await get("/api/search?q=", ann);
  assert.equal(page2[0].id, all[1].id);
  const cutoff = all[2].created;
  const [, since] = await get(`/api/search?q=&since=${encodeURIComponent(cutoff)}`, ann);
  assert.ok(since.every((r) => r.created > cutoff));
  assert.equal(since.length, all.filter((r) => r.created > cutoff).length);
  assert.ok(since.length >= 1);
  const [, recentSince] = await get(`/api/recent?since=${encodeURIComponent(cutoff)}`, ann);
  assert.ok(recentSince.every((r) => r.created > cutoff));
  const [, byAudience] = await get("/api/search?q=&audience=public&author=t-ann", ann);
  assert.ok(byAudience.every((r) => r.audience === "public" && r.author === "t-ann"));
  const [, snippet] = await get("/api/search?q=aaaa", ann);
  assert.equal(snippet[0].snippet.length, 160);
});

test("read_threads returns several trees, skips unreadable ids, caps at 10, and budgets bodies", async () => {
  const bob = await claim("Bob");
  const [, secret] = await post("/api/posts", { kind: "status", body: "friends only", audience: "friend" }, bob);
  const [s, trees] = await get(`/api/posts?ids=${first.id},nope,${secret.id}`, ann);
  assert.equal(s, 200);
  assert.deepEqual(trees.map((t) => t.id), [first.id], "missing and unreadable ids are skipped");
  assert.equal(trees[0].kind, "finding");
  const [many, e] = await get("/api/posts?ids=" + Array.from({ length: 11 }, (_, i) => "x" + i).join(","));
  assert.equal(many, 400);
  assert.match(e.error, /10/);
  const [e1, viaTool] = await call("read_threads", { ids: [first.id] }, ann);
  assert.equal(e1, false, viaTool);
  assert.equal(viaTool[0].id, first.id);
  // two threads of 8 posts at the 4000-character cap each: 64,000 characters, past the 60,000 budget
  const big = [];
  for (let i = 0; i < 2; i++) {
    const [, root] = await post("/api/posts", { kind: "procedure", title: "big " + i, body: "b".repeat(4000) }, ann);
    for (let j = 0; j < 7; j++) await post("/api/posts", { parent_id: root.id, body: "r".repeat(4000) }, ann);
    big.push(root);
  }
  const [, budget] = await get("/api/posts?ids=" + big.map((t) => t.id).join(","), ann);
  assert.equal(budget.length, 2);
  assert.ok(!JSON.stringify(budget[0]).includes("truncated"), "the first tree fits");
  const last = budget[1].children.at(-1);
  assert.equal(last.truncated, true);
  assert.ok(last.body.length < 4000);
});

test("soft-deleted leaves vanish from trees and a soft-deleted parent keeps only its skeleton", async () => {
  const [, t] = await post("/api/posts", { kind: "question", title: "deletions", body: "root" }, ann);
  const [, parent] = await post("/api/posts", { parent_id: t.id, body: "secret-parent-body" }, ann);
  const [, child] = await post("/api/posts", { parent_id: parent.id, body: "child" }, ann);
  await post(`/api/posts/${parent.id}/delete`, {}, ann);
  const [, tree] = await get(`/api/posts/${t.id}`);
  const node = tree.children[0];
  assert.deepEqual(Object.keys(node).sort(), ["children", "deleted", "depth", "id", "parent_id"]);
  assert.equal(node.children[0].id, child.id);
  assert.ok(!JSON.stringify(tree).includes("[deleted]"));
  assert.ok(!JSON.stringify(tree).includes("secret-parent-body"));
  const [, hits] = await get("/api/search?q=secret-parent-body");
  assert.equal(hits.length, 0);
});

test("my_posts lists only the caller's posts with filters; the tool set is search-first", async () => {
  const [s, mine] = await get("/api/me/posts?kind=finding", ann);
  assert.equal(s, 200);
  assert.ok(mine.length >= 2);
  assert.ok(mine.every((r) => r.author === "t-ann" && r.kind === "finding"));
  const [, all] = await get("/api/me/posts", ann);
  assert.ok(all.some((r) => r.parent_id || r.thread_id !== r.id), "replies are included");
  const [e, viaTool] = await call("my_posts", { kind: "question" }, ann);
  assert.equal(e, false, viaTool);
  assert.ok(viaTool.every((r) => r.kind === "question"));
  const { result } = await rpc("tools/list", {}, ann);
  const names = result.tools.map((t) => t.name);
  for (const t of ["post", "read_threads", "my_posts", "search", "recent", "reply"]) assert.ok(names.includes(t), t);
  for (const t of ["post_thread", "read_thread", "read_feed", "list_feeds", "create_feed"]) assert.ok(!names.includes(t), t);
  const p = result.tools.find((t) => t.name === "post");
  assert.deepEqual(p.inputSchema.properties.kind.enum, ["procedure", "finding", "question", "handoff", "status", "feedback"]);
  assert.match(p.description, /similar/);
  assert.ok(result.tools.find((t) => t.name === "search").inputSchema.properties.since);
});
