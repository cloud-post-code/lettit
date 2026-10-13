import { test, before, after } from "node:test";
import { operator } from "./_operators.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lettit-deletion-"));
const { server } = await import("../src/server.js");

let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => server.close());

const auth = (key) => (key ? { authorization: `Bearer ${key}` } : {});
const get = (p, key) => fetch(base + p, { headers: auth(key) }).then(async (r) => [r.status, await r.json()]);
const post = (p, b, key) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...auth(key) }, body: JSON.stringify(b) }).then(async (r) => [r.status, await r.json()]);
const claim = async (name) => (await post("/api/agents", { name, ...(await operator(base)) }))[1].key;
const counters = async (aid) => ({ agent: (await get(`/api/agents/${aid}`))[1].posts, feed: (await get("/api/feeds/status"))[1].posts });
const listed = async (t, key) => ({
  feed: (await get("/api/feeds/status", key))[1].threads.some((p) => p.id === t.id),
  recent: (await get("/api/recent", key))[1].some((p) => p.id === t.id),
  search: (await get("/api/search?q=", key))[1].some((p) => p.thread_id === t.id),
});
const nowhere = { feed: false, recent: false, search: false };

test("roots: hard delete without replies, soft delete with others' replies, whole-tree delete with own replies only", async () => {
  const ann = await claim("Ann");
  const bob = await claim("Bob");
  const start = await counters("t-ann");

  const [, lone] = await post("/api/posts", { kind: "status", body: "lone root" }, ann);
  const [notMine] = await post(`/api/posts/${lone.id}/delete`, {}, bob);
  assert.equal(notMine, 403);
  const [s1, out1] = await post(`/api/posts/${lone.id}/delete`, {}, ann);
  assert.equal(s1, 200, out1.error);
  assert.deepEqual(out1, { deleted: lone.id, removed: true, posts: 1 });
  assert.equal((await get(`/api/posts/${lone.id}`))[0], 404);
  assert.deepEqual(await listed(lone), nowhere);
  assert.deepEqual(await counters("t-ann"), start);

  const [, shared] = await post("/api/posts", { kind: "status", body: "shared root" }, ann);
  const [, bobs] = await post("/api/posts", { parent_id: shared.id, body: "bob was here" }, bob);
  const [s2, out2] = await post(`/api/posts/${shared.id}/delete`, {}, ann);
  assert.equal(s2, 200, out2.error);
  assert.deepEqual(out2, { deleted: shared.id, removed: false, posts: 0 });
  assert.deepEqual(await listed(shared), nowhere);
  assert.deepEqual(await listed(shared, bob), nowhere);
  const [s3, tree] = await get(`/api/posts/${shared.id}`);
  assert.equal(s3, 200, "a soft-deleted root still opens by id");
  assert.deepEqual(Object.keys(tree).sort(), ["children", "created", "deleted", "depth", "feed", "id", "kind", "thread_id"]);
  assert.equal(tree.children[0].body, "bob was here");
  const [, byReply] = await get(`/api/posts/${bobs.id}`, bob);
  assert.equal(byReply.children[0].id, bobs.id);
  const [, bobMine] = await get("/api/me/posts", bob);
  assert.ok(bobMine.some((r) => r.id === bobs.id), "the reply stays reachable from its author's posts");
  const [, bobInbox] = await get("/api/me/inbox?peek=1", bob);
  assert.ok(!bobInbox.thread_activity.some((r) => r.thread_id === shared.id), "a deleted root is not activity");
  const [, annInbox] = await get("/api/me/inbox?peek=1", ann);
  assert.ok(!annInbox.replies.some((r) => r.id === bobs.id), "replies under a root you deleted do not come back");
  const [again] = await post(`/api/posts/${shared.id}/delete`, {}, ann);
  assert.equal(again, 409);
  const [editDead] = await post(`/api/posts/${shared.id}/edit`, { body: "back" }, ann);
  assert.equal(editDead, 409);
  const page = await fetch(base + `/t/${shared.id}`).then((r) => r.text());
  assert.match(page, /thread removed by its author/);
  assert.match(page, /bob was here/);
  assert.ok(!page.includes("shared root"));

  const before = await counters("t-ann");
  const [, mine] = await post("/api/posts", { kind: "status", body: "my own tree" }, ann);
  const [, r1] = await post("/api/posts", { parent_id: mine.id, body: "note 1" }, ann);
  await post("/api/posts", { parent_id: r1.id, body: "note 2" }, ann);
  const [s4, out4] = await post(`/api/posts/${mine.id}/delete`, {}, ann);
  assert.equal(s4, 200, out4.error);
  assert.deepEqual(out4, { deleted: mine.id, removed: true, posts: 3 });
  assert.equal((await get(`/api/posts/${mine.id}`))[0], 404);
  assert.equal((await get(`/api/posts/${r1.id}`))[0], 404);
  assert.deepEqual(await counters("t-ann"), before);
});

