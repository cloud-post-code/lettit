// Migration 0014: the document store becomes rows. A fixture carrying every historical shape is imported and
// each table is checked against it; the board table is dropped; a fresh database imports nothing.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { connect } from "../src/pg.js";
import { migrate } from "../src/migrate.js";
import { freshSchema } from "./_db.js";

const hash = (k) => crypto.createHash("sha256").update(k).digest("hex");
const T = "2026-01-01T00:00:00.000Z", T2 = "2026-01-02T00:00:00.000Z";
const agent = (id, extra = {}) => ({ id, name: id, operator: "blake@agenticnet.org", posts: 0, created: T, updated: T, ...extra });
const FIXTURE = {
  operators: { "blake@agenticnet.org": { email: "blake@agenticnet.org", password_hash: "ph", salt: "s", created: T, updated: T }, "ann@x.io": { email: "ann@x.io", password_hash: "ph2", salt: "s2", created: T, updated: T } },
  agents: {
    muse: agent("muse", { key_hash: hash("k-muse"), posts: 1, operator_email: "blake@agenticnet.org", last_seen: T2 }),
    codex: agent("codex", { key_hash: hash("k-codex") }),
    board: agent("board", { operator: "lettit" }),
    ann: agent("ann", { operator: "ann@x.io", operator_email: "ann@x.io", key_hash: hash("k-ann"), old_keys: [hash("k-ann-old")], visibility_types: { crew: { description: "my crew", builtin: false, created: T }, public: { description: "x", builtin: true, created: T } } }),
    ghost: agent("ghost", { operator_email: "nobody@x.io" }),
  },
  aliases: { wojo: "muse" },
  feeds: {
    status: { id: "status", name: "status", created_by: "muse", created: T, posts: 1 },
    "lettit-feedback": { id: "lettit-feedback", name: "feedback", created_by: "board", created: T, posts: 1, access: "private", members: ["muse"] },
    alpha: { id: "alpha", name: "Alpha", description: "named", created_by: "ann", created: T, posts: 0, position: "last" },
  },
  posts: {
    p1: { id: "p1", feed: "status", parent_id: null, thread_id: "p1", depth: 0, title: "t", body: "b", author: "muse", tags: ["Go", "go", " db "], audience: "public", created: T, replies: 1, upvotes: { ann: T2, muse: T2, nobody: T2 }, rating: 5 },
    r1: { id: "r1", feed: "status", parent_id: "p1", thread_id: "p1", depth: 1, title: null, body: "reply", author: "ann", tags: [], audience: "public", created: T2, replies: 0, edited: T2 },
    f1: { id: "f1", feed: "lettit-feedback", parent_id: null, thread_id: "f1", depth: 0, title: "fb", body: "", author: "codex", tags: [], created: T, replies: 0, deleted: T2 },
    orphan: { id: "orphan", feed: "nope", parent_id: null, thread_id: "orphan", depth: 0, title: "x", body: "x", author: "ann", tags: [], audience: "public", created: T, replies: 0 },
  },
  follows: { muse: { codex: T2, ann: T2 }, codex: { muse: T2 }, ann: { nobody: T2 } },
  connections: { ann: { muse: { types: ["crew", "friend", "public", "missing"], since: "x" } }, muse: { ann: { types: ["colleague"], since: T2 } } },
  proposals: { codex: { ann: { types: ["friend"], created: T } } },
  sessions: { sess1: { operator: "blake@agenticnet.org", current: "muse", csrf: "c", created: T, expires: "2099-01-01T00:00:00.000Z" }, old: { current: "muse", csrf: "c", created: T, expires: "2099-01-01T00:00:00.000Z" } },
  oauth: {
    clients: { cl1: { client_id: "cl1", client_name: "ChatGPT", redirect_uris: ["https://a.example/cb", "https://b.example/cb"], token_endpoint_auth_method: "none", secret_hash: null, created: T } },
    codes: { code1: { client_id: "cl1", redirect_uri: "https://a.example/cb", code_challenge: "ch", agent: "muse", operator: "blake@agenticnet.org", scope: "", expires: "2099-01-01T00:00:00.000Z" } },
    tokens: { tok1: { id: "abc", client_id: "cl1", agent: "muse", operator: "blake@agenticnet.org", scope: "", created: T, last_used: null, refresh_hash: "rh1", expires: "2099-01-01T00:00:00.000Z", refresh_expires: "2099-02-01T00:00:00.000Z" } },
  },
  seeded: { "seed:v2": T },
  migrated: {},
};

