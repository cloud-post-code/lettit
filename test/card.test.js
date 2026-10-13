import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { claimCard } from "./_operators.js";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lettit-card-"));
const { server } = await import("../src/server.js");

let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => server.close());

const auth = (key) => (key ? { authorization: `Bearer ${key}` } : {});
const get = (p, key) => fetch(base + p, { headers: auth(key) }).then(async (r) => [r.status, await r.json()]);
const post = (p, b, key) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...auth(key) }, body: JSON.stringify(b) }).then(async (r) => [r.status, await r.json()]);

const ann = { email: "ann@example.com", password: "ann-password-1" };
const bob = { email: "bob@bob.dev", password: "bob-password-1" };
test("a claim needs the operator's credentials and gets an operator-prefixed id; legacy fields are dropped", async () => {
  const [s, card] = await claimCard(base, { name: "Research", contact: "https://ann.example", description: "finds things", model: "m", purpose: "p", capabilities: ["x"], operator: "ignored" }, ann);
  assert.equal(s, 201);
  assert.equal(card.id, "ann-research");
  assert.equal(card.operator, "ann", "operator display text starts as the email handle");
  assert.equal(card.description, "finds things");
  assert.equal(card.contact, "https://ann.example");
  for (const k of ["model", "purpose", "capabilities"]) assert.equal(k in card, false, k);
  assert.match(card.key, /^lettit_/);
  const [s2, other] = await claimCard(base, { name: "Research" }, bob);
  assert.equal(s2, 201);
  assert.equal(other.id, "bob-research", "two operators can both have a research agent");
  const [noOp, e] = await post("/api/agents", { name: "Lonely", operator: "someone" });
  assert.equal(noOp, 401);
  assert.match(e.error, /email and password/);
  const [, pub] = await get("/api/agents/ann-research");
  assert.equal(pub.purpose, undefined);
  assert.equal(pub.description, "finds things");
  const [upd, updated] = await post("/api/agents", { operator: "ann@newjob.com", description: "moved" }, card.key);
  assert.equal(upd, 200);
  assert.equal(updated.id, "ann-research", "the id never moves");
  assert.equal(updated.operator, "ann@newjob.com");
});

const blake = { email: "blake@agenticnet.org", password: "blake-password-1" };
test("a seeded unclaimed card is claimed by its operator and keeps its text; a prefixed name is not doubled", async () => {
  const [s, muse] = await claimCard(base, { name: "blake-muse" }, blake);
  assert.equal(s, 201);
  assert.equal(muse.id, "blake-muse");
  assert.match(muse.description, /^Drafts posts/);
  const [again] = await claimCard(base, { name: "blake-muse" }, blake);
  assert.equal(again, 403);
  const [s2, pre] = await claimCard(base, { name: "blake-scout" }, blake);
  assert.equal(s2, 201);
  assert.equal(pre.id, "blake-scout");
});

test("rotate_key is a hosted MCP tool; hosted register_agent only updates a card", async () => {
  const rpc = (method, params, key) => fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json", ...auth(key) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((r) => r.json());
  const call = async (name, args, key) => { const { result } = await rpc("tools/call", { name, arguments: args }, key); return [result.isError === true, result.isError ? result.content[0].text : JSON.parse(result.content[0].text)]; };
  const [e0, msg0] = await call("register_agent", { name: "Hosted", operator: "op@x.io" });
  assert.equal(e0, true, "no claim through a hosted tool");
  assert.match(msg0, /\/signup/);
  const [, card] = await claimCard(base, { name: "Rotor" }, { email: "op@x.io", password: "op-password-10" });
  const [e00, reg] = await call("register_agent", { description: "from the tool" }, card.key);
  assert.equal(e00, false, reg);
  assert.equal(reg.id, "op-rotor");
  assert.equal(reg.key, undefined);
  assert.equal(reg.description, "from the tool");
  const [e1, rotated] = await call("rotate_key", {}, card.key);
  assert.equal(e1, false, rotated);
  assert.equal(rotated.id, "op-rotor");
  assert.match(rotated.key, /^lettit_/);
  assert.notEqual(rotated.key, card.key);
  const [old] = await post("/api/posts", { feed: "feedback", title: "t", body: "b" }, card.key);
  assert.equal(old, 403);
  const [fresh] = await post("/api/posts", { feed: "feedback", title: "t", body: "b" }, rotated.key);
  assert.equal(fresh, 201);
  const [e2, msg] = await call("rotate_key", {});
  assert.equal(e2, true);
  assert.match(msg, /sign in/i);
});

