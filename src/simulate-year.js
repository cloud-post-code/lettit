// The simulated year: a resumable batch that runs the simulated users week by week over a calendar
// (seed/year-2025-2026.json), so a board fills with a year of history before real users arrive.
//
// Each week gets a post quota (posts_per_week: sub-threads and replies, upvotes not counted). Runs are spread over the
// week's working hours and carry a simulated moment; each run's writes are backdated to it afterwards, so threads read
// in order and "recent" means recent in the simulated year. The month gives the season and a few anchors, the quarter
// gives each persona its story beat (what they are building), and the persona's memory of whom they have exchanged
// with grows run by run, so over the year people get to know each other. The seed content already on the board is
// moved into week one as the starting state; real users' posts are never touched.
//
// Progress lives in sim_backfill: the week and post count reached. A restart (a redeploy, a crash) resumes from there.
// LETTIT_SIM_BACKFILL=<calendar name> on the server starts it after the seed; LETTIT_SIM_BACKFILL_PAUSE=1 holds it.
import fs from "node:fs";
import { createSimulator, claudeBrain, scriptedBrain, dbStore, PROMPT_TYPES } from "./simulate.js";
import { readFixture, fixturePath } from "./seed-fixture.js";
import { createSession, rotateFromSession, dropSession } from "./store/sessions.js";

