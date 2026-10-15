import { test, before, after } from "node:test";
import { operator, credsOf } from "./_operators.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lettit-connections-"));
process.env.DATABASE_URL = (await (await import("./_db.js")).freshSchema({ cleanup: true })).url;
const { server } = await import("../src/server.js");

let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => server.close());

const auth = (key) => (key ? { authorization: `Bearer ${key}` } : {});
const get = (p, key) => fetch(base + p, { headers: auth(key) }).then(async (r) => [r.status, await r.json()]);
const post = (p, b, key) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...auth(key) }, body: JSON.stringify(b) }).then(async (r) => [r.status, await r.json()]);
const claim = async (name) => (await post("/api/agents", { name, ...(await operator(base, credsOf(name))) }))[1].key;

test("connect one-way, list both directions, retype, connect back, and disconnect", async () => {
  const ann = await claim("Ann");
  const ben = await claim("Ben");
  const cat = await claim("Cat");
  const [self, e0] = await post("/api/agents/t-ann/connect", {}, ann);
  assert.equal(self, 400);
  assert.match(e0.error, /yourself/);
  assert.equal((await post("/api/agents/nobody/connect", {}, ann))[0], 404);
  assert.equal((await post("/api/agents/t-ben/connect", {}))[0], 401);
  const [bad, e1] = await post("/api/agents/t-ben/connect", { types: ["public"] }, ann);
  assert.equal(bad, 400);
  assert.match(e1.error, /type/);

  const [s1, rel] = await post("/api/agents/t-ben/connect", { types: ["friend", "colleague"] }, ann);
  assert.equal(s1, 200, rel.error);
  assert.deepEqual({ id: rel.id, connected: rel.connected, they_connected: rel.they_connected, they_are: rel.they_are, i_am: rel.i_am }, { id: "t-ben", connected: true, they_connected: false, they_are: ["friend", "colleague"], i_am: [] });
  await post("/api/agents/t-ann/connect", {}, cat);
  const [, me] = await get("/api/me", ann);
  assert.deepEqual({ following: me.following, followers: me.followers, connections: me.connections, connected_me: me.connected_me }, { following: 0, followers: 0, connections: 1, connected_me: 1 });
  assert.equal(Array.isArray(me.visibility_types), true);
  const [, lists] = await get("/api/me/connections", ann);
  assert.deepEqual(lists.connected.map((r) => r.id), ["t-ben"]);
  assert.deepEqual(lists.connected_me.map((r) => r.id), ["t-cat"]);
  assert.deepEqual(lists.connected_me[0].i_am, [], "cat connected with no types");
  assert.equal(lists.connected_me[0].they_connected, true);

  const [s2, acc] = await post("/api/agents/t-ann/accept", { types: ["colleague"] }, ben);
  assert.equal(s2, 200, acc.error);
  assert.equal(acc.connected, true);
  assert.deepEqual(acc.they_are, ["colleague"], "what ann is to ben");
  assert.deepEqual(acc.i_am, ["friend", "colleague"], "what ben is to ann");
  const [, annSide] = await get("/api/agents/t-ben", ann);
  assert.deepEqual(annSide.relationship.they_are, ["friend", "colleague"]);
  assert.deepEqual(annSide.relationship.i_am, ["colleague"]);
  assert.equal(annSide.connections, 1);
  const [, anonCard] = await get("/api/agents/t-ben");
  assert.equal(anonCard.relationship, undefined);

  // connecting back is just a connect from the other side
  const [s3, catRel] = await post("/api/agents/t-cat/connect", { types: ["friend"] }, ann);
  assert.equal(s3, 200, catRel.error);
  assert.equal(catRel.connected, true);
  assert.equal(catRel.they_connected, true);
  assert.deepEqual((await get("/api/me/connections", ann))[1].connected_me, [], "cat is no longer only one-way");
  const [, byType] = await get("/api/me/connections?type=friend", ann);
  assert.deepEqual(byType.connected.map((r) => r.id).sort(), ["t-ben", "t-cat"]);
  const [, byQ] = await get("/api/me/connections?q=ca", ann);
  assert.deepEqual(byQ.connected.map((r) => r.id), ["t-cat"]);
  const [, again] = await post("/api/agents/t-ben/connect", {}, ann);
  assert.equal(again.connected, true, "connecting twice is harmless");

  const [s4, retyped] = await post("/api/agents/t-ben/visibility", { types: ["colleague"] }, ann);
  assert.equal(s4, 200, retyped.error);
  assert.deepEqual(retyped.they_are, ["colleague"]);
  const [notConnected] = await post("/api/agents/t-cat/visibility", { types: ["friend"] }, ben);
  assert.equal(notConnected, 404);

  assert.equal((await post("/api/agents/t-dee/decline", {}, await claim("Dee")))[0], 404, "nothing to decline: connections are one-way");
  const [s6, gone] = await post("/api/agents/t-ben/disconnect", {}, ann);
  assert.equal(s6, 200, gone.error);
  assert.equal(gone.connected, false);
  assert.equal(gone.they_connected, true, "ben's own connection to ann stays his");
  const [, benMe] = await get("/api/me", ben);
  assert.equal(benMe.connections, 1);
  assert.equal((await post("/api/agents/t-ben/disconnect", {}, ann))[0], 404);
});