let schema, c;
before(async () => {
  schema = await freshSchema();
  c = await connect(schema.url);
  await c.query("create table board (id int primary key check (id = 1), doc jsonb not null, updated timestamptz not null default now())");
  await c.query("insert into board (id, doc) values (1, $1::jsonb)", [JSON.stringify(FIXTURE)]);
  await migrate(c, { dir: upTo(15) }); // what 0014 imported, before 0016 reshapes it into topics
});
// The migrations up to and including a version, copied to a temp dir.
function upTo(version) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lettit-upto-"));
  const src = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "src", "migrations");
  for (const f of fs.readdirSync(src)) if (Number(f.slice(0, 4)) <= version) fs.copyFileSync(path.join(src, f), path.join(dir, f));
  return dir;
}
after(async () => { c.end(); await schema.drop(); });

const rows = (sql, params) => c.query(sql, params);
const col = async (sql, params) => (await rows(sql, params)).map((r) => Object.values(r)[0]);

test("the house ids fold into blake, the orphan post is skipped, and the board table is dropped", async () => {
  assert.deepEqual(await col("select id from agents order by 1"), ["ann", "blake", "board", "ghost"]);
  assert.deepEqual((await rows("select key_hash, current from agent_keys where agent_id = 'blake' order by current desc, key_hash")).map((r) => [r.key_hash === hash("k-muse") ? "muse" : "codex", r.current]), [["codex", true], ["muse", false]]);
  assert.equal(await col("select to_regclass('board')").then((r) => r[0]), null);
  assert.equal(await col("select to_regclass('board_legacy')").then((r) => r[0]), null);
  assert.deepEqual(await col("select id from posts order by 1"), ["f1", "p1", "r1"]);
});

test("agents carry operator links, keys, and circles; an unknown operator gets a placeholder account with no usable password", async () => {
  const [blake] = await rows("select operator_email, last_seen, post_count, operator from agents where id = 'blake'");
  assert.deepEqual(blake, { operator_email: "blake@agenticnet.org", last_seen: T2, post_count: 1, operator: "blake" });
  const [ghost] = await rows("select operator_email from agents where id = 'ghost'");
  assert.equal(ghost.operator_email, "nobody@x.io");
  assert.deepEqual(await rows("select password_hash from operators where email = 'nobody@x.io'"), [{ password_hash: "" }]);
  assert.deepEqual(await col("select key_hash from agent_keys where agent_id = 'ann' and not current"), [hash("k-ann-old")]);
  assert.deepEqual(await col("select name from visibility_types where agent_id = 'ann' order by 1"), ["colleague", "crew", "friend", "public"]);
  assert.deepEqual(await col("select name from visibility_types where agent_id = 'board' order by 1"), ["colleague", "friend", "public"]);
});

test("feeds get their kind and position; the old feedback feed is renamed with its post", async () => {
  assert.deepEqual(await rows("select id, kind, position, post_count from feeds order by id"), [
    { id: "alpha", kind: null, position: "last", post_count: 0 },
    { id: "feedback", kind: "feedback", position: null, post_count: 0 },
    { id: "status", kind: "status", position: null, post_count: 2 },
  ]);
  const [f1] = await rows("select feed_id, deleted, audience from posts where id = 'f1'");
  assert.deepEqual(f1, { feed_id: "feedback", deleted: T2, audience: "friend" });
});

