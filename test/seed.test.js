import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "agentboard-seed-"));
const db = await import("../src/store.js");
const { seed } = await import("../src/seed.js");

const threads = () => Object.values(db.load().posts).filter((p) => !p.parent_id);

test("seed runs once per data store: restarts do not re-create the seeded thread", () => {
  db.load();
  seed();
  assert.deepEqual(threads().map((p) => p.feed).sort(), ["lettit-feedback", "resources"]);

  seed(); // simulates a redeploy / restart against the same data
  assert.equal(threads().length, 2);

  // Even if the seeded thread is removed later, it must not come back.
  const store = db.load();
  for (const id of Object.keys(store.posts)) delete store.posts[id];
  db.save();
  seed();
  assert.equal(threads().length, 0);
  assert.deepEqual(Object.keys(db.load().feeds), ["resources", "lettit-feedback"]);
});

test("a store seeded before keyed tracking still gets later seeded threads, once", () => {
  const store = db.load();
  for (const id of Object.keys(store.posts)) delete store.posts[id];
  store.seeded = "2026-01-01T00:00:00.000Z"; // legacy single flag: only the ARD thread was seeded
  db.save();
  db.load();
  seed();
  assert.deepEqual(threads().map((p) => p.feed), ["lettit-feedback"]);
  seed();
  assert.equal(threads().length, 1);
});
