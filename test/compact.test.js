import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lettit-compact-"));
const { server } = await import("../src/server.js");

let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => server.close());

const raw = (p, init) => fetch(base + p, init).then((r) => r.text());
const claim = (name) => fetch(base + "/api/agents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, operator: "t" }) }).then((r) => r.json());

test("API bodies are compact unless ?pretty=1 is asked for", async () => {
  const feeds = await raw("/api/feeds");
  assert.ok(!feeds.includes("\n"), "no newline in a compact body");
  const pretty = await raw("/api/feeds?pretty=1");
  assert.ok(pretty.includes("\n"), "pretty output is indented");
  assert.deepEqual(JSON.parse(pretty), JSON.parse(feeds));
  const card = await claim("Terse Bot");
  const agent = await raw("/api/agents/t-terse-bot");
  assert.ok(!agent.includes("\n"));
  assert.ok(card.key);
});

test("hosted MCP tool results are compact and drop null and empty-array fields", async () => {
  const card = await claim("Hosted Terse");
  const rpc = (method, params) => fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${card.key}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((r) => r.json());
  const { result } = await rpc("tools/call", { name: "get_agent", arguments: { id: "t-hosted-terse" } });
  const text = result.content[0].text;
  assert.ok(!text.includes("\n"), "tool result text is compact JSON");
  const data = JSON.parse(text);
  assert.equal("recent_posts" in data, false, "empty arrays are dropped");
  assert.equal(data.posts, 0, "zero stays");
  assert.equal(data.contact, "", "empty strings stay");
  const full = await fetch(base + "/api/agents/t-hosted-terse").then((r) => r.json());
  assert.deepEqual(full.recent_posts, [], "the HTTP API keeps every field");
  const { result: thread } = await rpc("tools/call", { name: "post", arguments: { kind: "status", title: "t", body: "b" } });
  const t = JSON.parse(thread.content[0].text);
  assert.equal("parent_id" in t, false, "null is dropped");
  assert.equal("tags" in t, false);
  assert.equal(t.depth, 0);
});

test("the stdio bridge returns compact, terse tool results", async () => {
  const child = spawn(process.execPath, ["src/mcp.js"], { env: { ...process.env, LETTIT_URL: base, LETTIT_AGENT: "" }, stdio: ["pipe", "pipe", "inherit"] });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_agent", arguments: { id: "board" } } }) + "\n");
  const line = await new Promise((r) => child.stdout.once("data", (d) => r(String(d))));
  child.kill();
  const text = JSON.parse(line).result.content[0].text;
  assert.ok(!text.includes("\n"));
  const data = JSON.parse(text);
  assert.equal(data.id, "board");
  assert.equal("relationship" in data, false, "null fields are dropped");
});
