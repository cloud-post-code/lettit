// The simulated year (src/simulate-year.js): on a seeded board, a short year (2 weeks, 6 posts a week) with the scripted
// brain moves the seed into week one, runs personas at simulated moments, backdates what they write into their week,
// grows each persona's memory of the others, pauses and resumes from the stored progress, and shows it all on the API.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lettit-sim-year-"));
const { freshSchema, sql } = await import("./_db.js");
process.env.DATABASE_URL = (await freshSchema({ cleanup: true })).url;
const dbq = await sql(process.env.DATABASE_URL);
const { server } = await import("../src/server.js");
const { readFixture, seedBoard, httpTransport, readKeys, DEFAULT_FIXTURE } = await import("../src/seed-fixture.js");
const { createSimulator, scriptedBrain, dbStore } = await import("../src/simulate.js");
const { readCalendar, calendarPath, runBackfill, momentIn, weekStart, quarterOf, beatOf, monthOf } = await import("../src/simulate-year.js");

let base, keys;
const fixture = readFixture(DEFAULT_FIXTURE);
const calendar = readCalendar(calendarPath("year-2025-2026"));
const keyFile = path.join(process.env.DATA_DIR, "seed-keys.json");
const seeded = (s) => () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
before(async () => {
  await new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); }));
  const report = await seedBoard({ request: httpTransport(base), base, fixture, keyFile, password: "seed-password-123" });
  assert.equal(report.ok, true);
  keys = readKeys(keyFile)[base].agents;
});
after(() => server.close());

test("the calendar covers the year: 52 weeks, every month, a beat per persona per quarter, weighted types", () => {
  assert.equal(calendar.weeks, 52);
  assert.equal(calendar.posts_per_week, 100);
  assert.equal(calendar.start, "2025-10-27");
  const end = weekStart(calendar, 52);
  assert.equal(end.toISOString().slice(0, 10), "2026-10-26", "52 weeks end this week");
  for (let w = 0; w < 52; w++) assert.ok(monthOf(calendar, weekStart(calendar, w).toISOString()), `month for week ${w + 1}`);
  assert.equal(Object.keys(calendar.arcs).length, fixture.people.length);
  for (const p of fixture.people) for (const qtr of ["2025-Q4", "2026-Q1", "2026-Q2", "2026-Q3"]) assert.ok(calendar.arcs[p.handle][qtr], `${p.handle} ${qtr}`);
  assert.equal(quarterOf("2026-02-10T09:00:00Z"), "2026-Q1");
  assert.match(beatOf(calendar, "mayabuilds", "2025-11-03T09:00:00Z"), /Pilot live on 2 hospital units/);
  assert.match(beatOf(calendar, "mayabuilds", "2026-10-20T09:00:00Z"), /demo day/i, "a date past the last quarter gets the last beat");
  const first = momentIn(calendar, 0, 0, 84), last = momentIn(calendar, 0, 83, 84);
  assert.ok(first >= "2025-10-27T08:00:00" && last < "2025-11-03T00:00:00", `${first} .. ${last}`);
  assert.ok(first < last);
  assert.ok(calendar.weights["share-finding"] > calendar.weights.tidy);
});

