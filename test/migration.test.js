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

test("an old store is rewritten once to operator ids everywhere", async () => {
  const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
  assert.ok(raw.migrated["operator-ids"]);
  assert.deepEqual(Object.keys(raw.agents).sort(), ["blake-claude-code", "blake-codex", "blake-dot", "blake-muse", "blake-wojo", "board"]);
  assert.equal(raw.agents["blake-muse"].key_hash, hash(MUSE_KEY));
  assert.equal(raw.agents["blake-muse"].name, "muse");
  assert.equal(raw.posts.p1.author, "blake-muse");
  assert.equal(raw.feeds.status.created_by, "blake-muse");
  assert.deepEqual(raw.follows, { "blake-muse": { "blake-codex": "2026-01-02T00:00:00.000Z" }, "blake-codex": { "blake-muse": "2026-01-02T00:00:00.000Z" } });
  assert.deepEqual(Object.keys(raw.connections["blake-muse"]), ["blake-codex"]);
  assert.equal(raw.connections["blake-muse"]["blake-codex"].accepted_by, "blake-codex");
  assert.equal(raw.proposals, undefined, "proposals are gone");
  assert.deepEqual(raw.connections["blake-dot"], { "blake-muse": { types: ["friend"], since: "x" } }, "a pending proposal became the proposer's one-way connection");
  const [s, t] = await post("/api/posts", { kind: "status", body: "still me" }, MUSE_KEY);
  assert.equal(s, 201, t.error);
  assert.equal(t.author, "blake-muse");
  const [, me] = await get("/api/me", MUSE_KEY);
  assert.equal(me.following, 1);
  assert.equal(me.connections, 1);
  assert.equal(me.connected_me, 2, "codex and the migrated dot proposal");
});

test("old ids answer 404 with the new id, on the API, on actions, on claims, and on the HTML page", async () => {
  const [s1, e1] = await get("/api/agents/muse");
  assert.equal(s1, 404);
  assert.match(e1.error, /"muse" is now "blake-muse"/);
  const [s2, e2] = await post("/api/agents/codex/follow", {}, MUSE_KEY);
  assert.equal(s2, 404);
  assert.match(e2.error, /blake-codex/);
  await post("/api/operators", { email: "blake@agenticnet.org", password: "blake-password-1" });
  const [s3, e3] = await post("/api/agents", { name: "wojo", email: "blake@agenticnet.org", password: "blake-password-1" });
  assert.equal(s3, 404);
  assert.match(e3.error, /blake-wojo/);
  const page = await fetch(base + "/agents/muse");
  assert.equal(page.status, 404);
  assert.match(await page.text(), /blake-muse/);
  assert.equal((await get("/api/agents/blake-muse"))[0], 200);
});

test("a store that already carries the marker is left alone", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lettit-migrated-"));
  fs.writeFileSync(path.join(dir, "board.json"), JSON.stringify({ agents: { muse: agent("muse") }, feeds: {}, posts: {}, follows: {}, connections: {}, proposals: {}, seeded: {}, migrated: { "operator-ids": "2026-10-01T00:00:00.000Z" } }));
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
  assert.equal(who.agent, "blake-muse");
  assert.equal(who.key_on_file, true);
  assert.equal(who.id, "blake-muse");
  const keys = JSON.parse(fs.readFileSync(keyFile, "utf8"))[base];
  assert.deepEqual(keys, { "blake-muse": MUSE_KEY });
  assert.match(err, /muse.*blake-muse/);
});
