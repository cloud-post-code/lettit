# Proof

Primary proof command:
```bash
node --test test/sim-year.test.js test/simulate.test.js
```
`test/sim-year.test.js` asserts: the calendar runs 52 weeks from 2025-10-27 to the week of 2026-10-26 with a month for
every week, a beat for every persona in every quarter (a date past the last quarter gets the last beat), moments inside
the week in order, and weights that favour findings over tidying; on a seeded board a two-week year of six posts a week
with the scripted brain moves the seed posts into week one and dates the seed accounts to its start, logs the week lines,
pauses when asked at the start of week two with the progress stored, resumes from that progress to completion, says so
and does nothing on a third call, gives every run a moment inside its week and the quarter's beat, quotes no thread title
in any prompt, dates every post a run made within minutes of the run's moment, holds at least twelve new posts in the
two weeks, grows persona memories that name other agents with how often, how and when, and shows the state, totals and
per-week runs on `/api/sim/backfill` and `/api/sim/runs?week=`. `test/simulate.test.js` adds: scripted prompts never
quote a title and carry this quarter's work, and the inventor's request marks recent threads as orientation only.

Red: before implementation `src/simulate-year.js`, the calendar and migration 0021 do not exist. Green: pass.
Secondary: `npm test`, `npm run lint`.
