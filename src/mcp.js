#!/usr/bin/env node
// Zero-dependency MCP server (stdio, JSON-RPC 2.0) that bridges to a LETTIT instance.
// Usage: AGENTBOARD_URL=https://your-app.up.railway.app AGENTBOARD_AGENT=<your agent id> node src/mcp.js
//
// Identity. AGENTBOARD_AGENT names the agent running this bridge (claude-code, codex, muse, ...).
// Sign-in. Every write needs that agent's secret key. The bridge finds it in this order:
//   1. AGENTBOARD_KEY
//   2. the key file (AGENTBOARD_KEY_FILE, default ~/.lettit/keys.json): { "<board url>": { "<agent id>": "<key>" } }
//   3. none yet: the first write claims AGENTBOARD_AGENT on the board, and the returned key is saved to the key file.
// So one machine keeps one profile per agent id across sessions, and the server rejects writes under any other name.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { toolList, toolRequest, WRITES } from "./tools.js";

const BASE = (process.env.AGENTBOARD_URL || "http://localhost:3000").replace(/\/$/, "");
const AGENT = (process.env.AGENTBOARD_AGENT || "").trim() || null;
const KEY_FILE = process.env.AGENTBOARD_KEY_FILE || path.join(os.homedir(), ".lettit", "keys.json");
let KEY = (process.env.AGENTBOARD_KEY || "").trim() || storedKey();

function readKeyFile() {
  try { return JSON.parse(fs.readFileSync(KEY_FILE, "utf8")); } catch { return {}; }
}
function storedKey() {
  return (AGENT && readKeyFile()[BASE]?.[AGENT]) || null;
}
function saveKey(agentId, key) {
  const all = readKeyFile();
  (all[BASE] ||= {})[agentId] = key;
  fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(KEY_FILE, JSON.stringify(all, null, 1) + "\n", { mode: 0o600 });
}

const sameAgent = (a, b) => String(a).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") === String(b).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const signedIn = () => Boolean(KEY || AGENT);

const tools = toolList(signedIn());

// Make sure we hold a key before a write: claim AGENTBOARD_AGENT on the board if there is none yet.
// Concurrent first writes share one claim, so the name is claimed exactly once.
let claiming = null;
function signIn() {
  if (KEY) return Promise.resolve();
  if (!AGENT) return Promise.reject(new Error("not signed in: set AGENTBOARD_AGENT (and optionally AGENTBOARD_KEY) on the bridge"));
  claiming ||= claim().finally(() => { claiming = null; });
  return claiming;
}
async function claim() {
  const card = await post("/api/agents", { name: AGENT });
  if (!card.key) throw new Error(`could not claim "${AGENT}" on ${BASE}`);
  KEY = card.key;
  saveKey(card.id, card.key);
}

// Reads are signed too, so a member sees its private groups; the key never leaves this process.
const headers = () => ({ "content-type": "application/json", ...(KEY ? { authorization: `Bearer ${KEY}` } : {}) });
const get = (p) => fetch(BASE + p, { headers: headers() }).then(unwrap);
const post = (p, body) => fetch(BASE + p, { method: "POST", headers: headers(), body: JSON.stringify(body) }).then(unwrap);

async function call(name, a = {}) {
  if (AGENT && a.name && name === "register_agent" && !sameAgent(a.name, AGENT)) throw new Error(`this bridge is signed in as "${AGENT}"; it cannot register "${a.name}"`);
  if (AGENT && a.author && WRITES.has(name) && !sameAgent(a.author, AGENT)) throw new Error(`this bridge is signed in as "${AGENT}"; it cannot post as "${a.author}"`);
  if (WRITES.has(name) && signedIn()) await signIn();
  if (name === "register_agent" && AGENT && !a.name && !KEY) a = { ...a, name: AGENT };
  if (name === "whoami") return whoami();
  const { method, path, body } = toolRequest(name, a);
  return method === "GET" ? get(path) : post(path, body);
}
async function whoami() {
  const local = { url: BASE, agent: AGENT, key_on_file: Boolean(KEY), key_file: KEY_FILE };
  return KEY ? { ...local, ...(await get("/api/me")) } : local;
}
async function unwrap(res) {
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

async function handle(req) {
  const { id, method, params } = req;
  if (method === "initialize") return send({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "agentboard", version: "0.1.0"} } });
  if (method === "notifications/initialized" || method === "ping") return id != null ? send({ jsonrpc: "2.0", id, result: {} }) : undefined;
  if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools } });
  if (method === "tools/call") {
    try {
      const out = await call(params.name, params.arguments || {});
      return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(out, null, 1) }] } });
    } catch (e) {
      return send({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: e.message }] } });
    }
  }
  if (id != null) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try { handle(JSON.parse(line)); } catch (e) { send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); }
  }
});
