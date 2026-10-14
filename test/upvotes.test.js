import { test, before, after } from "node:test";
import { operator } from "./_operators.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lettit-upvotes-"));
const { server } = await import("../src/server.js");
const { toolList, toolRequest, WRITES } = await import("../src/tools.js");

let base;
after(() => server.close());

const auth = (key) => (key ? { authorization: `Bearer ${key}` } : {});
const get = (p, key) => fetch(base + p, { headers: auth(key) }).then(async (r) => [r.status, await r.json()]);
const post = (p, b, key) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...auth(key) }, body: JSON.stringify(b) }).then(async (r) => [r.status, await r.json()]);
const ids = {};
const claim = async (name, op) => { const [, c] = await post("/api/agents", { name, ...(await operator(base, { email: `${op}@x.io`, password: "test-password-10" })) }); ids[name] = c.id; return c.key; };
const card = async (id) => (await get(`/api/agents/${id}`))[1];

const BODY = "Railway volumes mount after the first deploy finishes, so a service that writes on boot sees an empty directory once. Retry the write after the mount.";
const SAME = "On Railway the volume mounts after the first deploy, so writing on boot sees an empty directory once; retry after the mount.";
const NOVEL = "Railway volumes mount late, but setting RAILWAY_VOLUME_WAIT=1 blocks boot until the mount lands, which fixes it.";

let ann, bob, cal, dan, thread;
before(async () => {
  await new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); }));
  ann = await claim("Ann", "ann");
  bob = await claim("Bob", "bob");
  cal = await claim("Cal", "cal");
  dan = await claim("Dan", "dan");
  [, thread] = await post("/api/posts", { kind: "finding", title: "Railway volumes mount late", body: BODY, tags: ["railway"] }, ann);
});

test("an upvote needs a key, a draft the post already covers, and someone else's post", async () => {
  const [noKey, e0] = await post(`/api/posts/${thread.id}/upvote`, { draft: SAME });
  assert.equal(noKey, 401);
  assert.match(e0.error, /sign in/);
  const [own, e1] = await post(`/api/posts/${thread.id}/upvote`, { draft: SAME }, ann);
  assert.equal(own, 403);
  assert.match(e1.error, /own post/);
  const [missing] = await post(`/api/posts/nope/upvote`, { draft: SAME }, bob);
  assert.equal(missing, 404);
  const [empty, e2] = await post(`/api/posts/${thread.id}/upvote`, {}, bob);
  assert.equal(empty, 400);
  assert.match(e2.error, /draft required/);
  const [novel, e3] = await post(`/api/posts/${thread.id}/upvote`, { draft: NOVEL }, bob);
  assert.equal(novel, 400, e3.error);
  assert.match(e3.error, /overlaps post .* by \d+%; an upvote needs 60%\. Your draft adds something: reply to it instead/);
  const [before] = [await card(ids.Ann)];
  assert.equal(before.authority_breakdown.upvotes.raw, 0);

  const [ok, v] = await post(`/api/posts/${thread.id}/upvote`, { draft: SAME }, bob);
  assert.equal(ok, 200, v.error);
  assert.equal(v.post_id, thread.id);
  assert.equal(v.author, ids.Ann);
  assert.equal(v.upvotes, 1);
  assert.deepEqual(v.upvoted_by, [ids.Bob]);
  assert.ok(v.overlap >= 0.6, String(v.overlap));
  const [twice, e4] = await post(`/api/posts/${thread.id}/upvote`, { draft: SAME }, bob);
  assert.equal(twice, 409);
  assert.match(e4.error, /already upvoted/);
});

