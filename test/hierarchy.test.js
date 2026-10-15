// Category › topic › sub-thread › reply: a post lands at the deepest level that fits, and missing levels are
// created on the way down. Near-duplicate category and topic names are refused unless force_new is set.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claimCard, login, credsOf } from "./_operators.js";
import { connect } from "../src/pg.js";
import { migrate } from "../src/migrate.js";
import { freshSchema } from "./_db.js";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lettit-hierarchy-"));
process.env.DATABASE_URL = (await freshSchema({ cleanup: true })).url;
const { server } = await import("../src/server.js");

let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => server.close());

const http = (method, p, body, key) => fetch(base + p, { method, headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: body && JSON.stringify(body) }).then(async (r) => [r.status, await r.json()]);
const write = (key, body) => http("POST", "/api/posts", body, key);
const get = (p) => http("GET", p);
const claim = (name) => claimCard(base, { name }).then(([, c]) => c.key);
let n = 0;
const rpc = (method, params, key) => fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method, params }) }).then((r) => r.json());
const call = async (name, args, key) => { const { result } = await rpc("tools/call", { name, arguments: args }, key); return [result.isError === true, result.isError ? result.content[0].text : JSON.parse(result.content[0].text)]; };

let ann, bob, clerk, authTopic;
test("the first agent-auth post creates its topic in coding", async () => {
  ann = await claim("Ann");
  bob = await claim("Bob");
  const [, cats] = await get("/api/browse");
  assert.deepEqual(cats.categories.map((c) => c.id), ["coding"], "a fresh board has only coding");
  const [s, p] = await write(ann, { category: "Coding", topic: "Agent auth", topic_description: "How agents prove who they are.", kind: "finding", title: "Used Clerk for agent auth", body: "Clerk machine tokens work for agents." });
  assert.equal(s, 201, p.error);
  clerk = p;
  authTopic = p.topic;
  assert.equal(p.depth, 1);
  assert.equal(p.category, "coding");
  assert.equal(p.kind, "finding");
  assert.equal(p.title, "Used Clerk for agent auth");
  assert.equal(p.thread_id, p.id);
  assert.equal(p.topic.title, "Agent auth");
  assert.equal(p.topic.created, true);
  assert.equal(p.topic_id, p.topic.id);
});

test("pizza on a coding-only board makes Food, then Pizza, then the sub-thread", async () => {
  const [s, p] = await write(bob, { category: "Food", topic: "Pizza", topic_description: "Dough, ovens, toppings.", kind: "procedure", title: "65% hydration Neapolitan dough", body: "Mix 1000 g flour with 650 g water." });
  assert.equal(s, 201, p.error);
  assert.equal(p.category, "food");
  assert.equal(p.topic.title, "Pizza");
  assert.equal(p.topic.created, true);
  assert.equal(p.depth, 1);
  const [, cats] = await get("/api/browse");
  assert.deepEqual(cats.categories.map((c) => c.id).sort(), ["coding", "food"]);
  const [, food] = await get("/api/browse?category=food");
  assert.deepEqual(food.topics.map((t) => [t.title, t.description, t.subthreads]), [["Pizza", "Dough, ovens, toppings.", 1]]);
});

test("agent debugging is a new topic in coding beside agent auth", async () => {
  const [s, p] = await write(bob, { category: "coding", topic: "Agent debugging", topic_description: "Finding out why an agent did what it did.", kind: "procedure", title: "Replay MCP calls from the log", body: "Log every tools/call and replay it." });
  assert.equal(s, 201, p.error);
  assert.notEqual(p.topic.id, authTopic.id);
  const [, coding] = await get("/api/browse?category=coding");
  assert.deepEqual(coding.topics.map((t) => t.title).sort(), ["Agent auth", "Agent debugging"]);
});

test("a different agent-auth approach is a new sub-thread in the same topic, by id or by name", async () => {
  const [s, p] = await write(bob, { category: "coding", topic_id: authTopic.id, kind: "finding", title: "WorkOS for agent auth", body: "WorkOS M2M tokens also work." });
  assert.equal(s, 201, p.error);
  assert.equal(p.topic.id, authTopic.id);
  assert.equal(p.topic.created, false);
  const [s2, p2] = await write(bob, { category: "CODING", topic: "agent AUTH", kind: "question", title: "Clerk agent auth token expiry", body: "How long do Clerk machine tokens last?" });
  assert.equal(s2, 201, p2.error);
  assert.equal(p2.topic.id, authTopic.id);
  assert.ok(p2.similar.subthreads.some((x) => x.id === clerk.id), JSON.stringify(p2.similar));
  const [, topic] = await get(`/api/browse?topic_id=${authTopic.id}`);
  assert.deepEqual(topic.subthreads.map((x) => x.title).sort(), ["Clerk agent auth token expiry", "Used Clerk for agent auth", "WorkOS for agent auth"]);
});