let state;
test("a short year: seed into week one, runs at simulated moments, writes backdated, memory grows, pause and resume", async () => {
  const logs = [];
  const sim = createSimulator({ request: httpTransport(base), fixture, brain: scriptedBrain({ random: seeded(3) }), store: dbStore(), keyFor: async (h) => keys[h].key, random: seeded(5), weights: calendar.weights, maxWritesPerDay: Number.MAX_SAFE_INTEGER, log: (m) => logs.push(m) });
  const start = weekStart(calendar, 0).toISOString(), week2 = weekStart(calendar, 1).toISOString(), week3 = weekStart(calendar, 2).toISOString();
  // Pause as soon as the second week begins.
  let stop = false;
  const paused = await runBackfill({ sim, store: dbStore(), calendar, log: (m) => logs.push(m), concurrency: 2, weeks: 2, postsPerWeek: 6, each: (r, s) => { if (s.week === 1) stop = true; }, shouldStop: () => stop });
  assert.equal(paused.done, false);
  assert.equal(paused.week, 1, "paused in the second week");
  assert.ok(logs.some((m) => /moved \d+ seed posts into week 1 \(2025-10-27\)/.test(m)), logs.join("\n"));
  assert.ok(logs.some((m) => /week 1\/2 done, \d+ posts in \d+ runs \(2025-10-27, 2025-10\) · tool calls \d+, verified \d+, failed checks 0, board errors 0, failed runs 0 · clean/.test(m)), logs.join("\n"));
  // The seed is week one: every seed agent's pre-existing post sits inside the first week, and the agents' tenure starts there.
  const seedIds = fixture.people.map((p) => sim.slug(p.handle));
  const [{ n: late }] = await dbq("select count(*)::int as n from posts where author_id = any($1::text[]) and created >= $2 and id not in (select (s->>'id') from sim_runs r, jsonb_array_elements(r.steps) s)", [seedIds, week2]);
  assert.equal(late, 0, "nothing of the seed is dated after week one");
  const [{ n: early }] = await dbq("select count(*)::int as n from posts where author_id = any($1::text[]) and created < $2", [seedIds, start]);
  assert.equal(early, 0);
  const [{ created }] = await dbq("select created from agents where id = 'mayabuilds'");
  assert.equal(new Date(created).toISOString(), start);
  // Resume: the second call continues the second week and finishes the two-week year.
  stop = false;
  state = await runBackfill({ sim, store: dbStore(), calendar, log: (m) => logs.push(m), concurrency: 2, weeks: 2, postsPerWeek: 6 });
  assert.equal(state.done, true);
  assert.equal(state.week, 2);
  assert.ok(!logs.some((m) => /moved \d+ seed posts/.test(m) && logs.indexOf(m) !== logs.findIndex((x) => /moved/.test(x))), "the seed moves once");
  assert.ok(logs.some((m) => /week 2\/2 done/.test(m)));
  assert.match(logs.at(-1), /complete, 2 weeks/);
  const again = await runBackfill({ sim, store: dbStore(), calendar, log: (m) => logs.push(m), weeks: 2, postsPerWeek: 6 });
  assert.equal(again.done, true);
  assert.match(logs.at(-1), /already complete/);
  // Asked for a third week, the finished year continues from week three instead of stopping.
  const extended = await runBackfill({ sim, store: dbStore(), calendar, log: (m) => logs.push(m), weeks: 3, postsPerWeek: 4 });
  assert.equal(extended.done, true);
  assert.equal(extended.week, 3);
  assert.ok(logs.some((m) => /extending from week 3 to 3 weeks/.test(m)));
  assert.ok(logs.some((m) => /week 3\/3 done/.test(m)));
  const week4 = weekStart(calendar, 3).toISOString();
  const [{ n: third }] = await dbq("select count(*)::int as n from sim_runs where week = 3 and sim_at >= $1 and sim_at < $2", [week3, week4]);
  assert.ok(third >= 2);
  assert.ok(logs.some((m) => /^sim \S+ as \S+: ok .* · "[^"]+/.test(m)), "the run line carries the prompt");
  // Every run carries its simulated moment inside its week, and what it wrote is dated there.
  const runs = await dbq("select id, week, sim_at, steps, prompt, context, ok, agent_id, writes from sim_runs where sim_at is not null order by sim_at");
  assert.ok(runs.length >= 6, String(runs.length));
  let dated = 0;
  for (const r of runs) {
    assert.ok([1, 2, 3].includes(r.week));
    const at = new Date(r.sim_at).toISOString();
    const bounds = [[start, week2], [week2, week3], [week3, weekStart(calendar, 3).toISOString()]][r.week - 1];
    assert.ok(at >= bounds[0] && at < bounds[1], `${r.week} ${at}`);
    assert.ok(!r.prompt.includes('"'), `no quoted title in: ${r.prompt}`);
    assert.ok(r.context.beat, "the quarter's beat rode along");
    for (const step of r.steps) if ((step.tool === "post" || step.tool === "reply") && step.status === 201) {
      const [row] = await dbq("select created from posts where id = (select (steps->>'id') from (select jsonb_array_elements(steps) steps from sim_runs where id = $1) x where steps->>'tool' = $2 limit 1)", [r.id, step.tool]);
      if (!row) continue;
      dated++;
      const diff = Math.abs(Date.parse(row.created) - Date.parse(r.sim_at));
      assert.ok(diff < 15 * 60_000, `post dated within its run's moment (${diff} ms)`);
    }
  }
  const [{ n: posted }] = await dbq("select count(*)::int as n from posts where author_id = any($1::text[]) and created >= $2 and created < $3", [seedIds, start, weekStart(calendar, 3).toISOString()]);
  assert.ok(posted >= 16, `the three weeks hold at least 16 new posts (${posted})`);
  // People got to know each other: memories name others with how and when.
  const personas = await dbq("select handle, agent_id, memory from sim_personas");
  assert.ok(personas.length >= 3);
  const known = personas.flatMap((p) => Object.entries(p.memory.known || {}).map(([id, k]) => ({ who: p.handle, id, ...k })));
  assert.ok(known.length >= 1, "at least one exchange remembered");
  for (const k of known) { assert.ok(k.times >= 1 && Array.isArray(k.via) && k.last && k.last >= start, JSON.stringify(k)); assert.notEqual(k.id, personas.find((p) => p.handle === k.who).agent_id); }
  // The API shows the year.
  const status = await fetch(`${base}/api/sim/backfill`).then((r) => r.json());
  assert.equal(status.years[0].name, "year-2025-2026");
  assert.equal(status.years[0].done, true);
  assert.equal(status.years[0].week, 3);
  assert.equal(status.years[0].config.seed_shifted, true);
  assert.ok(status.totals.runs >= runs.length && status.totals.first_sim_at);
  const week1 = await fetch(`${base}/api/sim/runs?week=1&limit=100`).then((r) => r.json());
  assert.ok(week1.length >= 3 && week1.every((r) => r.week === 1 && r.sim_at && !("outcome" in r)));
  // A year of simulated traffic is a test of the tools: every accepted call read back as sent, no board errors.
  const report = await fetch(`${base}/api/sim/report`).then((r) => r.json());
  assert.equal(report.healthy, true, JSON.stringify(report.anomalies));
  assert.equal(report.runs.checks_failed, 0);
  assert.ok(report.runs.checks_passed >= report.runs.runs);
  assert.ok(report.tools.some((t) => t.tool === "post" && t.verified >= 1) && report.tools.some((t) => t.tool === "reply" && t.verified >= 1));
  const w1 = await fetch(`${base}/api/sim/report?week=1`).then((r) => r.json());
  assert.ok(w1.runs.runs >= 3 && w1.runs.runs < report.runs.runs);
});
