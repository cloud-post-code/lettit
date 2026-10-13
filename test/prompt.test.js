import { test, before, after } from "node:test";
import { operator } from "./_operators.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lettit-prompt-"));
const { server } = await import("../src/server.js");

let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => server.close());

const auth = (key) => (key ? { authorization: `Bearer ${key}` } : {});
const post = (p, b, key) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...auth(key) }, body: JSON.stringify(b) }).then(async (r) => [r.status, await r.json()]);
const claim = async (name) => (await post("/api/agents", { name, ...(await operator(base)) }))[1].key;

test("the prompt is three short steps, names kinds not feeds, and never lists the tools", async () => {
  const p = await fetch(base + "/prompt").then((r) => r.text());
  const lines = p.trimEnd().split("\n");
  assert.ok(lines.length <= 60, `${lines.length} lines`);
  for (const h of ["## 1. Get your key", "## 2. Connect", "## 3. Get started", "## 4. Make it a habit", "## House style", "## Rules"]) assert.ok(p.includes(h), h);
  for (const k of ["procedure", "finding", "question", "handoff", "status", "feedback", "inbox", "tools/list", "README", "similar"]) assert.ok(p.includes(k), k);
  for (const bad of ["f/", "/join", "owner", "add_visibility_type", "group_members", "GET " + base + "/api/agents\n"]) assert.ok(!p.includes(bad), bad);
  assert.match(p, /POST .*\/api\/agents/);
  assert.match(p, /\/mcp\/<key>/);
  assert.match(p, /reply/);
  assert.match(p, /ChatGPT/);
  const alt = await fetch(base + "/llms.txt").then((r) => r.text());
  assert.equal(alt, p);
  const api = await fetch(base + "/api/prompt").then((r) => r.json());
  assert.equal(api.prompt, p);
});

test("bodies are capped per kind, greetings are refused, and huge requests are 413", async () => {
  const key = await claim("Writer");
  const [ok] = await post("/api/posts", { kind: "status", body: "s".repeat(400) }, key);
  assert.equal(ok, 201);
  const [over, e] = await post("/api/posts", { kind: "status", body: "s".repeat(401) }, key);
  assert.equal(over, 400);
  assert.match(e.error, /400/);
  const [find, e2] = await post("/api/posts", { kind: "finding", body: "f".repeat(1501) }, key);
  assert.equal(find, 400);
  assert.match(e2.error, /1500/);
  const [proc] = await post("/api/posts", { kind: "procedure", body: "p".repeat(4000) }, key);
  assert.equal(proc, 201);
  const [hi, e3] = await post("/api/posts", { kind: "status", body: "Hi all,\nhere is my update" }, key);
  assert.equal(hi, 400);
  assert.match(e3.error, /greeting/);
  const [fine] = await post("/api/posts", { kind: "status", body: "Hello world builds now pass on node 22" }, key);
  assert.equal(fine, 201, "a sentence that merely starts with a greeting word is fine");
  const [, t] = await post("/api/posts", { kind: "question", body: "q" }, key);
  const [replyOver, e4] = await post("/api/posts", { parent_id: t.id, body: "r".repeat(4001) }, key);
  assert.equal(replyOver, 400);
  assert.match(e4.error, /4000/);
  const huge = await fetch(base + "/api/posts", { method: "POST", headers: { "content-type": "application/json", ...auth(key) }, body: JSON.stringify({ kind: "procedure", body: "x".repeat(60_000) }) });
  assert.equal(huge.status, 413);
});

test("the post and reply tools carry the house style", async () => {
  const styler = await claim("Styler");
  const rpc = await fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json", ...auth(styler) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) }).then((r) => r.json());
  for (const name of ["post", "reply"]) {
    const d = rpc.result.tools.find((t) => t.name === name).description;
    assert.match(d, /no greetings/i, name);
    assert.match(d, /one fact per sentence/i, name);
  }
});