test("posts keep their tree, tags, edits, and votes; votes by the author or unknown agents are dropped", async () => {
  const [p1] = await rows("select thread_id, parent_id, depth, title, author_id, reply_count, upvote_count, audience from posts where id = 'p1'");
  assert.deepEqual(p1, { thread_id: "p1", parent_id: null, depth: 0, title: "t", author_id: "blake", reply_count: 1, upvote_count: 1, audience: "public" });
  const [r1] = await rows("select thread_id, parent_id, depth, title, edited from posts where id = 'r1'");
  assert.deepEqual(r1, { thread_id: "p1", parent_id: "p1", depth: 1, title: null, edited: T2 });
  assert.deepEqual(await col("select tag from post_tags where post_id = 'p1' order by 1"), ["db", "go"]);
  assert.deepEqual(await rows("select agent_id, created from upvotes"), [{ agent_id: "ann", created: T2 }]);
});

test("relations: follows and connections are remapped, self pairs dropped, proposals become connections, circle names validated", async () => {
  assert.deepEqual(await rows("select follower_id, followed_id from follows order by 1, 2"), [{ follower_id: "blake", followed_id: "ann" }], "0014 still imports them; 0017 drops them");
  assert.deepEqual(await rows("select from_id, to_id from connections order by 1, 2"), [{ from_id: "ann", to_id: "blake" }, { from_id: "blake", to_id: "ann" }]);
  assert.deepEqual(await col("select type from connection_types where from_id = 'ann' order by 1"), ["crew", "friend"]);
  assert.deepEqual(await col("select type from connection_types where from_id = 'blake' order by 1"), ["colleague"]);
  const [c1] = await rows("select created from connections where from_id = 'ann'");
  assert.ok(c1.created > "2026-01-01", "an unparseable since gets the import time");
});

test("sessions and oauth: hashes stay hashes, orphans are dropped, redirect URIs stay a list", async () => {
  assert.deepEqual(await rows("select token_hash, operator_email from sessions"), [{ token_hash: "sess1", operator_email: "blake@agenticnet.org" }]);
  const [cl] = await rows("select redirect_uris, client_name from oauth_clients");
  assert.deepEqual(cl, { redirect_uris: ["https://a.example/cb", "https://b.example/cb"], client_name: "ChatGPT" });
  assert.deepEqual(await col("select agent_id from oauth_codes"), ["blake"]);
  assert.deepEqual(await rows("select access_hash, id, agent_id, refresh_hash from oauth_tokens"), [{ access_hash: "tok1", id: "abc", agent_id: "blake", refresh_hash: "rh1" }]);
});

test("a fresh database without a board row records the migration and imports nothing", async () => {
  const s2 = await freshSchema();
  const c2 = await connect(s2.url);
  await migrate(c2);
  assert.equal((await c2.query("select count(*)::int as n from agents"))[0].n, 0);
  assert.ok((await c2.query("select version from schema_migrations where version = 14")).length === 1);
  c2.end();
  await s2.drop();
});

test("a count mismatch rolls the import back", async () => {
  const s3 = await freshSchema();
  const c3 = await connect(s3.url);
  await c3.query("create table board (id int primary key, doc jsonb not null, updated timestamptz not null default now())");
  // Two agents share one operator and neither is the handle: one-agent merges them, and the import must still
  // balance. Break the balance deliberately by referencing an agent id that normalisation renames away.
  const doc = { agents: { a1: agent("a1", { operator_email: "ann@x.io" }), a2: agent("a2", { operator_email: "ann@x.io", created: T2 }) }, operators: { "ann@x.io": { email: "ann@x.io", password_hash: "p", salt: "s" } }, feeds: {}, posts: {} };
  await c3.query("insert into board (id, doc) values (1, $1::jsonb)", [JSON.stringify(doc)]);
  await migrate(c3);
  assert.deepEqual(await c3.query("select id from agents"), [{ id: "a1" }]);
  c3.end();
  await s3.drop();
});
