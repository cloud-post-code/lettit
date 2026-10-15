import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claimCard, operator, credsOf } from "./_operators.js";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lettit-nofollow-"));
const { freshSchema, sql } = await import("./_db.js");
// A pre-existing store from the follows era: fan follows host, who wrote to followers; lurker follows quiet,
// who never did.
const at = "2026-01-01T00:00:00.000Z";
const agent = (id) => ({ id, name: id, operator: id, posts: 0, created: at });
process.env.DATABASE_URL = (await freshSchema({ cleanup: true, board: {
  agents: { host: agent("host"), fan: agent("fan"), quiet: agent("quiet"), lurker: agent("lurker") },
  feeds: { status: { id: "status", name: "status", created_by: "host", created: at, posts: 2 } },
  posts: {
    w: { id: "w", feed: "status", parent_id: null, thread_id: "w", depth: 0, title: "whisper", body: "quiet words", author: "host", audience: "followers", created: at, replies: 0 },
    q: { id: "q", feed: "status", parent_id: null, thread_id: "q", depth: 0, title: "open", body: "loud words", author: "quiet", created: at, replies: 0 },
  },
  follows: { fan: { host: at }, lurker: { quiet: at } },
} })).url;
const dbq = await sql(process.env.DATABASE_URL);
const { server } = await import("../src/server.js");

let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => server.close());

const auth = (key) => (key ? { authorization: `Bearer ${key}` } : {});
const get = (p, key) => fetch(base + p, { headers: auth(key) }).then(async (r) => [r.status, await r.json().catch(() => null)]);
const post = (p, b, key) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...auth(key) }, body: JSON.stringify(b) }).then(async (r) => [r.status, await r.json().catch(() => null)]);
const claim = async (name) => (await claimCard(base, { name }))[1].key;
const topic = { category: "coding", topic: "general", topic_description: "Test topic." };

test("the migration turns followers posts into a circle and drops the follows table", async () => {
  assert.equal((await dbq("select to_regclass('follows') as t"))[0].t, null);
  const circle = await dbq("select builtin from visibility_types where agent_id = 'host' and name = 'followers'");
  assert.deepEqual(circle.map((r) => r.builtin), [false], "host's followers posts now go to a custom circle");
  assert.deepEqual(await dbq("select to_id, type from connection_types where from_id = 'host'"), [{ to_id: "fan", type: "followers" }]);
  const seen = async (viewer) => (await dbq("select post_visible(p, $1) as ok from posts p where p.id = 'w'", [viewer]))[0].ok;
  assert.equal(await seen("fan"), true, "the former follower still reads the post");
  assert.equal(await seen("lurker"), false);
  assert.deepEqual(await dbq("select 1 from connections where from_id = 'quiet'"), [], "no followers posts, no circle");
  assert.deepEqual(await dbq("select 1 from visibility_types where agent_id = 'quiet' and name = 'followers'"), []);
  const fn = (await dbq("select prosrc from pg_proc where proname = 'audience_ok' and pronamespace = current_schema()::regnamespace"))[0].prosrc;
  assert.doesNotMatch(fn, /follow/);
});

test("follow routes, fields, and the followers audience are gone", async () => {
  const ann = await claim("Ann");
  await claim("Ben");
  assert.equal((await post("/api/agents/t-ben/follow", {}, ann))[0], 404);
  assert.equal((await post("/api/agents/t-ben/unfollow", {}, ann))[0], 404);
  assert.equal((await get("/api/me/following", ann))[0], 404);
  assert.equal((await get("/api/me/followers", ann))[0], 404);
  const [, me] = await get("/api/me", ann);
  for (const k of ["following", "followers"]) assert.ok(!(k in me), `/api/me has no ${k}`);
  assert.ok(!("followers" in me.authority_breakdown));
  const [, ben] = await get("/api/agents/t-ben", ann);
  for (const k of ["i_follow", "follows_me"]) assert.ok(!(k in ben.relationship), `relationship has no ${k}`);
  const [, inbox] = await get("/api/me/inbox?peek=true", ann);
  assert.ok(!("followers" in inbox));
  const [s, e] = await post("/api/posts", { ...topic, title: "x", body: "y", audience: "followers" }, ann);
  assert.equal(s, 400);
  assert.doesNotMatch(e.error, /follow/i);
});

test("the MCP tools offer no way to follow", async () => {
  const key = await claim("Cat");
  const r = await fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...auth(key) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  const { tools } = (await r.json()).result;
  const names = tools.map((t) => t.name);
  for (const n of ["follow_agent", "unfollow_agent", "following", "followers"]) assert.ok(!names.includes(n), `no ${n} tool`);
  assert.doesNotMatch(JSON.stringify(tools), /follow/i);
});

test("signing up from a scanned card connects nobody and links to the card", async () => {
  await claim("Dee");
  const r = await fetch(base + "/connect/t-dee", { redirect: "manual" });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("location"), "/signup?card=t-dee");
  const form = await fetch(base + "/signup?card=t-dee").then((x) => x.text());
  assert.doesNotMatch(form, /follow/i);
  const creds = credsOf("Eve");
  const body = new URLSearchParams({ ...creds, password2: creds.password, card: "t-dee" }).toString();
  const made = await fetch(base + "/signup", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  assert.equal(made.status, 201);
  const page = await made.text();
  assert.match(page, /href="\/connect\/t-dee"/);
  assert.doesNotMatch(page, /follow/i);
  assert.deepEqual(await dbq("select 1 from connections where from_id = 't-eve' or to_id = 't-eve'"), []);
  await operator(base, creds);
});

test("no source file, prompt, or doc mentions following", () => {
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
  const history = /^src\/migrations\/(0007|0013|0014|0017)_/;
  const walk = (dir) => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
  const files = [...walk("src"), ...walk("agents"), "README.md", "AGENTS.md"].filter((f) => !history.test(f));
  const hits = files.filter((f) => /follow/i.test(fs.readFileSync(path.join(root, f), "utf8")));
  assert.deepEqual(hits, []);
});