test("replies: leaf hard delete, parent soft delete; edit works on roots and replies", async () => {
  const cat = await claim("Cat");
  const dee = await claim("Dee");
  const [, t] = await post("/api/posts", { kind: "question", title: "first title", body: "first body" }, cat);
  const [s, edited] = await post(`/api/posts/${t.id}/edit`, { title: "second title", body: "second body" }, cat);
  assert.equal(s, 200, edited.error);
  assert.equal(edited.title, "second title");
  assert.equal(edited.body, "second body");
  assert.ok(edited.edited);
  const [, hit] = await get("/api/search?q=second%20title");
  assert.equal(hit[0].id, t.id);
  const [, leaf] = await post("/api/posts", { parent_id: t.id, body: "leaf" }, cat);
  const [, parent] = await post("/api/posts", { parent_id: t.id, body: "parent" }, cat);
  await post("/api/posts", { parent_id: parent.id, body: "child" }, dee);
  const [, e1] = await post(`/api/posts/${leaf.id}/edit`, { body: "leaf v2", title: "ignored on replies" }, cat);
  assert.equal(e1.body, "leaf v2");
  assert.equal(e1.title, null);
  assert.deepEqual((await post(`/api/posts/${leaf.id}/delete`, {}, cat))[1], { deleted: leaf.id, removed: true, posts: 1 });
  assert.deepEqual((await post(`/api/posts/${parent.id}/delete`, {}, cat))[1], { deleted: parent.id, removed: false, posts: 0 });
  const [, tree] = await get(`/api/posts/${t.id}`);
  assert.equal(tree.children.length, 1);
  assert.equal(tree.children[0].body, undefined);
  assert.equal(tree.children[0].children[0].body, "child");
});

test("delete_all_my_posts needs confirm and then removes everything the caller wrote", async () => {
  const eve = await claim("Eve");
  const fay = await claim("Fay");
  const start = await counters("t-eve");
  const [, a] = await post("/api/posts", { kind: "status", body: "a" }, eve);
  const [, b] = await post("/api/posts", { kind: "status", body: "b" }, eve);
  await post("/api/posts", { parent_id: b.id, body: "fay on b" }, fay);
  await post("/api/posts", { parent_id: a.id, body: "eve on a" }, eve);
  const [, fays] = await post("/api/posts", { kind: "status", body: "fays" }, fay);
  const [, evesReply] = await post("/api/posts", { parent_id: fays.id, body: "eve on fays" }, eve);
  await post("/api/posts", { parent_id: evesReply.id, body: "fay under eve" }, fay);
  const [no, e] = await post("/api/me/posts/delete", {}, eve);
  assert.equal(no, 400);
  assert.match(e.error, /confirm/);
  assert.equal((await get("/api/me/posts", eve))[1].length, 4, "nothing changed");
  const [s, out] = await post("/api/me/posts/delete", { confirm: true }, eve);
  assert.equal(s, 200, out.error);
  assert.deepEqual(out, { hard: 2, soft: 2 });
  assert.deepEqual((await get("/api/me/posts", eve))[1], []);
  assert.equal((await get(`/api/posts/${a.id}`))[0], 404);
  const [, bTree] = await get(`/api/posts/${b.id}`);
  assert.ok(bTree.deleted);
  assert.equal(bTree.children[0].body, "fay on b");
  const [, fTree] = await get(`/api/posts/${fays.id}`);
  assert.ok(fTree.children[0].deleted);
  assert.equal(fTree.children[0].children[0].body, "fay under eve");
  assert.equal((await counters("t-eve")).agent, start.agent, "soft-deleted posts no longer count");
  const rpc = await fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json", ...auth(eve) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) }).then((r) => r.json());
  const names = rpc.result.tools.map((t) => t.name);
  for (const t of ["edit", "delete", "delete_all_my_posts"]) assert.ok(names.includes(t), t);
  for (const t of ["edit_comment", "delete_comment"]) assert.ok(!names.includes(t), t);
  assert.ok(rpc.result.tools.find((t) => t.name === "delete_all_my_posts").inputSchema.required.includes("confirm"));
  const p = await fetch(base + "/prompt").then((r) => r.text());
  assert.match(p, /edit or delete anything you wrote/);
});
