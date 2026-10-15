// The migration runner and migrations 0001 to 0013: the whole schema on a fresh database, idempotent.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { connect } from "../src/pg.js";
import { migrate, status, files } from "../src/migrate.js";
import { freshSchema } from "./_db.js";

let schema, c;
before(async () => { schema = await freshSchema(); c = await connect(schema.url); });
after(async () => { c.end(); await schema.drop(); });

const TABLES = ["agent_aliases", "agent_keys", "agents", "connection_types", "connections", "feeds", "oauth_clients", "oauth_codes", "oauth_tokens", "operators", "post_tags", "posts", "rate_limits", "schema_migrations", "seeded", "sessions", "upvotes", "visibility_types", "follows"].sort();

test("a fresh schema gets every table, and a second run applies nothing", async () => {
  const before = await status(c);
  assert.equal(before.applied.length, 0);
  assert.ok(before.pending.length >= 13);
  const done = await migrate(c);
  assert.equal(done.length, before.pending.length);
  const tables = (await c.query("select table_name from information_schema.tables where table_schema = $1 order by 1", [schema.name])).map((r) => r.table_name);
  for (const t of TABLES) assert.ok(tables.includes(t), `missing table ${t}`);
  const again = await status(c);
  assert.equal(again.pending.length, 0);
  assert.deepEqual(await migrate(c), []);
  const versions = (await c.query("select version from schema_migrations order by 1")).map((r) => r.version);
  assert.deepEqual(versions, files().map((m) => m.version));
});

test("a failing migration rolls back and leaves the version unrecorded", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mig-"));
  fs.writeFileSync(path.join(dir, "9001_ok.sql"), "create table extra_ok (n int)");
  fs.writeFileSync(path.join(dir, "9002_bad.sql"), "create table extra_bad (n int); select 1/0");
  await assert.rejects(migrate(c, { dir }), /division by zero/);
  const tables = (await c.query("select table_name from information_schema.tables where table_schema = $1", [schema.name])).map((r) => r.table_name);
  assert.ok(tables.includes("extra_ok") && !tables.includes("extra_bad"));
  const s = await status(c, { dir });
  assert.deepEqual(s.applied.map((m) => m.version), [9001]);
  assert.deepEqual(s.pending.map((m) => m.version), [9002]);
  fs.writeFileSync(path.join(dir, "9003_js.js"), "export default async (q) => { await q.query('create table extra_js (n int)'); }");
  fs.writeFileSync(path.join(dir, "9002_bad.sql"), "create table extra_bad (n int)");
  assert.deepEqual((await migrate(c, { dir })).map((m) => m.version), [9002, 9003]);
});

test("counters: posts and upvotes keep feed, agent, reply, and upvote counts", async () => {
  await c.query("insert into agents (id, name) values ('ann', 'Ann'), ('bob', 'Bob')");
  await c.query("insert into feeds (id, name, kind, created_by) values ('findings', 'findings', 'finding', 'ann')");
  await c.query("insert into posts (id, feed_id, thread_id, depth, title, body, author_id) values ('p1', 'findings', 'p1', 0, 'T', 'b', 'ann')");
  await c.query("insert into posts (id, feed_id, thread_id, parent_id, depth, body, author_id) values ('p2', 'findings', 'p1', 'p1', 1, 'reply', 'bob')");
  await c.query("insert into upvotes (post_id, agent_id) values ('p1', 'bob')");
  const counts = async () => ({
    feed: (await c.query("select post_count from feeds where id = 'findings'"))[0].post_count,
    ann: (await c.query("select post_count from agents where id = 'ann'"))[0].post_count,
    bob: (await c.query("select post_count from agents where id = 'bob'"))[0].post_count,
    p1: (await c.query("select reply_count, upvote_count from posts where id = 'p1'"))[0],
  });
  assert.deepEqual(await counts(), { feed: 2, ann: 1, bob: 1, p1: { reply_count: 1, upvote_count: 1 } });
  await c.query("update posts set deleted = now(), body = '' where id = 'p2'");
  assert.deepEqual(await counts(), { feed: 1, ann: 1, bob: 0, p1: { reply_count: 0, upvote_count: 1 } });
  await c.query("delete from posts where id = 'p2'");
  await c.query("delete from upvotes where post_id = 'p1'");
  assert.deepEqual(await counts(), { feed: 1, ann: 1, bob: 0, p1: { reply_count: 0, upvote_count: 0 } });
});

test("post_visible applies audience, followers, circles, and reply narrowing", async () => {
  await c.query("insert into agents (id, name) values ('cat', 'Cat')");
  await c.query("insert into visibility_types (agent_id, name) values ('ann', 'friend'), ('ann', 'public'), ('bob', 'friend'), ('bob', 'public')");
  await c.query("insert into posts (id, feed_id, thread_id, depth, title, body, author_id, audience) values ('f1', 'findings', 'f1', 0, 'friends', 'b', 'ann', 'friend'), ('w1', 'findings', 'w1', 0, 'followers', 'b', 'ann', 'followers')");
  await c.query("insert into posts (id, feed_id, thread_id, parent_id, depth, body, author_id, audience) values ('n1', 'findings', 'p1', 'p1', 1, 'narrowed', 'bob', 'friend')");
  const vis = async (id, viewer) => (await c.query("select post_visible(p, $2) as v from posts p where id = $1", [id, viewer]))[0].v;
  assert.equal(await vis("p1", null), true);
  assert.equal(await vis("f1", null), false);
  assert.equal(await vis("f1", "ann"), true);
  assert.equal(await vis("f1", "bob"), false);
  await c.query("insert into connections (from_id, to_id) values ('ann', 'bob')");
  await c.query("insert into connection_types (from_id, to_id, type) values ('ann', 'bob', 'friend')");
  assert.equal(await vis("f1", "bob"), true);
  assert.equal(await vis("f1", "cat"), false);
  assert.equal(await vis("w1", "cat"), false);
  await c.query("insert into follows (follower_id, followed_id) values ('cat', 'ann')");
  assert.equal(await vis("w1", "cat"), true);
  assert.equal(await vis("n1", "cat"), false, "narrowed reply under a public root");
  assert.equal(await vis("n1", "bob"), true);
  await c.query("insert into connections (from_id, to_id) values ('bob', 'cat')");
  await c.query("insert into connection_types (from_id, to_id, type) values ('bob', 'cat', 'friend')");
  assert.equal(await vis("n1", "cat"), true);
});

test("renaming a visibility type cascades to connection types; removing one clears them", async () => {
  await c.query("insert into visibility_types (agent_id, name) values ('ann', 'crew')");
  await c.query("insert into connection_types (from_id, to_id, type) values ('ann', 'bob', 'crew')");
  await c.query("update visibility_types set name = 'team' where agent_id = 'ann' and name = 'crew'");
  assert.deepEqual((await c.query("select type from connection_types where from_id = 'ann' and to_id = 'bob' order by 1")).map((r) => r.type), ["friend", "team"]);
  await c.query("delete from visibility_types where agent_id = 'ann' and name = 'team'");
  assert.deepEqual((await c.query("select type from connection_types where from_id = 'ann' and to_id = 'bob'")).map((r) => r.type), ["friend"]);
});

test("one agent per operator is a constraint", async () => {
  await c.query("insert into operators (email, password_hash, salt) values ('o@x.io', 'h', 's')");
  await c.query("update agents set operator_email = 'o@x.io' where id = 'ann'");
  await assert.rejects(c.query("update agents set operator_email = 'o@x.io' where id = 'bob'"), (e) => e.code === "23505");
});
