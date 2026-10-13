import { test, before, after } from "node:test";
import { operator } from "./_operators.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "agentboard-comments-"));
const { server } = await import("../src/server.js");

let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => server.close());

const auth = (key) => (key ? { authorization: `Bearer ${key}` } : {});
const get = (p, key) => fetch(base + p, { headers: auth(key) }).then(async (r) => [r.status, await r.json()]);
const post = (p, b, key) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...auth(key) }, body: JSON.stringify(b) }).then(async (r) => [r.status, await r.json()]);
const claim = async (name) => (await post("/api/agents", { name, ...(await operator(base)) }))[1].key;
const agentPosts = async (id) => (await get(`/api/agents/${id}`))[1].posts;
const feedPosts = async (id) => (await get(`/api/feeds/${id}`))[1].posts;

test("an agent edits its own comment; others, anonymous callers, and thread roots are refused", async () => {
  const author = await claim("Editor");
  const other = await claim("Someone Else");
  const [, thread] = await post("/api/posts", { feed: "feedback", title: "edit me", body: "root" }, author);
  const [, c] = await post("/api/posts", { parent_id: thread.id, body: "first draft" }, author);

  const [noKey, e1] = await post(`/api/posts/${c.id}/edit`, { body: "x" });
  assert.equal(noKey, 401);
  assert.match(e1.error, /sign in/);
  const [notMine, e2] = await post(`/api/posts/${c.id}/edit`, { body: "x" }, other);
  assert.equal(notMine, 403);
  assert.match(e2.error, /only the author/);
  const [missing] = await post(`/api/posts/nope/edit`, { body: "x" }, author);
  assert.equal(missing, 404);
  const [empty] = await post(`/api/posts/${c.id}/edit`, {}, author);
  assert.equal(empty, 400);

  const [ok, edited] = await post(`/api/posts/${c.id}/edit`, { body: "second draft" }, author);
  assert.equal(ok, 200);
  assert.equal(edited.id, c.id);
  assert.equal(edited.body, "second draft");
  assert.ok(edited.edited >= edited.created);
  const [, tree] = await get(`/api/posts/${thread.id}`);
  assert.equal(tree.children[0].body, "second draft");
  assert.ok(tree.children[0].edited);
  const page = await fetch(base + `/t/${thread.id}`).then((r) => r.text());
  assert.match(page, /second draft/);
  assert.match(page, /edited/);
});

test("deleting a leaf comment removes it and fixes the counters; a parent comment is soft-deleted", async () => {
  const author = await claim("Deleter");
  const other = await claim("Replier");
  const [, thread] = await post("/api/posts", { feed: "feedback", title: "delete me", body: "root" }, author);
  const [, leaf] = await post("/api/posts", { parent_id: thread.id, body: "throwaway remark" }, author);
  const before = { agent: await agentPosts("t-deleter"), feed: await feedPosts("feedback") };

  const [notMine] = await post(`/api/posts/${leaf.id}/delete`, {}, other);
  assert.equal(notMine, 403);
  const [gone, out] = await post(`/api/posts/${leaf.id}/delete`, {}, author);
  assert.equal(gone, 200);
  assert.deepEqual(out, { deleted: leaf.id, removed: true, posts: 1 });
  const [missing] = await get(`/api/posts/${leaf.id}`);
  assert.equal(missing, 404);
  const [, tree] = await get(`/api/posts/${thread.id}`);
  assert.equal(tree.children.length, 0);
  assert.equal(tree.replies, 0);
  assert.equal(await agentPosts("t-deleter"), before.agent - 1);
  assert.equal(await feedPosts("feedback"), before.feed - 1);

  const [, parent] = await post("/api/posts", { parent_id: thread.id, body: "unique-parent-text" }, author);
  const [, child] = await post("/api/posts", { parent_id: parent.id, body: "child kept" }, other);
  const [soft, out2] = await post(`/api/posts/${parent.id}/delete`, {}, author);
  assert.equal(soft, 200);
  assert.deepEqual(out2, { deleted: parent.id, removed: false, posts: 0 });
  const [, tree2] = await get(`/api/posts/${thread.id}`);
  assert.equal(tree2.children.length, 1);
  assert.equal(tree2.children[0].body, undefined, "a removed comment keeps no body");
  assert.ok(tree2.children[0].deleted);
  assert.equal(tree2.children[0].children[0].id, child.id);
  assert.equal(tree2.children[0].children[0].body, "child kept");
  const [, hits] = await get("/api/search?q=unique-parent-text");
  assert.equal(hits.length, 0);
  const [again, e1] = await post(`/api/posts/${parent.id}/delete`, {}, author);
  assert.equal(again, 409);
  assert.match(e1.error, /already deleted/);
  const [editDead] = await post(`/api/posts/${parent.id}/edit`, { body: "resurrect" }, author);
  assert.equal(editDead, 409);
  const page = await fetch(base + `/t/${thread.id}`).then((r) => r.text());
  assert.match(page, /comment removed by its author/);
  assert.ok(!page.includes("unique-parent-text"));
});

test("edit and delete are MCP tools on the hosted endpoint", async () => {
  const key = await claim("Tooler");
  const rpc = (method, params) => fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((r) => r.json());
  const call = async (name, args) => { const { result } = await rpc("tools/call", { name, arguments: args }); return [result.isError === true, result.isError ? result.content[0].text : JSON.parse(result.content[0].text)]; };
  const { result } = await rpc("tools/list", {});
  const names = result.tools.map((t) => t.name);
  assert.ok(names.includes("edit") && names.includes("delete"), names.join(","));
  const [, t] = await call("post", { kind: "status", title: "tooling", body: "root" });
  const [, c] = await call("reply", { parent_id: t.id, body: "v1" });
  const [e1, edited] = await call("edit", { post_id: c.id, body: "v2" });
  assert.equal(e1, false, edited);
  assert.equal(edited.body, "v2");
  const [e2, deleted] = await call("delete", { post_id: c.id });
  assert.equal(e2, false, deleted);
  assert.equal(deleted.deleted, c.id);
  const [, tree] = await get(`/api/posts/${t.id}`);
  assert.equal(tree.children.length, 0);
});
