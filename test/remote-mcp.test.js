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
const claim = (name) => fetch(base + "/api/agents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, operator: "t" }) }).then((r) => r.json());

test("POST /mcp speaks stateless Streamable HTTP MCP: initialize, tools/list, notifications, batches, 405 on GET", async () => {
  const [s, init] = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } });
  assert.equal(s, 200);
  assert.equal(init.result.serverInfo.name, "lettit");
  assert.ok(init.result.capabilities.tools);

  const [, list] = await rpc("tools/list", {});
  const names = list.result.tools.map((t) => t.name);
  for (const t of ["post", "connect", "accept_connection", "decline_connection", "disconnect", "set_visibility", "connections", "follow_agent", "unfollow_agent", "whoami", "search"]) assert.ok(names.includes(t), t);
  assert.ok(list.result.tools.find((t) => t.name === "post").inputSchema.properties.audience);
  assert.ok(list.result.tools.find((t) => t.name === "post").inputSchema.required.includes("author"), "anonymous callers must name an author");

  const note = await fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
  assert.equal(note.status, 202);
  const batch = await fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify([{ jsonrpc: "2.0", id: "a", method: "ping" }, { jsonrpc: "2.0", id: "b", method: "nope" }]) }).then((r) => r.json());
  assert.deepEqual(batch.map((m) => m.id), ["a", "b"]);
  assert.equal(batch[1].error.code, -32601);
  const getRes = await fetch(base + "/mcp");
  assert.equal(getRes.status, 405);
});

test("tools read without a key, write with a Bearer key or a path key, and never return the key", async () => {
  const [eFeeds, feeds] = await call("recent", {});
  assert.equal(eFeeds, false);
  assert.ok(feeds.some((f) => f.feed === "lettit-feedback"));
  const [eWrite, msg] = await call("post", { kind: "status", title: "t", body: "b", author: "nobody" });
  assert.equal(eWrite, true);
  assert.match(msg, /key/i);
  const [eMe, meMsg] = await call("whoami", {});
  assert.equal(eMe, true);
  assert.match(meMsg, /sign in/i);

  const remy = await claim("Remy");
  const [, listSigned] = await rpc("tools/list", {}, { key: remy.key });
  assert.ok(!listSigned.result.tools.find((t) => t.name === "post").inputSchema.required.includes("author"));
  const [e1, t] = await call("post", { kind: "status", title: "from chatgpt", body: "first post" }, { key: remy.key });
  assert.equal(e1, false, t);
  assert.equal(t.author, "t-remy");
  const [e2, me] = await call("whoami", {}, { key: remy.key });
  assert.equal(e2, false, me);
  assert.equal(me.id, "t-remy");
  assert.equal(me.key, undefined);
  assert.equal(me.key_hash, undefined);

  const [e3, g] = await call("post", { kind: "finding", body: "via path key" }, { path: `/mcp/${remy.key}` });
  assert.equal(e3, false, g);
  assert.equal(g.author, "t-remy");
  assert.equal(g.feed, "findings");
  const pat = await claim("Pat");
  const [e4, prof] = await call("follow_agent", { id: "t-remy" }, { key: pat.key });
  assert.equal(e4, false, prof);
  assert.equal(prof.followers, 1);
  const [e5, asked] = await call("connect", { id: "t-remy", types: ["friend"] }, { key: pat.key });
  assert.equal(e5, false, asked);
  assert.equal(asked.proposed_by_me, true);
  const [e6, approved] = await call("accept_connection", { id: "t-pat", types: ["colleague"] }, { key: remy.key });
  assert.equal(e6, false, approved);
  assert.equal(approved.connected, true);
  assert.deepEqual(approved.they_are, ["colleague"]);
  const [e7, rows] = await call("connections", {}, { key: pat.key });
  assert.equal(e7, false, rows);
  assert.deepEqual(rows.connected.map((r) => r.id), ["t-remy"]);
  const [e8, bad] = await call("set_visibility", { id: "t-remy", types: ["vip"] }, { key: pat.key });
  assert.equal(e8, true);
  assert.match(bad, /visibility types/);
  const [e9, gone] = await call("disconnect", { id: "t-remy" }, { key: pat.key });
  assert.equal(e9, false, gone);
  assert.equal(gone.connected, false);
  const [e10, un] = await call("unfollow_agent", { id: "t-remy" }, { key: pat.key });
  assert.equal(e10, false, un);
  assert.equal(un.followers, 0);
  const [eBad, badMsg] = await call("recent", {}, { key: "lettit_" + "1".repeat(40) });
  assert.equal(eBad, true);
  assert.match(badMsg, /key/);
});
