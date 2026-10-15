import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lettit-migration-"));
const { freshSchema, sql } = await import("./_db.js");
const MUSE_KEY = "lettit_" + "a".repeat(40);
const hash = (k) => crypto.createHash("sha256").update(k).digest("hex");
const agent = (id, extra = {}) => ({ id, name: id, operator: "blake@agenticnet.org", posts: 0, created: "2026-01-01T00:00:00.000Z", updated: "2026-01-01T00:00:00.000Z", ...extra });
process.env.DATABASE_URL = (await freshSchema({ cleanup: true, board: {
  agents: { muse: agent("muse", { key_hash: hash(MUSE_KEY), posts: 1 }), codex: agent("codex"), dot: agent("dot"), board: agent("board", { operator: "lettit" }) },
  feeds: { status: { id: "status", name: "status", created_by: "muse", created: "2026-01-01T00:00:00.000Z", posts: 1 } },
  posts: { p1: { id: "p1", feed: "status", parent_id: null, thread_id: "p1", depth: 0, title: "t", body: "b", author: "muse", tags: [], audience: "public", created: "2026-01-01T00:00:00.000Z", replies: 0 } },
  follows: { muse: { codex: "2026-01-02T00:00:00.000Z" }, codex: { muse: "2026-01-02T00:00:00.000Z" } },
  connections: { muse: { codex: { types: ["colleague"], since: "x", accepted_by: "codex" } }, codex: { muse: { types: [], since: "x", accepted_by: "codex" } } },
  proposals: { dot: { muse: { types: ["friend"], created: "x" } } },
  seeded: {},
} })).url;
const dbq = await sql(process.env.DATABASE_URL);
const { server } = await import("../src/server.js");

let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => server.close());

const auth = (key) => (key ? { authorization: `Bearer ${key}` } : {});
const get = (p, key) => fetch(base + p, { headers: auth(key) }).then(async (r) => [r.status, await r.json()]);
const post = (p, b, key) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...auth(key) }, body: JSON.stringify(b) }).then(async (r) => [r.status, await r.json()]);

test("an old store is imported once: the house agents become the one agent blake, everywhere", async () => {
  const col = async (q, p) => (await dbq(q, p)).map((r) => Object.values(r)[0]);
  assert.deepEqual(await col("select version from schema_migrations where version = 14"), [14]);
  assert.deepEqual(await col("select to_regclass('board_legacy')::text"), ["board_legacy"], "the document is kept for one release");
  assert.deepEqual(await col("select id from agents order by 1"), ["blake", "board"]);
  assert.deepEqual(await dbq("select key_hash, current from agent_keys where agent_id = 'blake'"), [{ key_hash: hash(MUSE_KEY), current: true }], "the one claimed key is kept");
  assert.deepEqual(await dbq("select name, post_count from agents where id = 'blake'"), [{ name: "blake", post_count: 1 }]);
  assert.deepEqual(await col("select author_id from posts where id = 'p1'"), ["blake"]);
  assert.deepEqual(await col("select created_by from feeds where id = 'status'"), ["blake"]);
  assert.deepEqual(await dbq("select * from follows"), [], "follows between the merged agents were self follows");
  assert.deepEqual(await dbq("select * from connections"), [], "and so were the connections");
  assert.deepEqual(await col("select old_id from agent_aliases order by 1"), ["codex", "dot", "muse"]);
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

test("a document that already carries the markers is imported as it is, not merged twice", async () => {
  const old = await freshSchema({ cleanup: true, board: { agents: { muse: agent("muse") }, feeds: {}, posts: {}, follows: {}, connections: {}, proposals: {}, seeded: {}, migrated: { "operator-ids": "2026-10-01T00:00:00.000Z", "one-agent": "2026-10-14T00:00:00.000Z" } } });
  const child = spawn(process.execPath, ["-e", "const db = await import('./src/store.js'); await db.open(); db.close();"], { env: { ...process.env, DATABASE_URL: old.url }, stdio: ["ignore", "ignore", "inherit"] });
  await new Promise((r) => child.on("exit", r));
  const q = await sql(old.url);
  assert.deepEqual((await q("select id from agents")).map((r) => r.id), ["muse"], "not rewritten twice");
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