export const calendarPath = (v) => (/[\/\\]|\.json$/.test(String(v)) ? String(v) : new URL(`../seed/${v}.json`, import.meta.url));
export function readCalendar(file) {
  const c = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const k of ["name", "start", "weeks", "posts_per_week", "months", "arcs"]) if (c[k] == null) throw new Error(`calendar: ${k} missing`);
  return c;
}
const DAY = 86_400_000;
export const weekStart = (calendar, week) => new Date(Date.parse(calendar.start + "T00:00:00Z") + week * 7 * DAY);
// The n-th of `count` runs in a week lands on a weekday between 8:00 and 20:00 UTC, in order.
export function momentIn(calendar, week, n, count) {
  const start = weekStart(calendar, week).getTime();
  const slot = (n + 0.5) / Math.max(1, count);
  const day = Math.min(6, Math.floor(slot * 7));
  const hour = 8 + ((slot * 7) % 1) * 12;
  return new Date(start + day * DAY + hour * 3_600_000).toISOString();
}
export const quarterOf = (iso) => { const d = new Date(iso); return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`; };
export const monthOf = (calendar, iso) => calendar.months.find((m) => m.month === String(iso).slice(0, 7)) || null;
export const beatOf = (calendar, handle, iso) => calendar.arcs[handle]?.[quarterOf(iso)] || Object.values(calendar.arcs[handle] || {}).pop() || "";

// Run the year (or continue it). Returns the final state. `each` is called after every run with (record, state).
export async function runBackfill({ sim, store, calendar, log = () => {}, concurrency = 2, each = null, shouldStop = () => false, weeks = calendar.weeks, postsPerWeek = calendar.posts_per_week }) {
  const name = calendar.name;
  let state = (await store.backfill(name)) || { name, week: 0, posts: 0, runs: 0, done: false, config: {} };
  if (state.done) { log(`year ${name}: already complete (${state.posts} posts over ${state.week} weeks)`); return state; }
  state.config = { ...state.config, start: calendar.start, weeks, posts_per_week: postsPerWeek, concurrency };
  // Week one starts with what is already there: the seed moves into it, once.
  if (!state.config.seed_shifted && store.shiftSeed) {
    const moved = await store.shiftSeed(sim.people.map((p) => sim.slug(p.handle)), weekStart(calendar, 0).toISOString(), weekStart(calendar, 1).toISOString());
    state.config.seed_shifted = true;
    log(`year ${name}: moved ${moved} seed posts into week 1 (${calendar.start})`);
  }
  await store.saveBackfill(state);
  const maxRuns = postsPerWeek * 2;
  for (let week = state.week; week < weeks; week++) {
    let posts = week === state.week ? state.posts : 0, runs = 0;
    const health = { calls: 0, verified: 0, failed_checks: 0, board: 0, anomalies: 0, failed_runs: 0 };
    const weekBegins = weekStart(calendar, week).toISOString();
    const month = monthOf(calendar, weekBegins);
    while (posts < postsPerWeek && runs < maxRuns) {
      if (shouldStop()) { log(`year ${name}: paused at week ${week + 1}, ${posts} posts`); return state; }
      const batch = Math.min(concurrency, maxRuns - runs);
      const results = await Promise.all(Array.from({ length: batch }, (_, i) => {
        const at = momentIn(calendar, week, Math.floor((posts / postsPerWeek) * 7 * 12) + i, 7 * 12);
        return sim.run({ at, week: week + 1, month, beatBy: (handle) => beatOf(calendar, handle, at) }).catch((e) => ({ ok: false, error: e.message, writes: 0, made: [], prompt_type: "?", agent_id: "?" }));
      }));
      for (const r of results) {
        runs++;
        posts += (r.made || []).filter((m) => m.kind === "post").length;
        health.calls += (r.steps || []).length;
        health.verified += r.checks?.passed || 0;
        health.failed_checks += r.checks?.failed || 0;
        health.board += (r.steps || []).filter((s) => s.failure === "board").length;
        health.anomalies += (r.anomalies || []).length;
        if (!r.ok) health.failed_runs++;
        state = { ...state, week, posts, runs: state.runs + 1 };
        if (each) await each(r, state);
      }
      await store.saveBackfill(state);
    }
    log(`year ${name}: week ${week + 1}/${weeks} done, ${posts} posts in ${runs} runs (${weekBegins.slice(0, 10)}, ${month?.month || "?"}) · tool calls ${health.calls}, verified ${health.verified}, failed checks ${health.failed_checks}, board errors ${health.board}, failed runs ${health.failed_runs}${health.anomalies ? ` · ${health.anomalies} ANOMALIES, see /api/sim/report?week=${week + 1}` : " · clean"}`);
    state = { ...state, week: week + 1, posts: 0 };
    await store.saveBackfill(state);
  }
  state.done = true;
  await store.saveBackfill(state);
  log(`year ${name}: complete, ${weeks} weeks`);
  return state;
}

// On the board itself (the Railway route): LETTIT_SIM_BACKFILL names the calendar; the personas and their keys come
// from the seed fixture and LETTIT_SEED_PASSWORD; ANTHROPIC_API_KEY picks the Claude brain. Runs in the background
// after the server is up; LETTIT_SIM_BACKFILL_WEEKS and LETTIT_SIM_BACKFILL_POSTS override the calendar; a redeploy
// resumes where it stopped; LETTIT_SIM_BACKFILL_PAUSE=1 stops after the current run.
export function startBackfillFromEnv({ request, env = process.env, log = () => {} }) {
  const name = env.LETTIT_SIM_BACKFILL;
  if (!name) return null;
  if (!env.LETTIT_SEED_PASSWORD) { log("year: not started, LETTIT_SEED_PASSWORD is not set (needed to act as the seed personas)"); return null; }
  const calendar = readCalendar(calendarPath(name));
  const fixture = readFixture(fixturePath(env.LETTIT_SIM_FIXTURE || env.LETTIT_SEED_FIXTURE || "mvp-with-ai"));
  const brain = env.ANTHROPIC_API_KEY ? claudeBrain({ apiKey: env.ANTHROPIC_API_KEY, model: env.LETTIT_SIM_MODEL || "claude-opus-5-5", effort: env.LETTIT_SIM_EFFORT || "low" }) : scriptedBrain();
  const domain = env.LETTIT_SEED_EMAIL_DOMAIN || "example.com";
  const keys = new Map();
  const keyFor = async (handle) => {
    if (!keys.has(handle)) { const s = await createSession(`${handle}@${domain}`, env.LETTIT_SEED_PASSWORD); const r = await rotateFromSession(s.token); await dropSession(s.token); keys.set(handle, r.key); }
    return keys.get(handle);
  };
  const store = dbStore();
  const sim = createSimulator({ request, fixture, brain, store, keyFor, log, weights: calendar.weights || null, maxWritesPerDay: Number.MAX_SAFE_INTEGER, handles: env.LETTIT_SIM_AGENTS ? env.LETTIT_SIM_AGENTS.split(",").map((s) => s.trim()).filter(Boolean) : null });
  const weeks = Number(env.LETTIT_SIM_BACKFILL_WEEKS || calendar.weeks), postsPerWeek = Number(env.LETTIT_SIM_BACKFILL_POSTS || calendar.posts_per_week);
  log(`year ${calendar.name}: ${weeks} weeks from ${calendar.start}, ${postsPerWeek} posts a week, ${sim.people.length} personas, brain ${brain.name}${brain.model ? ` (${brain.model})` : ""}, ${PROMPT_TYPES.length} prompt types weighted toward work`);
  const promise = runBackfill({ sim, store, calendar, log, concurrency: Number(env.LETTIT_SIM_CONCURRENCY || 2), weeks, postsPerWeek, shouldStop: () => env.LETTIT_SIM_BACKFILL_PAUSE === "1" })
    .catch((e) => { log(`year ${calendar.name}: stopped: ${e.message}`); return null; });
  return { calendar, sim, promise };
}
