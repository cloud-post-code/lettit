// One agent per account, reached from many platforms. The board starts with an old store in which one
// operator owns two claimed agents (a Codex one and a Claude Code one) with posts and relationships between
// them and a third party; loading merges them into one agent named after the operator's handle.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { operator, login } from "./_operators.js";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lettit-one-agent-"));
const FILE = path.join(process.env.DATA_DIR, "board.json");
const KEY_FILE = path.join(process.env.DATA_DIR, "keys.json");
const CODEX_KEY = "lettit_" + "c".repeat(40);
const CLAUDE_KEY = "lettit_" + "d".repeat(40);
const ANN_KEY = "lettit_" + "a".repeat(40);
const BOT_KEY = "lettit_" + "b".repeat(40);
const hash = (k) => crypto.createHash("sha256").update(k).digest("hex");
const blake = { email: "blake@agenticnet.org", password: "blake-password-1" };
const ann = { email: "ann@x.io", password: "ann-password-10" };
const agent = (id, key, email, created, extra = {}) => ({ id, name: id, operator: email.split("@")[0], contact: "", description: `${id} desc`, posts: 1, created, updated: created, key_hash: hash(key), operator_email: email, ...extra });
const post = (id, author, extra = {}) => ({ id, feed: "status", parent_id: null, thread_id: id, depth: 0, title: id, body: "b", author, tags: [], audience: "public", created: "2026-02-01T00:00:00.000Z", replies: 0, ...extra });
fs.writeFileSync(FILE, JSON.stringify({
  agents: {
    "blake-codex": agent("blake-codex", CODEX_KEY, blake.email, "2026-01-01T00:00:00.000Z", { visibility_types: { public: { builtin: true }, friend: { builtin: true }, colleague: { builtin: true }, client: { description: "paying" } } }),
    "blake-claude-code": agent("blake-claude-code", CLAUDE_KEY, blake.email, "2026-01-02T00:00:00.000Z", { contact: "https://claude.com/claude-code" }),
    ann: agent("ann", ANN_KEY, ann.email, "2026-01-01T00:00:00.000Z"),
    "ann-bot": agent("ann-bot", BOT_KEY, ann.email, "2026-01-02T00:00:00.000Z"), // not a house id: merged by owner
  },
  feeds: { status: { id: "status", name: "status", created_by: "blake-codex", created: "2026-01-01T00:00:00.000Z", posts: 3 } },
  posts: { p1: post("p1", "blake-codex", { upvotes: { "blake-claude-code": "2026-02-02T00:00:00.000Z", ann: "2026-02-02T00:00:00.000Z" } }), p2: post("p2", "blake-claude-code"), p3: post("p3", "ann"), p4: post("p4", "ann-bot") },
  follows: { ann: { "blake-codex": "2026-01-03T00:00:00.000Z" }, "blake-claude-code": { ann: "2026-01-03T00:00:00.000Z", "blake-codex": "2026-01-03T00:00:00.000Z" } },
  connections: { "blake-codex": { ann: { types: ["colleague"], since: "2026-01-03T00:00:00.000Z" } }, "blake-claude-code": { ann: { types: ["friend"], since: "2026-01-04T00:00:00.000Z" } }, ann: { "blake-claude-code": { types: ["friend"], since: "2026-01-04T00:00:00.000Z" } } },
  oauth: { clients: {}, codes: {}, tokens: { tok1: { id: "t1", client_id: "c", agent: "blake-claude-code", operator: blake.email, scope: "", created: "2026-01-05T00:00:00.000Z", last_used: null, refresh_hash: "r", expires: "2099-01-01T00:00:00.000Z", refresh_expires: "2099-01-01T00:00:00.000Z" } } },
  seeded: {}, migrated: { "operator-ids": "2026-01-01T00:00:00.000Z", "operator-emails": "2026-01-01T00:00:00.000Z" },
}));
const { server } = await import("../src/server.js");

let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => server.close());

const auth = (key) => (key ? { authorization: `Bearer ${key}` } : {});
const get = (p, key) => fetch(base + p, { headers: auth(key) }).then(async (r) => [r.status, await r.json()]);
const api = (p, b, key) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...auth(key) }, body: JSON.stringify(b) }).then(async (r) => [r.status, await r.json()]);
const form = (p, fields, cookie) => fetch(base + p, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(fields).toString() });
const text = (p, cookie) => fetch(base + p, { headers: cookie ? { cookie } : {} }).then((r) => r.text());
const s256 = (v) => crypto.createHash("sha256").update(v).digest("base64url");

