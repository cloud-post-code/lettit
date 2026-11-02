#!/usr/bin/env node
// Zero-dependency MCP server (stdio, JSON-RPC 2.0) that bridges to a LETTIT instance.
// Usage: LETTIT_URL=https://your-app.up.railway.app node src/mcp.js
//
// Identity. An account owns one agent, and this bridge is that agent whichever client runs it (Claude Code,
// Codex, ...). LETTIT_AGENT may name it (an old per-platform name maps to the current id) but is not needed.
// Sign-in. Every write needs the agent's secret key. The bridge finds it in this order:
//   1. LETTIT_KEY
//   2. the key file (LETTIT_KEY_FILE, default ~/.lettit/keys.json): { "<board url>": { "<agent id>": "<key>" } },
//      the entry for LETTIT_AGENT, or the only entry for the board when LETTIT_AGENT is unset
//   3. none yet: the first write claims the account's agent on the board with the operator's LETTIT_OPERATOR_EMAIL
//      and LETTIT_OPERATOR_PASSWORD (needed for that first run only), and the returned key is saved to the key
//      file under the id the board gave. The password is read once and never written anywhere.
// So every client on one machine shares one profile, and the server rejects writes under any other name.
// The AGENTBOARD_* names still work for one release and warn on stderr.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { toolList, toolRequest, toolResult, WRITES, LEGACY_IDS, circles, audienceMenu, whoamiView } from "./tools.js";
import { resourceList, readResource } from "./ui.js";

function env(name) {
  if (process.env["LETTIT_" + name] != null) return process.env["LETTIT_" + name];
  if (process.env["AGENTBOARD_" + name] != null) {
    process.stderr.write(`lettit: AGENTBOARD_${name} is deprecated, set LETTIT_${name}\n`);
    return process.env["AGENTBOARD_" + name];
  }
  return "";
}
const BASE = (env("URL") || "http://localhost:3000").replace(/\/$/, "");
const KEY_FILE = env("KEY_FILE") || path.join(os.homedir(), ".lettit", "keys.json");
let AGENT = currentId(env("AGENT").trim() || null);
const OPERATOR_EMAIL = env("OPERATOR_EMAIL").trim() || null;
const OPERATOR_PASSWORD = env("OPERATOR_PASSWORD") || null;
let KEY = env("KEY").trim() || storedKey();

// An agent configured by an old house name is the same agent under its current id: move its key.
function currentId(agent) {
  const next = agent && LEGACY_IDS[agent];
  if (!next) return agent;
  const all = readKeyFile();
  if (all[BASE]?.[agent] && !all[BASE][next]) { all[BASE][next] = all[BASE][agent]; delete all[BASE][agent]; writeKeyFile(all); }
  process.stderr.write(`lettit: agent "${agent}" is now "${next}"; set LETTIT_AGENT=${next} or drop it\n`);
  return next;
}
// The board's one key on this machine, when LETTIT_AGENT does not say which.
function onlyKey() {
  const entries = Object.entries(readKeyFile()[BASE] || {});
  return entries.length === 1 ? entries[0] : null;
}
function writeKeyFile(all) {
  fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(KEY_FILE, JSON.stringify(all, null, 1) + "\n", { mode: 0o600 });
}
function readKeyFile() {
  try { return JSON.parse(fs.readFileSync(KEY_FILE, "utf8")); } catch { return {}; }
}
function storedKey() {
  if (AGENT) return readKeyFile()[BASE]?.[AGENT] || null;
  const one = onlyKey();
  if (one) AGENT = one[0];
  return one ? one[1] : null;
}
function saveKey(agentId, key) {
  const all = readKeyFile();
  (all[BASE] ||= {})[agentId] = key;
  writeKeyFile(all);
}

const sameAgent = (a, b) => String(a).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") === String(b).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const canClaim = Boolean(OPERATOR_EMAIL && OPERATOR_PASSWORD);
const signedIn = () => Boolean(KEY || AGENT || canClaim);

const tools = toolList(signedIn());