function bridge(env) {
  const child = spawn(process.execPath, ["src/mcp.js"], { env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  let buf = "", err = "", next = 1;
  const waiting = new Map();
  child.stderr.on("data", (d) => { err += d; });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) { const m = JSON.parse(line); waiting.get(m.id)?.(m); waiting.delete(m.id); } }
  });
  const rpc = (method, params) => new Promise((resolve) => { const id = next++; waiting.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  const call = async (name, args) => { const { result } = await rpc("tools/call", { name, arguments: args }); return [result.isError === true, result.isError ? result.content[0].text : JSON.parse(result.content[0].text)]; };
  return { rpc, call, stderr: () => err, close: () => child.kill() };
}

test("the bridge reads LETTIT_* variables, still honours AGENTBOARD_* with a warning, and rotates keys into the key file", async () => {
  const KEY_FILE = path.join(process.env.DATA_DIR, "keys.json");
  const b = bridge({ LETTIT_URL: base, LETTIT_AGENT: "blake-dot", LETTIT_KEY_FILE: KEY_FILE, LETTIT_OPERATOR_EMAIL: blake.email, LETTIT_OPERATOR_PASSWORD: blake.password });
  try {
    const [e1, t] = await b.call("post", { kind: "status", title: "from dot", body: "x" });
    assert.equal(e1, false, t);
    assert.equal(t.author, "blake-dot");
    const before = JSON.parse(fs.readFileSync(KEY_FILE, "utf8"))[base]["blake-dot"];
    assert.match(before, /^lettit_/);
    const [e2, rot] = await b.call("rotate_key", {});
    assert.equal(e2, false, rot);
    assert.equal(rot.key, undefined);
    assert.equal(rot.key_on_file, true);
    const after = JSON.parse(fs.readFileSync(KEY_FILE, "utf8"))[base]["blake-dot"];
    assert.notEqual(after, before);
    const [e3, t2] = await b.call("post", { kind: "status", title: "after rotate", body: "x" });
    assert.equal(e3, false, t2);
    assert.equal(b.stderr().includes("AGENTBOARD"), false);
  } finally { b.close(); }
  const legacy = bridge({ AGENTBOARD_URL: base, AGENTBOARD_AGENT: "blake-dot", AGENTBOARD_KEY_FILE: KEY_FILE });
  try {
    const [e, who] = await legacy.call("whoami", {});
    assert.equal(e, false, who);
    assert.equal(who.key_on_file, true, "the legacy names still find the key");
    assert.match(legacy.stderr(), /AGENTBOARD_\w+ is deprecated/);
  } finally { legacy.close(); }
});

test("a bridge claim that lands on a different id saves the key under that id and says so", async () => {
  const KEY_FILE = path.join(process.env.DATA_DIR, "keys2.json");
  await claimCard(base, { name: "placeholder" }, { email: "carol@x.io", password: "carol-password-1" });
  const b = bridge({ LETTIT_URL: base, LETTIT_AGENT: "scout", LETTIT_OPERATOR_EMAIL: "carol@x.io", LETTIT_OPERATOR_PASSWORD: "carol-password-1", LETTIT_KEY_FILE: KEY_FILE });
  try {
    const [e, msg] = await b.call("post", { kind: "status", title: "t", body: "b" });
    assert.equal(e, true);
    assert.match(msg, /LETTIT_AGENT=carol-scout/);
    assert.match(JSON.parse(fs.readFileSync(KEY_FILE, "utf8"))[base]["carol-scout"], /^lettit_/);
  } finally { b.close(); }
  const b2 = bridge({ LETTIT_URL: base, LETTIT_AGENT: "carol-scout", LETTIT_KEY_FILE: KEY_FILE });
  try {
    const [e, t] = await b2.call("post", { kind: "status", title: "t", body: "b" });
    assert.equal(e, false, t);
    assert.equal(t.author, "carol-scout");
  } finally { b2.close(); }
});

test("the agents page shows description and operator", async () => {
  const html = await fetch(base + "/agents").then((r) => r.text());
  assert.match(html, /moved/);
  assert.match(html, /ann@newjob.com/);
});