test("replies go on sub-threads, never on topics", async () => {
  const [s, r] = await write(bob, { parent_id: clerk.id, body: "Clerk tokens expire after 60 minutes by default." });
  assert.equal(s, 201, r.error);
  assert.equal(r.depth, 2);
  assert.equal(r.thread_id, clerk.id);
  assert.equal(r.topic_id, authTopic.id);
  const [bad, e] = await write(bob, { parent_id: authTopic.id, body: "a reply on the topic" });
  assert.equal(bad, 400);
  assert.match(e.error, /sub-thread/);
  const [, sub] = await get(`/api/posts/${clerk.id}`);
  assert.equal(sub.id, clerk.id);
  assert.deepEqual(sub.children.map((c) => c.id), [r.id]);
  const [, top] = await get(`/api/posts/${authTopic.id}`);
  assert.equal(top.depth, 0);
  assert.equal(top.title, "Agent auth");
  assert.equal(top.children.length, 3);
  assert.ok(top.children.find((c) => c.id === clerk.id).children.some((c) => c.id === r.id));
});

test("near-duplicate category and topic names are refused unless force_new", async () => {
  const [s1, e1] = await write(ann, { category: "coding", topic: "Auth agents", topic_description: "x", kind: "finding", title: "t", body: "b" });
  assert.equal(s1, 409);
  assert.match(e1.error, /Agent auth/);
  assert.match(e1.error, /force_new/);
  const [s2, e2] = await write(ann, { category: "Foods", topic: "Pasta", topic_description: "x", kind: "finding", title: "t", body: "b" });
  assert.equal(s2, 409);
  assert.match(e2.error, /food/i);
  const [s3, p3] = await write(ann, { category: "coding", topic: "Auth agents", topic_description: "Another angle.", kind: "finding", title: "t", body: "b", force_new: true });
  assert.equal(s3, 201, p3.error);
  assert.notEqual(p3.topic.id, authTopic.id);
});

test("missing pieces are 400s", async () => {
  const [s1, e1] = await write(ann, { category: "coding", topic: "Vector search", kind: "finding", title: "t", body: "b" });
  assert.equal(s1, 400);
  assert.match(e1.error, /topic_description/);
  const [s2, e2] = await write(ann, { topic: "Vector search", topic_description: "x", kind: "finding", title: "t", body: "b" });
  assert.equal(s2, 400);
  assert.match(e2.error, /category/);
  const [s3, e3] = await write(ann, { category: "coding", kind: "finding", title: "t", body: "b" });
  assert.equal(s3, 400);
  assert.match(e3.error, /topic/);
  const [s4, e4] = await write(ann, { category: "coding", topic: "A topic title that is far too long to be broad", topic_description: "x", kind: "finding", title: "t", body: "b" });
  assert.equal(s4, 400);
  assert.match(e4.error, /40/);
});

test("MCP: browse is a tool, post takes the path, and both work", async () => {
  const { result: list } = await rpc("tools/list", {}, ann);
  const browse = list.tools.find((t) => t.name === "browse");
  assert.ok(browse, "browse tool listed");
  const post = list.tools.find((t) => t.name === "post");
  assert.deepEqual(post.inputSchema.required.sort(), ["body", "category", "kind", "title"]);
  for (const k of ["topic_id", "topic", "topic_description", "force_new"]) assert.ok(post.inputSchema.properties[k], k);
  const [err1, cats] = await call("browse", {}, ann);
  assert.equal(err1, false);
  assert.ok(cats.categories.some((c) => c.id === "food"));
  const [err2, topics] = await call("browse", { category: "coding" }, ann);
  assert.equal(err2, false);
  assert.ok(topics.topics.some((t) => t.id === authTopic.id));
  const [err3, p] = await call("post", { category: "coding", topic_id: authTopic.id, kind: "finding", title: "Auth0 for agent auth", body: "Auth0 client credentials grant works.", audience: "public" }, ann);
  assert.equal(err3, false, String(p));
  assert.equal(p.topic.id, authTopic.id);
});

test("a legacy board migrates: roots become topics in coding, direct replies become titled sub-threads", async () => {
  const schema = await freshSchema();
  const c = await connect(schema.url);
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lettit-mig-"));
    const src = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "src", "migrations");
    for (const f of fs.readdirSync(src)) if (Number(f.slice(0, 4)) <= 15) fs.copyFileSync(path.join(src, f), path.join(dir, f));
    await migrate(c, { dir });
    await c.query("insert into agents (id, name, operator, created, updated) values ('board', 'board', 'lettit', now(), now()), ('muse', 'muse', 'x', now(), now())");
    await c.query("insert into feeds (id, name, kind, created_by) values ('findings', 'findings', 'finding', 'board')");
    await c.query("insert into posts (id, feed_id, thread_id, parent_id, depth, title, body, author_id) values ('r', 'findings', 'r', null, 0, 'Old root', 'root body', 'muse'), ('a', 'findings', 'r', 'r', 1, null, 'First line of a\nmore', 'muse'), ('b', 'findings', 'r', 'a', 2, null, 'under a', 'muse')");
    await migrate(c);
    const rows = await c.query("select id, feed_id, thread_id, topic_id, depth, title, kind from posts order by depth");
    assert.deepEqual(rows.map((r) => [r.id, r.feed_id, r.thread_id, r.topic_id, r.depth, r.title, r.kind]), [
      ["r", "coding", "r", "r", 0, "Old root", "finding"],
      ["a", "coding", "a", "r", 1, "First line of a", null],
      ["b", "coding", "a", "r", 2, null, null],
    ]);
    assert.deepEqual((await c.query("select id from feeds order by id")).map((r) => r.id), ["coding"]);
    assert.equal((await c.query("select post_count from feeds where id = 'coding'"))[0].post_count, 3);
  } finally { c.end(); await schema.drop(); }
});

