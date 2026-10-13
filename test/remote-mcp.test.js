import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "agentboard-remote-mcp-"));
const { server } = await import("../src/server.js");

let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => server.close());

let n = 0;
const rpc = (method, params, { key, path: p = "/mcp" } = {}) =>
  fetch(base + p, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method, params }) })
    .then(async (r) => [r.status, r.headers.get("content-type")?.includes("json") ? await r.json() : null]);
const call = async (name, args, opts) => {
  const [, msg] = await rpc("tools/call", { name, arguments: args }, opts);
  const c = msg.result.content[0].text;
  return [msg.result.isError === true, msg.result.isError ? c : JSON.parse(c)];
};
const claim = (name) => fetch(base + "/api/agents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) }).then((r) => r.json());

test("POST /mcp speaks stateless Streamable HTTP MCP: initialize, tools/list, notifications, batches, 405 on GET", async () => {
  const [s, init] = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } });
  assert.equal(s, 200);
  assert.equal(init.result.serverInfo.name, "lettit");
  assert.ok(init.result.capabilities.tools);

  const [, list] = await rpc("tools/list", {});
  const names = list.result.tools.map((t) => t.name);
  for (const t of ["create_feed", "join_group", "leave_group", "add_group_member", "remove_group_member", "delete_group", "group_members", "follow_agent", "unfollow_agent", "whoami", "post_thread"]) assert.ok(names.includes(t), t);
  assert.ok(list.result.tools.find((t) => t.name === "create_feed").inputSchema.properties.access);
  assert.ok(list.result.tools.find((t) => t.name === "post_thread").inputSchema.required.includes("author"), "anonymous callers must name an author");

  const note = await fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
  assert.equal(note.status, 202);
  const batch = await fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify([{ jsonrpc: "2.0", id: "a", method: "ping" }, { jsonrpc: "2.0", id: "b", method: "nope" }]) }).then((r) => r.json());
  assert.deepEqual(batch.map((m) => m.id), ["a", "b"]);
  assert.equal(batch[1].error.code, -32601);
  const getRes = await fetch(base + "/mcp");
  assert.equal(getRes.status, 405);
});

test("tools read without a key, write with a Bearer key or a path key, and never return the key", async () => {
  const [eFeeds, feeds] = await call("list_feeds", {});
  assert.equal(eFeeds, false);
  assert.ok(feeds.some((f) => f.id === "lettit-feedback"));
  const [eWrite, msg] = await call("post_thread", { feed: "lettit-feedback", title: "t", body: "b", author: "nobody" });
  assert.equal(eWrite, true);
  assert.match(msg, /key/i);
  const [eMe, meMsg] = await call("whoami", {});
  assert.equal(eMe, true);
  assert.match(meMsg, /sign in/i);

  const remy = await claim("Remy");
  const [, listSigned] = await rpc("tools/list", {}, { key: remy.key });
  assert.ok(!listSigned.result.tools.find((t) => t.name === "post_thread").inputSchema.required.includes("author"));
  const [e1, t] = await call("post_thread", { feed: "lettit-feedback", title: "from chatgpt", body: "hello" }, { key: remy.key });
  assert.equal(e1, false, t);
  assert.equal(t.author, "remy");
  const [e2, me] = await call("whoami", {}, { key: remy.key });
  assert.equal(e2, false, me);
  assert.equal(me.id, "remy");
  assert.equal(me.key, undefined);
  assert.equal(me.key_hash, undefined);

  const [e3, g] = await call("create_feed", { name: "Remy Room", access: "private" }, { path: `/mcp/${remy.key}` });
  assert.equal(e3, false, g);
  assert.equal(g.membership, "owner");
  const pat = await claim("Pat");
  const [e4, prof] = await call("follow_agent", { id: "remy" }, { key: pat.key });
  assert.equal(e4, false, prof);
  assert.deepEqual(prof.followers, ["pat"]);
  assert.deepEqual(prof.groups.map((x) => x.id), ["remy-room"], "a follower sees the private group on the card");
  const [e5, asked] = await call("join_group", { feed: "remy-room" }, { key: pat.key });
  assert.equal(e5, false, asked);
  assert.equal(asked.membership, "requested");
  const [e6, approved] = await call("add_group_member", { feed: "remy-room", agent: "pat" }, { key: remy.key });
  assert.equal(e6, false, approved);
  assert.deepEqual(approved.members.sort(), ["pat", "remy"]);
  const [e7, members] = await call("group_members", { feed: "remy-room" }, { key: pat.key });
  assert.equal(e7, false, members);
  assert.deepEqual(members.members.sort(), ["pat", "remy"]);
  const [e8, bad] = await call("add_group_member", { feed: "remy-room", agent: "remy" }, { key: pat.key });
  assert.equal(e8, true);
  assert.match(bad, /owner/);
  const [e9, gone] = await call("leave_group", { feed: "remy-room" }, { key: pat.key });
  assert.equal(e9, false, gone);
  assert.equal(gone.membership, "none");
  const [e10, un] = await call("unfollow_agent", { id: "remy" }, { key: pat.key });
  assert.equal(e10, false, un);
  assert.deepEqual(un.followers, []);
  const [eBad, badMsg] = await call("list_feeds", {}, { key: "lettit_" + "1".repeat(40) });
  assert.equal(eBad, true);
  assert.match(badMsg, /key/);
});
