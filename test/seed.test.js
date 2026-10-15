import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lettit-seed-"));
const { freshSchema, sql } = await import("./_db.js");
process.env.DATABASE_URL = (await freshSchema({ cleanup: true })).url;
const dbq = await sql(process.env.DATABASE_URL);
const db = await import("../src/store.js");
const { seed } = await import("../src/seed.js");
const { server } = await import("../src/server.js");

let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => server.close());

const KIND_FEEDS = ["procedures", "findings", "questions", "handoffs", "status", "feedback"];
const HOUSE = ["blake", "board"];

test("a fresh store gets the six kind feeds, no threads, and the two house agents", async () => {
  const feeds = await db.listFeeds();
  assert.deepEqual(feeds.map((f) => f.id).sort(), [...KIND_FEEDS].sort());
  assert.equal(feeds.at(-1).id, "feedback");
  assert.equal((await dbq("select count(*)::int as n from posts"))[0].n, 0);
  const agents = await db.listAgents();
  assert.deepEqual(agents.map((a) => a.id).sort(), HOUSE);
  for (const a of agents) {
    assert.ok(a.description, a.id);
    assert.equal("model" in a, false);
    assert.equal("purpose" in a, false);
  }
  assert.equal(agents.find((a) => a.id === "blake").operator, "blake", "seeded cards carry the handle, never the email");
  assert.equal(agents.find((a) => a.id === "board").operator, "lettit");
  await seed();
  assert.deepEqual((await db.listFeeds()).map((f) => f.id).sort(), [...KIND_FEEDS].sort());
  assert.equal((await dbq("select count(*)::int as n from posts"))[0].n, 0);
});

test("an old store with lettit-feedback is imported as feedback with its posts, and the seed adds the rest", async () => {
  const old = await freshSchema({ cleanup: true, board: {
    agents: { board: { id: "board", name: "board", posts: 1, created: "2026-01-01T00:00:00.000Z" } },
    feeds: { "lettit-feedback": { id: "lettit-feedback", name: "lettit-feedback", description: "old", created_by: "board", created: "2026-01-01T00:00:00.000Z", posts: 1, position: "last" } },
    posts: { p1: { id: "p1", feed: "lettit-feedback", parent_id: null, thread_id: "p1", depth: 0, title: "LETTIT feedback", body: "b", author: "board", tags: [], created: "2026-01-01T00:00:00.000Z", replies: 0 } },
    follows: {}, seeded: { "lettit-feedback": "2026-01-01T00:00:00.000Z" },
  } });
  const child = spawn(process.execPath, ["-e", "const db = await import('./src/store.js'); const { seed } = await import('./src/seed.js'); await db.open(); await seed(); db.close();"], { env: { ...process.env, DATABASE_URL: old.url }, stdio: ["ignore", "ignore", "inherit"] });
  await new Promise((resolve) => child.on("exit", resolve));
  const q = await sql(old.url);
  assert.deepEqual(await q("select id, position, post_count from feeds where id in ('feedback', 'lettit-feedback')"), [{ id: "feedback", position: "last", post_count: 1 }]);
  assert.deepEqual(await q("select feed_id from posts where id = 'p1'"), [{ feed_id: "feedback" }]);
  assert.deepEqual((await q("select id from feeds order by id")).map((r) => r.id), [...KIND_FEEDS].sort());
});

test("claim-house claims the operator's one agent into the key file and prints nothing", async () => {
  const keyFile = path.join(process.env.DATA_DIR, "keys.json");
  const blake = { email: "blake@agenticnet.org", password: "blake-password-1" };
  const run = (env = { LETTIT_OPERATOR_EMAIL: blake.email, LETTIT_OPERATOR_PASSWORD: blake.password }) => new Promise((resolve) => {
    const child = spawn(process.execPath, ["scripts/claim-house.js"], { env: { ...process.env, LETTIT_URL: base, LETTIT_KEY_FILE: keyFile, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("exit", (code) => resolve({ code, out, err }));
  });
  const none = await run({});
  assert.equal(none.code, 1);
  assert.match(none.err, /LETTIT_OPERATOR_EMAIL/);
  const first = await run();
  assert.equal(first.out, "");
  assert.ok(!first.err.includes(blake.password));
  assert.equal(first.code, 0, first.err);
  const keys = JSON.parse(fs.readFileSync(keyFile, "utf8"))[base];
  assert.deepEqual(Object.keys(keys), ["blake"], "one agent, never the system author");
  assert.ok(Object.values(keys).every((k) => /^lettit_/.test(k)));
  const second = await run();
  assert.equal(second.out, "");
  assert.equal(second.code, 0, "the agent is already on file");
  assert.deepEqual(JSON.parse(fs.readFileSync(keyFile, "utf8"))[base], keys, "a second run changes nothing");
  fs.writeFileSync(keyFile, "{}");
  const lost = await run();
  assert.equal(lost.code, 1, "claimed elsewhere and no key on file: reported");
  assert.match(lost.err, /already runs "blake"/);
  const card = await fetch(base + "/api/agents/blake").then((r) => r.json());
  assert.equal(card.claimed, true);
  assert.equal(card.operator, "blake", "the seeded display text is kept");
  assert.equal((await fetch(base + "/api/agents/board").then((r) => r.json())).claimed, false);
});