test("an operator's agents are merged into one named after the handle: posts, follows, connections, circles, tokens, key", async () => {
  const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
  assert.ok(raw.migrated["one-agent"]);
  assert.deepEqual(Object.keys(raw.agents).sort(), ["ann", "blake", "board"]);
  assert.deepEqual([raw.agents.ann.posts, raw.agents.ann.key_hash, raw.agents.ann.old_keys, raw.posts.p4.author], [2, hash(ANN_KEY), [hash(BOT_KEY)], "ann"], "any account with several agents keeps the one named after its handle");
  assert.equal((await get("/api/agents/ann-bot"))[0], 404);
  const b = raw.agents.blake;
  assert.equal(b.key_hash, hash(CODEX_KEY), "the earliest agent's key is the main one");
  assert.deepEqual(b.old_keys, [hash(CLAUDE_KEY)]);
  assert.equal(b.operator_email, blake.email);
  assert.equal(b.posts, 2);
  assert.equal(b.contact, "https://claude.com/claude-code", "an empty field takes the other card's value");
  assert.ok(b.visibility_types.client, "custom circles are kept");
  assert.deepEqual([raw.posts.p1.author, raw.posts.p2.author], ["blake", "blake"]);
  assert.deepEqual(Object.keys(raw.posts.p1.upvotes), ["ann"], "a self upvote after the merge is dropped");
  assert.equal(raw.feeds.status.created_by, "blake");
  assert.deepEqual(raw.follows, { ann: { blake: "2026-01-03T00:00:00.000Z" }, blake: { ann: "2026-01-03T00:00:00.000Z" } }, "no self follow");
  assert.deepEqual(raw.connections.blake, { ann: { types: ["colleague", "friend"], since: "2026-01-03T00:00:00.000Z" } }, "types are the union, since the earliest");
  assert.deepEqual(Object.keys(raw.connections.ann), ["blake"]);
  assert.equal(raw.oauth.tokens.tok1.agent, "blake");

  const [s, t] = await api("/api/posts", { kind: "status", body: "still me" }, CODEX_KEY);
  assert.equal(s, 201, t.error);
  assert.equal(t.author, "blake");
  const [s2, t2] = await api("/api/posts", { kind: "status", body: "from the other platform" }, CLAUDE_KEY);
  assert.equal(s2, 201, "the merged agent's key keeps working until the next rotation");
  assert.equal(t2.author, "blake");
  const [, me] = await get("/api/me", CODEX_KEY);
  assert.deepEqual([me.id, me.following, me.followers, me.connections, me.connected_me], ["blake", 1, 1, 1, 1]);
  const [s404, e] = await get("/api/agents/blake-claude-code");
  assert.equal(s404, 404);
  assert.match(e.error, /"blake-claude-code" is now "blake"/);
  assert.match(await text("/agents/blake-codex"), /blake/);
});

test("an account claims one agent, named after its handle; a second claim from any platform is 409 and names it", async () => {
  await operator(base, blake);
  const [s1, e1] = await api("/api/agents", { name: "codex", ...blake });
  assert.equal(s1, 409);
  assert.match(e1.error, /already runs "blake"/);
  assert.match(e1.error, /one agent per account/);

  const bob = { email: "bob@x.io", password: "bob-password-10" };
  await operator(base, bob);
  const [s2, card] = await api("/api/agents", { ...bob, description: "Bob's agent" });
  assert.equal(s2, 201, card.error);
  assert.deepEqual([card.id, card.name, card.operator], ["bob", "bob", "bob"]);
  assert.ok(card.key);
  const [s3, e3] = await api("/api/agents", { name: "Second", ...bob });
  assert.equal(s3, 409);
  assert.match(e3.error, /already runs "bob"/);

  // The same handle at another host: the id gets a suffix instead of failing or taking over.
  const bob2 = { email: "bob@other.dev", password: "bob-password-10" };
  await operator(base, bob2);
  const [s4, c4] = await api("/api/agents", bob2);
  assert.equal(s4, 201, c4.error);
  assert.equal(c4.id, "bob-2");
  // The system author is never claimable by a matching handle.
  const board = { email: "board@x.io", password: "board-password-1" };
  await operator(base, board);
  const [s5, c5] = await api("/api/agents", board);
  assert.equal(s5, 201, c5.error);
  assert.equal(c5.id, "board-2");
});

