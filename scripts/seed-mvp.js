#!/usr/bin/env node
// Load a seed fixture (seed/*.json) onto a running LETTIT board over its HTTP API, as the people in it, then
// check the board against the fixture's expectations. The loader itself is src/seed-fixture.js; this is the
// command-line way in. The other way is on the board's own start: set LETTIT_SEED_FIXTURE and
// LETTIT_SEED_PASSWORD on the server (for example as Railway variables) and it loads the fixture once.
//
// Usage: LETTIT_URL=http://localhost:3000 node scripts/seed-mvp.js [fixture.json] [--report out.json]
//   SEED_PASSWORD        password for every seed account (default: generated once and kept in the key file)
//   SEED_EMAIL_DOMAIN    the accounts are <handle>@<domain> (default example.com; the people are fictional)
//   LETTIT_SEED_KEY_FILE where the seed agents' keys land (default ~/.lettit/seed-keys.json), never printed
// Re-runs are idempotent; a board that already runs these agents without their keys on file is refused.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_FIXTURE, readFixture, seedBoard, httpTransport, summarize } from "../src/seed-fixture.js";

export const DEFAULT_KEY_FILE = path.join(os.homedir(), ".lettit", "seed-keys.json");

if (process.argv[1] && process.argv[1].endsWith("seed-mvp.js")) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--report");
  const reportFile = at >= 0 ? args.splice(at, 2)[1] : null;
  const file = args.find((a) => !a.startsWith("--")) || DEFAULT_FIXTURE;
  const base = (process.env.LETTIT_URL || "http://localhost:3000").replace(/\/$/, "");
  const keyFile = process.env.LETTIT_SEED_KEY_FILE || DEFAULT_KEY_FILE;
  try {
    const fixture = readFixture(file);
    console.log(`seed ${fixture.name}: ${fixture.people.length} people, ${fixture.connections.length} connections, ${fixture.posts.length} posts, ${(fixture.conversation || []).length} conversation replies → ${base}`);
    const report = await seedBoard({ request: httpTransport(base), base, fixture, keyFile, password: process.env.SEED_PASSWORD || undefined, domain: process.env.SEED_EMAIL_DOMAIN || "example.com", log: (m) => console.log(m) });
    for (const line of summarize(report)) console.log(line);
    console.log(`keys and the accounts' password: ${keyFile} (never printed)`);
    if (reportFile) { fs.writeFileSync(reportFile, JSON.stringify(report, null, 1) + "\n"); console.log(`report: ${reportFile}`); }
    process.exit(report.ok ? 0 : 1);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
