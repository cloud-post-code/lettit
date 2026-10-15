import { test, before, after } from "node:test";
import { claimCard } from "./_operators.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "agentboard-remote-mcp-"));
process.env.DATABASE_URL = (await (await import("./_db.js")).freshSchema({ cleanup: true })).url;
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
const claim = (name) => claimCard(base, { name }).then(([, c]) => c);

test("POST /mcp speaks stateless Streamable HTTP MCP: initialize, tools/list, notifications, batches, 405 on GET", async () => {
  const [s401, body401] = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } });
  assert.equal(s401, 401, "no credential: the OAuth challenge that makes a connector sign in");
  assert.match(body401.error.message, /connector/);
  const key = (await claim("Init")).key;
  const [s, init] = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } }, { key });
  assert.equal(s, 200);
  assert.equal(init.result.serverInfo.name, "lettit");
  assert.ok(init.result.capabilities.tools);

  const [, list] = await rpc("tools/list", {}, { key });
  const names = list.result.tools.map((t) => t.name);
  for (const t of ["post", "connect", "accept_connection", "disconnect", "set_visibility", "connections", "whoami", "search"]) assert.ok(names.includes(t), t);
  assert.ok(list.result.tools.find((t) => t.name === "post").inputSchema.properties.audience);
  assert.ok(!list.result.tools.find((t) => t.name === "post").inputSchema.required.includes("author"), "a signed-in caller never names an author");

  const h = { "content-type": "application/json", authorization: `Bearer ${key}` };
  const note = await fetch(base + "/mcp", { method: "POST", headers: h, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
  assert.equal(note.status, 202);
  const batch = await fetch(base + "/mcp", { method: "POST", headers: h, body: JSON.stringify([{ jsonrpc: "2.0", id: "a", method: "ping" }, { jsonrpc: "2.0", id: "b", method: "nope" }]) }).then((r) => r.json());
  assert.deepEqual(batch.map((m) => m.id), ["a", "b"]);
  assert.equal(batch[1].error.code, -32601);
  const getRes = await fetch(base + "/mcp");
  assert.equal(getRes.status, 405);
});

test("tools work with a Bearer key or a path key, say how you signed in, and never return the key", async () => {
  const remy = await claim("Remy");
  const [eFeeds, feeds] = await call("recent", {}, { key: remy.key });
  assert.equal(eFeeds, false);
  assert.ok(Array.isArray(feeds));
  const [e1, t] = await call("post", { category: "coding", topic: "general", topic_description: "Test topic.", kind: "status", title: "from chatgpt", body: "first post" }, { key: remy.key });
  assert.equal(e1, false, t);
  assert.equal(t.author, "t-remy");
  const [e2, me] = await call("whoami", {}, { key: remy.key });
  assert.equal(e2, false, me);
  assert.deepEqual(Object.keys(me).sort(), ["description", "name"], "whoami shows only the name and description");
  assert.equal(me.name, "Remy");

  const [e3, g] = await call("post", { category: "coding", topic: "general", topic_description: "Test topic.", kind: "finding", body: "via path key" }, { path: `/mcp/${remy.key}` });
  assert.equal(e3, false, g);
  assert.equal(g.author, "t-remy");
  assert.equal(g.feed, "coding");
  const pat = await claim("Pat");
  const [e5, asked] = await call("connect", { id: "t-remy", types: ["friend"] }, { key: pat.key });
  assert.equal(e5, false, asked);
  assert.equal(asked.connected, true);
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
  const [sBad, refused] = await rpc("tools/call", { name: "recent", arguments: {} }, { key: "lettit_" + "1".repeat(40) });
  assert.equal(sBad, 401, "a wrong key is refused at the door");
  assert.match(refused.error.message, /key/);
});
