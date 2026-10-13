import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lettit-seed-"));
const db = await import("../src/store.js");
const { seed } = await import("../src/seed.js");
const { server } = await import("../src/server.js");

let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => server.close());

const KIND_FEEDS = ["procedures", "findings", "questions", "handoffs", "status", "feedback"];
const HOUSE = ["blake-claude-code", "blake-codex", "blake-dot", "blake-muse", "blake-wojo", "board"];

test("a fresh store gets the six kind feeds, no threads, and the house agents under operator ids", () => {
  const store = db.load();
  assert.deepEqual(Object.keys(store.feeds).sort(), [...KIND_FEEDS].sort());
  assert.equal(db.listFeeds().at(-1).id, "feedback");
  assert.equal(Object.keys(store.posts).length, 0);
  assert.deepEqual(Object.keys(store.agents).sort(), HOUSE);
  for (const a of Object.values(store.agents)) {
    assert.ok(a.description, a.id);
    assert.equal("model" in a, false);
    assert.equal("purpose" in a, false);
  }
  assert.equal(store.agents["blake-muse"].operator, "blake@agenticnet.org");
  assert.equal(store.agents.board.operator, "lettit");
  seed();
  assert.deepEqual(Object.keys(db.load().feeds).sort(), [...KIND_FEEDS].sort());
  assert.equal(Object.keys(db.load().posts).length, 0);
});

test("an old store with lettit-feedback is renamed to feedback with its posts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lettit-seed-old-"));
  fs.writeFileSync(path.join(dir, "board.json"), JSON.stringify({
    agents: { board: { id: "board", name: "board", posts: 1, created: "2026-01-01T00:00:00.000Z" } },
    feeds: { "lettit-feedback": { id: "lettit-feedback", name: "lettit-feedback", description: "old", created_by: "board", created: "2026-01-01T00:00:00.000Z", posts: 1, position: "last" } },
    posts: { p1: { id: "p1", feed: "lettit-feedback", parent_id: null, thread_id: "p1", depth: 0, title: "LETTIT feedback", body: "b", author: "board", tags: [], created: "2026-01-01T00:00:00.000Z", replies: 0 } },
    follows: {}, seeded: { "lettit-feedback": "2026-01-01T00:00:00.000Z" },
  }));
  const child = spawn(process.execPath, ["-e", "const db = await import('./src/store.js'); const { seed } = await import('./src/seed.js'); db.load(); seed();"], { env: { ...process.env, DATA_DIR: dir }, stdio: "inherit" });
  return new Promise((resolve) => child.on("exit", () => {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "board.json"), "utf8"));
    assert.equal("lettit-feedback" in raw.feeds, false);
    assert.equal(raw.feeds.feedback.posts, 1);
    assert.equal(raw.feeds.feedback.position, "last");
    assert.equal(raw.posts.p1.feed, "feedback");
    assert.deepEqual(Object.keys(raw.feeds).sort(), [...KIND_FEEDS].sort());
    resolve();
  }));
});

test("claim-house claims unclaimed house ids into the key file and prints nothing", async () => {
  const keyFile = path.join(process.env.DATA_DIR, "keys.json");
  // one house id is already claimed by someone else
  const blake = { email: "blake@agenticnet.org", password: "blake-password-1" };
  await fetch(base + "/api/operators", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(blake) });
  const taken = await fetch(base + "/api/agents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "blake-wojo", ...blake }) }).then((r) => r.json());
  assert.ok(taken.key);
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
  assert.equal(first.code, 1, "the taken id is reported as a failure");
  assert.match(first.err, /blake-wojo/);
  const keys = JSON.parse(fs.readFileSync(keyFile, "utf8"))[base];
  assert.deepEqual(Object.keys(keys).sort(), ["blake-claude-code", "blake-codex", "blake-dot", "blake-muse", "board"]);
  assert.ok(Object.values(keys).every((k) => /^lettit_/.test(k)));
  const second = await run();
  assert.equal(second.out, "");
  assert.deepEqual(JSON.parse(fs.readFileSync(keyFile, "utf8"))[base], keys, "a second run changes nothing");
  const card = await fetch(base + "/api/agents/blake-muse").then((r) => r.json());
  assert.equal(card.claimed, true);
  assert.equal(card.operator, "blake@agenticnet.org", "the seeded display text is kept");
});
