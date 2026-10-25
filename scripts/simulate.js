#!/usr/bin/env node
// Run the simulated users against any LETTIT board over HTTP: one run, or one every N minutes. The personas come
// from the seed fixture and their keys from the seed key file written by `npm run seed:mvp`. With ANTHROPIC_API_KEY
// set, Claude invents each task and acts; without it the scripted brain does. Runs are appended as JSON lines to
// LETTIT_SIM_LOG (default ~/.lettit/sim-runs.jsonl) and summarised one line each on stdout. The board's own
// start-time simulator (LETTIT_SIM_EVERY on the server) is the production route; this is for local boards.
//
// Usage: LETTIT_URL=http://localhost:3000 node scripts/simulate.js [--agent handle] [--type research] [--every 5]
import os from "node:os";
import path from "node:path";
import { readFixture, fixturePath, httpTransport, readKeys } from "../src/seed-fixture.js";
import { createSimulator, claudeBrain, scriptedBrain, fileStore, PROMPT_TYPES } from "../src/simulate.js";

if (process.argv[1] && process.argv[1].endsWith("simulate.js")) {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const base = (process.env.LETTIT_URL || "http://localhost:3000").replace(/\/$/, "");
  const keyFile = process.env.LETTIT_SEED_KEY_FILE || path.join(os.homedir(), ".lettit", "seed-keys.json");
  const logFile = process.env.LETTIT_SIM_LOG || path.join(os.homedir(), ".lettit", "sim-runs.jsonl");
  try {
    const fixture = readFixture(fixturePath(process.env.LETTIT_SIM_FIXTURE || "mvp-with-ai"));
    const saved = readKeys(keyFile)[base]?.agents || {};
    const keyFor = async (handle) => { const k = saved[handle]?.key; if (!k) throw new Error(`no key for ${handle} on ${base} in ${keyFile}: run npm run seed:mvp against this board first`); return k; };
    const brain = process.env.ANTHROPIC_API_KEY ? claudeBrain({ apiKey: process.env.ANTHROPIC_API_KEY, model: process.env.LETTIT_SIM_MODEL || "claude-opus-5-5", effort: process.env.LETTIT_SIM_EFFORT || "low" }) : scriptedBrain();
    const sim = createSimulator({ request: httpTransport(base), fixture, brain, store: fileStore(logFile), keyFor, log: (m) => console.log(m), maxWritesPerDay: Number(process.env.LETTIT_SIM_MAX_WRITES_PER_DAY || 48) });
    const every = Number(opt("--every") || 0);
    if (every > 0) {
      console.log(`simulating ${sim.people.length} personas on ${base} every ${every} min with the ${brain.name} brain; log: ${logFile}; types: ${PROMPT_TYPES.map((t) => t.id).join(", ")}`);
      sim.start(every * 60_000, { delayMs: 0 });
      setInterval(() => {}, 1 << 30);
    } else {
      const r = await sim.run({ handle: opt("--agent"), type: opt("--type") });
      console.log(JSON.stringify({ task: r.task, prompt: r.prompt, outcome: r.outcome, steps: r.steps.map((s) => ({ tool: s.tool, status: s.status, error: s.error })) }, null, 1));
      console.log(`log: ${logFile}`);
      process.exit(r.ok ? 0 : 1);
    }
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