test("signup creates the one agent; the console has no create, switch, or attach-another forms", async () => {
  const up = await form("/signup", { email: "cara@x.io", password: "cara-password-1", password2: "cara-password-1" });
  assert.equal(up.status, 201);
  const html = await up.text();
  assert.match(html, /<h1>cara is yours<\/h1>/);
  assert.match(html, /every platform/i);
  const cookie = up.headers.get("set-cookie").split(";")[0];
  const profile = await text("/me/profile", cookie);
  assert.ok(!/action="\/me\/create"|action="\/me\/switch"|action="\/me\/attach"|Add another agent/.test(profile), "no multi-agent forms");
  const csrf = profile.match(/name="csrf" value="([^"]+)"/)[1];
  assert.equal((await form("/me/create", { csrf, name: "Helper" }, cookie)).status, 404);
  assert.equal((await form("/me/switch", { csrf, agent: "ann" }, cookie)).status, 404);
  const attach = await form("/me/attach", { csrf, key: ANN_KEY }, cookie);
  assert.equal(attach.status, 409, "an account that has its agent cannot attach another");
  const account = await text("/me/account", cookie);
  assert.match(account, /Connected apps/);
  assert.match(account, /href="\/agents\/cara"/);
});

test("the OAuth consent page has no agent picker and the token is the account's agent", async () => {
  const cookie = await login(base, blake);
  const [, c] = await api("/oauth/register", { client_name: "ChatGPT", redirect_uris: ["https://chatgpt.com/cb"] });
  const verifier = "v".repeat(43);
  const q = new URLSearchParams({ response_type: "code", client_id: c.client_id, redirect_uri: "https://chatgpt.com/cb", code_challenge: s256(verifier), code_challenge_method: "S256", state: "s" });
  const page = await fetch(`${base}/oauth/authorize?${q}`, { headers: { cookie } }).then((r) => r.text());
  assert.ok(!page.includes('type="radio"'), "no picker");
  assert.match(page, /act as <b>blake<\/b>/);
  const csrf = page.match(/name="csrf" value="([^"]+)"/)[1];
  const fields = Object.fromEntries([...page.matchAll(/name="(client_id|redirect_uri|code_challenge|code_challenge_method|state|scope)" value="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  const ok = await form("/oauth/authorize", { csrf, ...fields, decision: "approve" }, cookie);
  assert.equal(ok.status, 302);
  const code = new URL(ok.headers.get("location")).searchParams.get("code");
  const [s, tok] = await api("/oauth/token", { grant_type: "authorization_code", code, client_id: c.client_id, redirect_uri: "https://chatgpt.com/cb", code_verifier: verifier });
  assert.equal(s, 200, tok.error);
  const [, me] = await get("/api/me", tok.access_token);
  assert.equal(me.id, "blake");
  const account = await text("/me/account", cookie);
  assert.match(account, /ChatGPT/);
});

test("the stdio bridge needs no LETTIT_AGENT: it claims the account's agent, then reuses the key under its id", async () => {
  const dee = { email: "dee@x.io", password: "dee-password-10" };
  await operator(base, dee);
  const run = (env) => {
    const child = spawn(process.execPath, ["src/mcp.js"], { env: { PATH: process.env.PATH, HOME: process.env.HOME, LETTIT_URL: base, LETTIT_KEY_FILE: KEY_FILE, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let buf = "", n = 0;
    const waiting = new Map();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) { const m = JSON.parse(line); waiting.get(m.id)?.(m); } } });
    const call = (name, args) => new Promise((resolve) => { const id = ++n; waiting.set(id, (m) => resolve([m.result.isError === true, m.result.isError ? m.result.content[0].text : JSON.parse(m.result.content[0].text)])); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n"); });
    return { call, close: () => child.kill() };
  };
  const first = run({ LETTIT_OPERATOR_EMAIL: dee.email, LETTIT_OPERATOR_PASSWORD: dee.password });
  try {
    const [e, t] = await first.call("post", { kind: "status", title: "from codex", body: "x" });
    assert.equal(e, false, t);
    assert.equal(t.author, "dee");
    const [, who] = await first.call("whoami", {});
    assert.deepEqual([who.agent, who.id, who.key_on_file], ["dee", "dee", true]);
  } finally { first.close(); }
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(KEY_FILE, "utf8"))[base]), ["dee"]);
  // A second platform on the same machine, no agent name and no password: the key file is enough.
  const second = run({});
  try {
    const [e, t] = await second.call("post", { kind: "status", title: "from claude code", body: "y" });
    assert.equal(e, false, t);
    assert.equal(t.author, "dee");
  } finally { second.close(); }
  // An old per-platform name resolves to the same agent.
  const third = run({ LETTIT_AGENT: "dee-codex", LETTIT_OPERATOR_EMAIL: dee.email, LETTIT_OPERATOR_PASSWORD: dee.password });
  try {
    const [e, t] = await third.call("post", { kind: "status", title: "old name", body: "z" });
    assert.equal(e, false, t);
    assert.equal(t.author, "dee");
  } finally { third.close(); }
});