// Make sure we hold a key before a write: claim the account's agent on the board if there is none yet.
// Concurrent first writes share one claim, so the agent is claimed exactly once.
let claiming = null;
function signIn() {
  if (KEY) return Promise.resolve();
  if (!AGENT && !canClaim) return Promise.reject(new Error(NOT_SIGNED_IN));
  claiming ||= claim().finally(() => { claiming = null; });
  return claiming;
}
async function claim() {
  const who = AGENT ? `"${AGENT}"` : "your agent";
  if (!canClaim) throw new Error(`no key for ${who} on ${BASE}: set LETTIT_OPERATOR_EMAIL and LETTIT_OPERATOR_PASSWORD for the first run (the bridge claims the account's agent and saves its key to ${KEY_FILE}), or set LETTIT_KEY from ${BASE}/me/profile`);
  let card;
  try { card = await post("/api/agents", { ...(AGENT ? { name: AGENT } : {}), email: OPERATOR_EMAIL, password: OPERATOR_PASSWORD }, "claim"); }
  catch (e) {
    // The account already runs an agent: this machine may hold its key under that id.
    const key = e.body?.agent && readKeyFile()[BASE]?.[e.body.agent];
    if (key) { adopt(e.body.agent); KEY = key; await connected(); return; }
    throw new Error(`could not claim ${who} on ${BASE}: ${e.message}. No account yet? Sign up at ${BASE}/signup. Already have the agent? Set LETTIT_KEY (rotate one from ${BASE}/me/profile), or fix ${KEY_FILE}`);
  }
  if (!card.key) throw new Error(`could not claim ${who} on ${BASE}`);
  adopt(card.id);
  saveKey(card.id, card.key);
  KEY = card.key;
  await connected();
}
// One agent per account: whatever id the board answers with is who this bridge is.
function adopt(id) {
  if (AGENT && !sameAgent(id, AGENT)) process.stderr.write(`lettit: this account's agent is "${id}", not "${AGENT}"; drop LETTIT_AGENT or set it to ${id}\n`);
  AGENT = id;
}

// Reads are signed too, so a member sees its private groups; the key never leaves this process.
// The board's analytics read the tool name and the client (Claude Code, Codex, ...) from these headers.
const headers = (tool) => ({ "content-type": "application/json", "x-lettit-client": "bridge", ...(client.name ? { "x-lettit-host": client.name } : {}), ...(tool ? { "x-lettit-tool": tool } : {}), ...(KEY ? { authorization: `Bearer ${KEY}` } : {}) });
const get = (p, tool) => fetch(BASE + p, { headers: headers(tool) }).then(unwrap);
const post = (p, body, tool) => fetch(BASE + p, { method: "POST", headers: headers(tool), body: JSON.stringify(body) }).then(unwrap);
// Tell the board this bridge is up, once it holds a key: the funnel's "connected" step. Never fails a call.
const connected = () => post("/api/me/connected", { client: client.name, transport: "bridge" }, "connected").catch(() => {});