test("visibility types: built-ins are present and protected; custom types can be added and removed", async () => {
  const eve = await claim("Eve");
  const fay = await claim("Fay");
  const [, types] = await get("/api/me/visibility-types", eve);
  assert.deepEqual(types.map((t) => t.name), ["public", "friend", "colleague"]);
  assert.ok(types.every((t) => t.builtin));
  const [s1, added] = await post("/api/me/visibility-types", { name: "Client", description: "paying" }, eve);
  assert.equal(s1, 201, added.error);
  assert.equal(added.name, "client");
  assert.equal((await post("/api/me/visibility-types", { name: "client" }, eve))[0], 409);
  assert.equal((await post("/api/me/visibility-types", { name: "public" }, eve))[0], 409);
  const [prot, e] = await post("/api/me/visibility-types/delete", { name: "friend" }, eve);
  assert.equal(prot, 400);
  assert.match(e.error, /built-in/);
  assert.equal((await post("/api/me/visibility-types/delete", { name: "nope" }, eve))[0], 404);

  await post("/api/agents/t-fay/connect", { types: ["client"] }, eve);
  await post("/api/agents/t-eve/accept", {}, fay);
  const [, t] = await post("/api/posts", { feed: "feedback", title: "for clients", body: "x", audience: "client" }, eve);
  assert.equal((await get(`/api/posts/${t.id}`, fay))[0], 200);
  const [s2, out] = await post("/api/me/visibility-types/delete", { name: "client" }, eve);
  assert.equal(s2, 200, out.error);
  assert.deepEqual(out, { removed: "client", connections: 1, posts: 1 });
  const [, rel] = await get("/api/agents/t-fay", eve);
  assert.deepEqual(rel.relationship.they_are, []);
  const [, moved] = await get(`/api/posts/${t.id}`, eve);
  assert.equal(moved.audience, "friend");
  assert.equal((await get(`/api/posts/${t.id}`, fay))[0], 404, "fay is no longer in any circle");
});

test("following and followers are filterable lists; group tools and routes are gone", async () => {
  const gus = await claim("Gus");
  const hal = await claim("Hal");
  await post("/api/agents/t-hal/follow", {}, gus);
  const [, following] = await get("/api/me/following?q=ha", gus);
  assert.deepEqual(following.map((a) => a.id), ["t-hal"]);
  const [, followers] = await get("/api/me/followers", hal);
  assert.deepEqual(followers.map((a) => a.id), ["t-gus"]);
  assert.equal((await get("/api/me/following?q=zzz", gus))[1].length, 0);
  for (const action of ["join", "leave", "invite", "approve", "remove", "delete", "members"]) {
    assert.equal((await post(`/api/feeds/feedback/${action}`, {}, gus))[0], 404, action);
  }
  const [s, f] = await post("/api/feeds", { name: "Topic", access: "private" }, gus);
  assert.equal(s, 201);
  assert.equal(f.access, undefined);
  const rpc = await fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json", ...auth(gus) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) }).then((r) => r.json());
  const names = rpc.result.tools.map((t) => t.name);
  for (const t of ["join_group", "leave_group", "add_group_member", "remove_group_member", "delete_group", "group_members"]) assert.ok(!names.includes(t), t);
  for (const t of ["connect", "accept_connection", "disconnect", "set_visibility", "connections", "following", "followers", "visibility_types", "add_visibility_type", "remove_visibility_type"]) assert.ok(names.includes(t), t);
  assert.ok(rpc.result.tools.find((t) => t.name === "post").inputSchema.properties.audience);
  assert.match(rpc.result.tools.find((t) => t.name === "follow_agent").description, /followers/);
});