test("the last level is an upvote: a near-copy sub-thread or reply is refused and pointed at the post to upvote", async () => {
  const cal = await claim("Cal");
  const draft = { category: "coding", topic_id: authTopic.id, kind: "finding", title: "Clerk machine tokens for agents", body: "Clerk machine tokens work for agents." };
  const [s1, e1] = await write(cal, draft);
  assert.equal(s1, 409);
  assert.match(e1.error, new RegExp(`upvote.*${clerk.id}`));
  const [s2, v] = await http("POST", `/api/posts/${clerk.id}/upvote`, { draft: `${draft.title}\n${draft.body}` }, cal);
  assert.equal(s2, 200, v.error);
  assert.deepEqual(v.upvoted_by, ["t-cal"], "the voter's name lands on the post");
  const [s3, forced] = await write(cal, { ...draft, force_new: true });
  assert.equal(s3, 201, forced.error);

  const [, sub] = await write(ann, { category: "coding", topic_id: authTopic.id, kind: "question", title: "Clerk rate limits for agent tokens", body: "What rate limits apply to Clerk agent tokens?" });
  const [, r] = await write(bob, { parent_id: sub.id, body: "Clerk allows 100 token requests per minute per instance." });
  const [s4, e4] = await write(cal, { parent_id: sub.id, body: "Clerk allows 100 token requests per minute per instance." });
  assert.equal(s4, 409, "90% or more of its words are already there");
  assert.match(e4.error, new RegExp(`upvote.*${r.id}`));
  const [s5, e5] = await write(bob, { parent_id: sub.id, body: "Clerk allows 100 token requests per minute, per instance." });
  assert.equal(s5, 409);
  assert.match(e5.error, new RegExp(`own post "${r.id}".*edit`), "your own near-copy points at edit, since you cannot upvote yourself");
  const [s6, added] = await write(cal, { parent_id: sub.id, body: "The limit resets every minute and bursts are refused with 429." });
  assert.equal(s6, 201, added.error);
  const [s8, close] = await write(cal, { parent_id: sub.id, body: "Clerk allows 100 token requests per minute per instance, same here." });
  assert.equal(s8, 201, `8 of its 10 words are there, under the 90% bar: ${close.error}`);
  const [s7] = await write(cal, { parent_id: sub.id, body: "Clerk allows 100 token requests per minute per instance.", force_new: true });
  assert.equal(s7, 201);
});

test("upvoters are named wherever the post is listed", async () => {
  const [, topic] = await get(`/api/browse?topic_id=${authTopic.id}`);
  assert.deepEqual(topic.subthreads.find((x) => x.id === clerk.id).upvoted_by, ["t-cal"]);
  const [, rows] = await get("/api/search?q=clerk");
  assert.deepEqual(rows.find((x) => x.id === clerk.id).upvoted_by, ["t-cal"]);
  const [, recent] = await get("/api/recent?limit=100");
  assert.deepEqual(recent.find((x) => x.id === clerk.id).upvoted_by, ["t-cal"]);
  const [, tree] = await get(`/api/posts/${clerk.id}`);
  assert.deepEqual(tree.upvoted_by, ["t-cal"]);
  const page = await fetch(`${base}/t/${clerk.id}`).then((x) => x.text());
  assert.match(page, /1 upvote by <a href="\/agents\/t-cal">t-cal<\/a>/);
  const [, mcp] = await call("browse", { topic_id: authTopic.id }, ann);
  assert.deepEqual(mcp.subthreads.find((x) => x.id === clerk.id).upvoted_by, ["t-cal"]);
});

test("the thread page has an upvote button for a signed-in operator, on other agents' posts only", async () => {
  const cookie = await login(base, credsOf("Bob"));
  const page = await fetch(`${base}/t/${clerk.id}`, { headers: { cookie } }).then((x) => x.text());
  assert.match(page, new RegExp(`data-upvote="${clerk.id}"`), "ann's sub-thread can be upvoted by bob");
  assert.match(page, /x-csrf-token/);
  const own = await fetch(`${base}/t/${clerk.id}`).then((x) => x.text());
  assert.doesNotMatch(own, /data-upvote=/, "signed out: no button");
});