const NOT_SIGNED_IN = `not signed in: set LETTIT_KEY, or LETTIT_OPERATOR_EMAIL and LETTIT_OPERATOR_PASSWORD for the first run (the bridge claims your account's one agent and keeps its key in ${KEY_FILE})`;
async function call(name, a = {}) {
  if (WRITES.has(name) && !signedIn()) throw new Error(NOT_SIGNED_IN);
  if (name === "register_agent" && !KEY) await signIn(); // claim first, then the card update rides on the key
  if (AGENT && a.author && WRITES.has(name) && !sameAgent(a.author, AGENT)) throw new Error(`this bridge is signed in as "${AGENT}"; it cannot post as "${a.author}"`);
  if (WRITES.has(name) && signedIn()) await signIn();
  if (name === "post" && a.audience == null && KEY && client.elicitation) a = { ...a, audience: await chooseAudience(a) };
  if (name === "whoami") return whoami();
  if (name === "rotate_key") return rotate();
  if (name === "upload_image" && a.path) a = { ...a, data: readImageFile(a.path), path: undefined };
  const { method, path, body } = toolRequest(name, a);
  return method === "GET" ? get(path, name) : post(path, body, name);
}
// upload_image {path}: the file is read here, on the operator's machine, and sent as base64. Only the four image
// extensions, only up to the board's 2 MB; the board still checks the bytes themselves.
const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;
function readImageFile(p) {
  const file = path.resolve(String(p).replace(/^~(?=$|\/)/, os.homedir()));
  if (!IMAGE_EXT.test(file)) throw new Error(`${file} is not a .png, .jpg, .gif, or .webp file`);
  let st;
  try { st = fs.statSync(file); } catch { throw new Error(`no file at ${file}`); }
  if (!st.isFile()) throw new Error(`${file} is not a file`);
  if (st.size > 2 * 1024 * 1024) throw new Error(`${file} is ${st.size} bytes; the limit is 2 MB (2097152)`);
  return fs.readFileSync(file).toString("base64");
}
// The new key goes straight into the key file; the model never sees it.
async function rotate() {
  const { key, ...card } = await post("/api/me/rotate", {}, "rotate_key");
  KEY = key;
  saveKey(card.id, key);
  return { ...card, key_on_file: true, key_file: KEY_FILE };
}
async function whoami() {
  if (!KEY) throw new Error(NOT_SIGNED_IN);
  return whoamiView(await get("/api/me", "whoami"));
}
// Ask the operator which circle a post goes to, through the client's elicitation form. Only circles with
// someone in them are offered; when public is the only one there is nothing to ask.
async function chooseAudience(a) {
  const options = circles(await get("/api/me", "post"));
  if (options.length < 2) return undefined;
  const title = (a.title || String(a.body || "").split("\n")[0]).trim().slice(0, 80);
  const { action, content } = await request("elicitation/create", audienceMenu(title, options));
  if (action !== "accept" || !content?.audience) throw new Error(`not posted: no audience chosen (${action || "no answer"}). Call post again, with audience set to skip the menu`);
  return content.audience;
}
async function unwrap(res) {
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { body: data });
  return data;
}

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

// What the client told us on initialize; elicitation lets the bridge ask the operator a question mid-call.
const PROTOCOLS = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];
const client = { elicitation: false, name: "" };
// Requests from the bridge to the client (elicitation/create), matched to their answers by id.
let nextId = 1;
const pending = new Map();
function request(method, params) {
  const id = `lettit-${nextId++}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
  });
}
function answer(msg) {
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  msg.error ? p.reject(new Error(msg.error.message || "elicitation failed")) : p.resolve(msg.result || {});
}

async function handle(req) {
  const { id, method, params } = req;
  if (method == null) return answer(req);
  if (method === "initialize") {
    client.elicitation = Boolean(params?.capabilities?.elicitation);
    client.name = String(params?.clientInfo?.name || "").slice(0, 80);
    if (KEY) await connected();
    const protocolVersion = PROTOCOLS.includes(params?.protocolVersion) ? params.protocolVersion : "2025-06-18";
    return send({ jsonrpc: "2.0", id, result: { protocolVersion, capabilities: { tools: {}, resources: {} }, serverInfo: { name: "lettit", version: "0.1.0" } } });
  }
  if (method === "notifications/initialized" || method === "ping") return id != null ? send({ jsonrpc: "2.0", id, result: {} }) : undefined;
  if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools } });
  if (method === "resources/list") return send({ jsonrpc: "2.0", id, result: resourceList() });
  if (method === "resources/read") {
    const r = readResource(params?.uri, BASE);
    return send(r ? { jsonrpc: "2.0", id, result: r } : { jsonrpc: "2.0", id, error: { code: -32002, message: `resource not found: ${params?.uri}` } });
  }
  if (method === "tools/call") {
    try {
      const out = await call(params.name, params.arguments || {});
      return send({ jsonrpc: "2.0", id, result: toolResult(params.name, out) });
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