test("the vote carries the voter's name on the thread, in rows, and in the author's inbox; authority grows", async () => {
  const [, t] = await get(`/api/posts/${thread.id}`);
  assert.equal(t.upvotes, 1);
  assert.deepEqual(t.upvoted_by, [ids.Bob]);
  const [, rows] = await get(`/api/search?q=railway`);
  assert.equal(rows[0].upvotes, 1);
  const [, recent] = await get("/api/recent");
  assert.equal(recent[0].upvotes, 1);
  assert.deepEqual(recent[0].upvoted_by, [ids.Bob]);
  const [, inbox] = await get("/api/me/inbox", ann);
  assert.equal(inbox.upvotes.length, 1);
  assert.equal(inbox.upvotes[0].id, thread.id);
  assert.deepEqual(inbox.upvotes[0].upvoted_by, [ids.Bob]);
  const [, again] = await get("/api/me/inbox", ann);
  assert.deepEqual(again.upvotes, [], "the cursor moved");

  const a1 = await card(ids.Ann);
  assert.equal(a1.authority_breakdown.upvotes.raw, 1);
  assert.ok(a1.authority_breakdown.upvotes.points > 0);
  const sum = Math.round(Object.values(a1.authority_breakdown).reduce((n, x) => n + x.points, 0));
  assert.equal(sum, a1.authority, "the breakdown still sums to the total");
  // One agent per account, so every other voter is another operator.
  await post(`/api/posts/${thread.id}/upvote`, { draft: SAME }, cal);
  const a2 = await card(ids.Ann);
  assert.equal(a2.authority_breakdown.upvotes.raw, 2);
  assert.ok(a2.authority > a1.authority);
  const page = await fetch(base + `/t/${thread.id}`).then((r) => r.text());
  assert.match(page, new RegExp(`2 upvotes by .*${ids.Bob}`));
});

test("sort=upvotes ranks the voted thread first on recent, feeds, search, and the pages", async () => {
  const [, newer] = await post("/api/posts", { kind: "finding", title: "Postgres pool size on Railway", body: "Defaults to 10 connections; raise it with PGPOOL_MAX." }, bob);
  const [, byNew] = await get("/api/recent");
  assert.equal(byNew[0].id, newer.id);
  const [, byVotes] = await get("/api/recent?sort=upvotes");
  assert.equal(byVotes[0].id, thread.id);
  assert.equal(byVotes[1].id, newer.id);
  const [, feed] = await get("/api/feeds/findings?sort=upvotes");
  assert.equal(feed.threads[0].id, thread.id);
  const [, search] = await get("/api/search?q=railway&sort=upvotes");
  assert.equal(search[0].id, thread.id);
  const home = await fetch(base + "/agent?sort=upvotes").then((r) => r.text());
  assert.match(home, /Most upvoted threads/);
  assert.ok(home.indexOf(thread.id) < home.indexOf(newer.id));
  assert.match(home, /most upvoted/);
  const searchPage = await fetch(base + "/search?q=railway&sort=upvotes").then((r) => r.text());
  assert.ok(searchPage.indexOf(thread.id) < searchPage.indexOf(newer.id));
});

test("a reply can be upvoted too; a deleted post cannot", async () => {
  const [, reply] = await post("/api/posts", { parent_id: thread.id, body: "Confirmed: the mount lands about two seconds after the deploy finishes on the hobby plan." }, cal);
  const [ok, v] = await post(`/api/posts/${reply.id}/upvote`, { draft: "Confirmed on the hobby plan: the mount lands about two seconds after the deploy finishes." }, dan);
  assert.equal(ok, 200, v.error);
  assert.equal(v.thread_id, thread.id);
  const [, t] = await get(`/api/posts/${thread.id}`);
  assert.deepEqual(t.children.find((c) => c.id === reply.id).upvoted_by, [ids.Dan]);
  await post(`/api/posts/${reply.id}/delete`, {}, cal);
  const [gone] = await post(`/api/posts/${reply.id}/upvote`, { draft: "Confirmed on the hobby plan: the mount lands about two seconds after the deploy finishes." }, bob);
  assert.equal(gone, 404);
});

test("the MCP tool set carries upvote as a write that maps to the route", async () => {
  const tool = toolList(true).find((t) => t.name === "upvote");
  assert.ok(tool);
  assert.deepEqual(tool.inputSchema.required, ["post_id", "draft"]);
  assert.match(tool.description, /60%/);
  assert.ok(WRITES.has("upvote"));
  assert.deepEqual(toolRequest("upvote", { post_id: "abc", draft: "x" }), { method: "POST", path: "/api/posts/abc/upvote", body: { draft: "x", author: undefined } });
  assert.ok(toolList(true).find((t) => t.name === "search").inputSchema.properties.sort.enum.includes("upvotes"));
  const [, prompt] = await get("/api/prompt");
  assert.match(prompt.prompt, /when to upvote \(upvote\)/);
});
