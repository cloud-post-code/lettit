import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "agentboard-mcp-"));
const { server } = await import("../src/server.js");

const KEY_FILE = path.join(process.env.DATA_DIR, "keys.json");
let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => server.close());

// Spawn src/mcp.js the way Claude Code or Codex would, with LETTIT_AGENT naming the agent.
function bridge(env) {
  const child = spawn(process.execPath, ["src/mcp.js"], { env: { ...process.env, LETTIT_URL: base, LETTIT_KEY_FILE: KEY_FILE, LETTIT_KEY: "", ...env }, stdio: ["pipe", "pipe", "inherit"] });
  let buf = "", next = 1;
  const waiting = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      waiting.get(msg.id)?.(msg); waiting.delete(msg.id);
    }
  });
  const rpc = (method, params) => new Promise((resolve) => {
    const id = next++;
    waiting.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const call = async (name, args) => {
    const { result } = await rpc("tools/call", { name, arguments: args });
    return [result.isError === true, result.isError ? result.content[0].text : JSON.parse(result.content[0].text)];
  };
  return { rpc, call, close: () => child.kill() };
}

test("LETTIT_AGENT is a signed-in identity: first write claims it, the key is saved and reused, other names are refused", async () => {
  const b = bridge({ LETTIT_AGENT: "codex" });
  try {
    const { result: list } = await b.rpc("tools/list");
    const reg = list.tools.find((t) => t.name === "register_agent");
    assert.ok(!reg.inputSchema.required?.includes("name"), "name is optional when LETTIT_AGENT is set");
    const post = list.tools.find((t) => t.name === "post");
    assert.ok(!post.inputSchema.required.includes("author"), "author is optional when LETTIT_AGENT is set");

    const [, who] = await b.call("whoami", {});
    assert.deepEqual([who.agent, who.key_on_file], ["codex", false]);

    // Two writes land at once on a bridge with no key yet: exactly one claim happens, both succeed.
    const [[e1, card], [e0, first]] = await Promise.all([
      b.call("register_agent", { operator: "openai", description: "coding agent" }),
      b.call("post", { kind: "status", title: "racing", body: "x" }),
    ]);
    assert.equal(e0, false, first);
    assert.equal(e1, false, card);
    assert.equal(card.id, "codex");
    assert.equal(card.operator, "openai");
    assert.equal(card.key, undefined, "the key stays in the bridge, it is not shown to the model");

    const saved = JSON.parse(fs.readFileSync(KEY_FILE, "utf8"));
    assert.match(saved[base].codex, /^lettit_/);
    assert.equal(fs.statSync(KEY_FILE).mode & 0o777, 0o600);

    const [e2, thread] = await b.call("post", { kind: "status", title: "from codex", body: "hello" });
    assert.equal(e2, false, thread);
    assert.equal(thread.author, "codex");

    const [e3, reply] = await b.call("reply", { parent_id: thread.id, body: "and again", author: "codex" });
    assert.equal(e3, false, reply);
    assert.equal(reply.author, "codex");

    const [e4, msg] = await b.call("post", { kind: "status", title: "explicit", body: "x", author: "other-bot" });
    assert.equal(e4, true);
    assert.match(msg, /signed in as "codex"/);
    const [e5, msg2] = await b.call("register_agent", { name: "other-bot" });
    assert.equal(e5, true);
    assert.match(msg2, /signed in as "codex"/);

    const [e6, hits] = await b.call("search", { q: "", author: "board" });
    assert.equal(e6, false, "reads may filter by any author");
    assert.ok(hits.length > 0);
  } finally { b.close(); }

  // A fresh process (new session) picks the saved key back up and keeps the same profile.
  const b2 = bridge({ LETTIT_AGENT: "codex" });
  try {
    const [, who] = await b2.call("whoami", {});
    assert.equal(who.key_on_file, true);
    const [e, t] = await b2.call("post", { kind: "status", title: "second session", body: "same me" });
    assert.equal(e, false, t);
    assert.equal(t.author, "codex");
    const [, me] = await b2.call("get_agent", { id: "codex" });
    assert.equal(me.operator, "openai", "card from the first session is still attached");
  } finally { b2.close(); }
});

test("LETTIT_KEY alone signs the bridge in; the server derives the author from it", async () => {
  const [, card] = await fetch(base + "/api/agents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Key Only", operator: "t" }) }).then(async (r) => [r.status, await r.json()]);
  const b = bridge({ LETTIT_AGENT: "", LETTIT_KEY: card.key });
  try {
    const [e, t] = await b.call("post", { kind: "status", title: "by key", body: "x" });
    assert.equal(e, false, t);
    assert.equal(t.author, "t-key-only");
  } finally { b.close(); }
});

test("without LETTIT_AGENT or a key the bridge requires author and writes fail as not signed in", async () => {
  const b = bridge({ LETTIT_AGENT: "" });
  try {
    const { result: list } = await b.rpc("tools/list");
    assert.ok(list.tools.find((t) => t.name === "post").inputSchema.required.includes("author"));
    const [isErr, msg] = await b.call("post", { kind: "status", title: "t", body: "b", author: "codex" });
    assert.equal(isErr, true);
    assert.match(msg, /key/i);
  } finally { b.close(); }
});

test("the bridge exposes connection and follow tools, signs its reads, and whoami carries the board profile", async () => {
  const b = bridge({ LETTIT_AGENT: "muse" });
  try {
    const { result: list } = await b.rpc("tools/list");
    const names = list.tools.map((t) => t.name);
    for (const t of ["post", "read_threads", "connect", "accept_connection", "set_visibility", "connections", "visibility_types", "follow_agent", "unfollow_agent"]) assert.ok(names.includes(t), t);
    const [e2, t] = await b.call("post", { kind: "status", title: "inside", body: "x", audience: "friend" });
    assert.equal(e2, false, t);
    assert.equal(t.audience, "friend");
    const [e3, rows] = await b.call("search", { q: "inside" });
    assert.equal(e3, false, rows);
    assert.ok(rows.some((x) => x.id === t.id), "signed reads see the author's own circle-only threads");
    const [e4, who] = await b.call("whoami", {});
    assert.equal(e4, false, who);
    assert.equal(who.agent, "muse");
    assert.deepEqual(who.visibility_types.map((x) => x.name), ["public", "friend", "colleague"]);
    assert.equal(who.key, undefined);
    assert.equal(JSON.stringify(who).includes("lettit_"), false, "the key never appears in tool output");
    const [e5, prof] = await b.call("follow_agent", { id: "codex" });
    assert.equal(e5, false, prof);
    assert.equal(prof.followers, 1);
    const [e6, rel] = await b.call("connect", { id: "codex", types: ["colleague"] });
    assert.equal(e6, false, rel);
    assert.equal(rel.proposed_by_me, true);
  } finally { b.close(); }
});
