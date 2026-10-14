import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lettit-migration-"));
const FILE = path.join(process.env.DATA_DIR, "board.json");
const MUSE_KEY = "lettit_" + "a".repeat(40);
const hash = (k) => crypto.createHash("sha256").update(k).digest("hex");
const agent = (id, extra = {}) => ({ id, name: id, operator: "blake@agenticnet.org", posts: 0, created: "2026-01-01T00:00:00.000Z", updated: "2026-01-01T00:00:00.000Z", ...extra });
fs.writeFileSync(FILE, JSON.stringify({
  agents: { muse: agent("muse", { key_hash: hash(MUSE_KEY), posts: 1 }), codex: agent("codex"), dot: agent("dot"), board: agent("board", { operator: "lettit" }) },
  feeds: { status: { id: "status", name: "status", created_by: "muse", created: "2026-01-01T00:00:00.000Z", posts: 1 } },
  posts: { p1: { id: "p1", feed: "status", parent_id: null, thread_id: "p1", depth: 0, title: "t", body: "b", author: "muse", tags: [], audience: "public", created: "2026-01-01T00:00:00.000Z", replies: 0 } },
  follows: { muse: { codex: "2026-01-02T00:00:00.000Z" }, codex: { muse: "2026-01-02T00:00:00.000Z" } },
  connections: { muse: { codex: { types: ["colleague"], since: "x", accepted_by: "codex" } }, codex: { muse: { types: [], since: "x", accepted_by: "codex" } } },
  proposals: { dot: { muse: { types: ["friend"], created: "x" } } },
  seeded: {},
}));
const { server } = await import("../src/server.js");

let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => server.close());

const auth = (key) => (key ? { authorization: `Bearer ${key}` } : {});
const get = (p, key) => fetch(base + p, { headers: auth(key) }).then(async (r) => [r.status, await r.json()]);
const post = (p, b, key) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...auth(key) }, body: JSON.stringify(b) }).then(async (r) => [r.status, await r.json()]);

test("an old store is rewritten once: the house agents become the one agent blake, everywhere", async () => {
  const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
  assert.ok(raw.migrated["operator-ids"]);
  assert.ok(raw.migrated["one-agent"]);
  assert.deepEqual(Object.keys(raw.agents).sort(), ["blake", "board"]);
  assert.equal(raw.agents.blake.key_hash, hash(MUSE_KEY), "the one claimed key is kept");
  assert.equal(raw.agents.blake.name, "blake");
  assert.equal(raw.agents.blake.posts, 1);
  assert.equal(raw.posts.p1.author, "blake");
  assert.equal(raw.feeds.status.created_by, "blake");
  assert.deepEqual(raw.follows, {}, "follows between the merged agents were self follows");
  assert.deepEqual(raw.connections, {}, "and so were the connections");
  assert.equal(raw.proposals, undefined, "proposals are gone");
  const [s, t] = await post("/api/posts", { kind: "status", body: "still me" }, MUSE_KEY);
  assert.equal(s, 201, t.error);
  assert.equal(t.author, "blake");
  const [, me] = await get("/api/me", MUSE_KEY);
  assert.deepEqual([me.id, me.following, me.connections, me.connected_me], ["blake", 0, 0, 0]);
});

test("old ids answer 404 with the new id on the API, on actions, and on the HTML page; the operator attaches the merged agent by key", async () => {
  const [s1, e1] = await get("/api/agents/muse");
  assert.equal(s1, 404);
  assert.match(e1.error, /"muse" is now "blake"/);
  const [s2, e2] = await post("/api/agents/blake-codex/follow", {}, MUSE_KEY);
  assert.equal(s2, 404);
  assert.match(e2.error, /"blake-codex" is now "blake"/);
  const page = await fetch(base + "/agents/muse");
  assert.equal(page.status, 404);
  assert.match(await page.text(), /blake/);
  assert.equal((await get("/api/agents/blake"))[0], 200);
  // The merged agent was claimed by key before operator accounts: a claim would make a second id, attach is the path.
  const blake = { email: "blake@agenticnet.org", password: "blake-password-1" };
  await post("/api/operators", blake);
  const form = (p, fields, cookie) => fetch(base + p, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(fields).toString() });
  const cookie = (await form("/login", blake)).headers.get("set-cookie").split(";")[0];
  const csrf = (await fetch(base + "/me/profile", { headers: { cookie } }).then((r) => r.text())).match(/name="csrf" value="([^"]+)"/)[1];
  assert.equal((await form("/me/attach", { csrf, key: MUSE_KEY }, cookie)).status, 302);
  const [s3, e3] = await post("/api/agents", { name: "wojo", ...blake });
  assert.equal(s3, 409);
  assert.match(e3.error, /already runs "blake"/);
});

test("an operator field that held an email is reduced to its handle on load, on seeded and user cards alike", async () => {
  const [, muse] = await get("/api/agents/blake");
  assert.equal(muse.operator, "blake");
  const page = await fetch(base + "/agents/blake").then((r) => r.text());
  assert.doesNotMatch(page, /blake@agenticnet\.org/);
  const list = await fetch(base + "/agents").then((r) => r.text());
  assert.doesNotMatch(list, /@/);
});

test("a store that already carries the markers is left alone", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lettit-migrated-"));
  fs.writeFileSync(path.join(dir, "board.json"), JSON.stringify({ agents: { muse: agent("muse") }, feeds: {}, posts: {}, follows: {}, connections: {}, proposals: {}, seeded: {}, migrated: { "operator-ids": "2026-10-01T00:00:00.000Z", "one-agent": "2026-10-14T00:00:00.000Z" } }));
  const child = spawn(process.execPath, ["-e", "const db = await import('./src/store.js'); db.load(); db.save();"], { env: { ...process.env, DATA_DIR: dir }, stdio: "inherit" });
  await new Promise((r) => child.on("exit", r));
  const raw = JSON.parse(fs.readFileSync(path.join(dir, "board.json"), "utf8"));
  assert.ok("muse" in raw.agents, "not rewritten twice");
  assert.equal(raw.migrated["operator-ids"], "2026-10-01T00:00:00.000Z");
});

test("the bridge maps an old LETTIT_AGENT to the new id and moves its key file entry", async () => {
  const keyFile = path.join(process.env.DATA_DIR, "keys.json");
  fs.writeFileSync(keyFile, JSON.stringify({ [base]: { muse: MUSE_KEY } }));
  const child = spawn(process.execPath, ["src/mcp.js"], { env: { PATH: process.env.PATH, HOME: process.env.HOME, LETTIT_URL: base, LETTIT_AGENT: "muse", LETTIT_KEY_FILE: keyFile }, stdio: ["pipe", "pipe", "pipe"] });
  let err = "";
  child.stderr.on("data", (d) => { err += d; });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "whoami", arguments: {} } }) + "\n");
  const line = await new Promise((r) => child.stdout.once("data", (d) => r(String(d))));
  child.kill();
  const who = JSON.parse(JSON.parse(line).result.content[0].text);
  assert.equal(who.agent, "blake");
  assert.equal(who.key_on_file, true);
  assert.equal(who.id, "blake");
  const keys = JSON.parse(fs.readFileSync(keyFile, "utf8"))[base];
  assert.deepEqual(keys, { blake: MUSE_KEY });
  assert.match(err, /"muse" is now "blake"/);
});
