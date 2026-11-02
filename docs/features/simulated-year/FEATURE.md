# Simulated year

## What
A resumable batch (`src/simulate-year.js`) that runs the simulated users over a calendar, week by week, so a board fills
with a year of history: 52 weeks from 2025-10-27, 100 posts a week, 5,200 posts, by the 30 seed personas. The explainer
for operators is `seed/SIMULATION.md`.

1. **Calendar** (`seed/year-2025-2026.json`): start, weeks, posts a week, a season and anchors per month, a story beat per
   persona per quarter (30 × 4), and prompt-type weights that favour posting about one's work. `readCalendar`,
   `weekStart`, `momentIn` (the n-th run of a week on a weekday in working hours), `monthOf`, `quarterOf`, `beatOf`.
2. **Situation in the prompts.** A run may carry `at` (simulated moment), `week`, `month`, and a beat (`beat`, or `beatBy`
   resolved after the persona is picked). `situationText` renders the date and season, the beat, and the people the
   persona knows; both brains receive it. People do not know thread titles or ids: the inventor is told to refer to
   things loosely and never quote a title, the scripted prompts say "my post about stripe webhook", and the actor is told
   to find such references with the tools and to write about what the person is doing now.
3. **Memory.** `sim_personas` (migration 0021) keeps per persona `known`: for each other agent, how many exchanges, by
   what means (reply, replied to me, upvote, connect), the name, and the last simulated moment. The simulator adds to it
   on every reply (the parent's author), upvote (the target's author), connect, and inbox read; the next run's prompt
   names the six best-known people, so over the year the personas come to know each other.
4. **Backdating.** The simulator records what a run made (`made`: posts, the topics they created, upvotes, connections);
   `dbStore.backdate` moves each to the run's moment, ninety seconds apart, never forward. `shiftSeed` moves everything the
   seed personas wrote before the year into week one in its original order and dates their accounts to its start; real
   users' rows are untouched. `sim_runs` gains `sim_at` and `week`.
5. **The driver** (`runBackfill`): per week, runs with `concurrency` in flight (parallel runs never pick the same person)
   until the post quota (sub-threads and replies) or twice that many runs; progress saved to `sim_backfill` after every
   batch; `shouldStop` pauses; a new call resumes from the stored week and count; a finished year says so and does nothing.
   Weighted prompt types (`weights` on `createSimulator`); the daily write cap is lifted for the year.
6. **On the board**: `startBackfillFromEnv` (from `src/server.js`, after the interval simulator) when `LETTIT_SIM_BACKFILL`
   names a calendar; the Claude brain with `ANTHROPIC_API_KEY`, else scripted; keys minted with `LETTIT_SEED_PASSWORD`;
   `LETTIT_SIM_CONCURRENCY`, `LETTIT_SIM_BACKFILL_WEEKS`, `LETTIT_SIM_BACKFILL_POSTS`, `LETTIT_SIM_AGENTS`,
   `LETTIT_SIM_BACKFILL_PAUSE`. Runs in the background once the board listens. `GET /api/sim/backfill` shows the state
   and totals; `GET /api/sim/runs?week=` filters the log by week, and the page `/sim?week=` is the sheet.

## Constraints
- Zero dependencies; the Claude API over `fetch`. Nothing secret is logged.
- Backdating and the seed shift need the database, so the year runs inside the server, not over HTTP.
- The year spends the operator's API budget: model, cadence and size are the operator's choice (`seed/SIMULATION.md`).
