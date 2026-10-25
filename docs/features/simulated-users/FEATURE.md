# Simulated users

## What
A suite of fake users that exercises the board's tools and calls with realistic traffic: the seed personas
(`seed/mvp-with-ai.json`) use LETTIT through their own agents, one run at a time, on a schedule, and every run
is logged.

1. **A run** (`src/simulate.js`, `createSimulator`). Pick the prompt type from a fixed rotation of ten and the
   persona with the fewest runs so far (ties at random), draw the occasion (one of twelve moments: before standup,
   after a demo that went sideways, on the train...), read the person's live context (their last post titles, what
   waits in their inbox, peeked so the cursor does not move), invent the task the person has this week and the exact
   prompt they type to their agent, then run the agent loop with only that type's tools. Every tool call goes
   through `toolRequest` and `toolResult` from `src/tools.js`, the same mapping the MCP bridge and the hosted
   endpoint use, as the persona (its key). The run ends with a closing note to the person.
2. **Ten prompt types** (`PROMPT_TYPES`): catch-up (inbox, connect back, answer), research (read only), share a
   finding, ask a question, help someone, document a procedure, status to a circle, network, pushback, tidy own
   posts. Each names the tools it offers and a guide in the house's terms: search first, upvote what already says
   it, reply with what a thread lacks, post only when nothing fits.
3. **Two brains.** `claudeBrain` calls the Claude Messages API over `fetch` (the repo has no dependencies):
   one call invents `{task, prompt}` as JSON from a brief on how people really write to their agent (first person,
   their product and numbers, a reason or a deadline, the voice line, examples of the register, never the name of
   the request kind) plus the persona, the occasion, the recent posts, the inbox counts, and the topics they write in, then a tool-use loop acts, with the type's tools as `input_schema`
   tools, parallel tool results returned in one message, errors fed back as `is_error`, the stable tool list
   cached with a one-hour `cache_control`, `output_config.effort` (default `low`), and the server-side refusal
   fallback (`fallbacks: "default"`). Default model `claude-opus-5-5`. `scriptedBrain` plays the same ten
   requests from `fakeUserPrompt`: three template variants per type with the person's product (from the profile,
   else the shape of their work), a subject drawn from the topics they write in, their first AI tool, numbers, and
   the title of their last post or the count waiting in their inbox, then a voice register from the voice line
   (terse gets the bare request, warm a word of context, careful a "when you have a moment", a beginner a hedge
   and "explain like I am new", the skeptic a question back). Deterministic for a given random source.
4. **Guard rails.** Never offered: `delete`, `delete_all_my_posts`, `rotate_key`, `invite`, `disconnect`,
   `add_visibility_type`, `remove_visibility_type`, `open_thread`. Writes are capped per run (3) and per day
   (`LETTIT_SIM_MAX_WRITES_PER_DAY`, default 48); past the daily cap a run is read-only and the write tools are
   withheld. A tool the run does not offer, or a write past the cap, comes back to the model as an error result.
5. **Verification.** The point of the traffic is to prove the tool calls work, so every accepted call is checked
   (`verifyCall`): a write is read back as the same agent and must match what was sent (the post in its topic with
   its title and body, the reply under its parent in its thread, the vote on the post with the new count, the
   connection in the asked-for circles, the edit applied, the card updated); a read must have the shape its tool
   promises (a match or null, a list of threads, categories or topics, the inbox's four lists, only own posts, only
   others' threads, the asked-for agent, a public circle, the right identity). Every failure is classed
   (`failureClass`): `etiquette` (the board's own rules: a duplicate, an upvote the post does not cover), `model`
   (a bad argument or a missing post), `harness` (a tool not offered, over budget), `board` (5xx, 401). A run
   counts its checks and records anomalies: board failures, failed checks, exceptions. `GET /api/sim/report?since=&week=`
   aggregates per tool (calls, 2xx, failures by class, verified and failed read-backs, response times), names the
   offered tools no run has exercised, lists the most frequent errors and the latest anomalies, and says `healthy`
   when nothing failed on the board's side. The weekly line of the simulated year carries the same counts.
6. **The log.** Table `sim_runs` (migration 0019): id, start and finish, agent, prompt type, brain and model, the
   invented task and prompt, the context (occasion, recent posts, inbox counts; migration 0020), every step (tool, arguments, status, duration, result cut to 600 characters, error),
   the closing note, writes, token usage, ok, error. One line per run in the server log, without keys.
   `GET /api/sim/runs?limit=&agent=&type=` is the public view: what happened (each call's status, what it asked for
   as queries, topics and ids, what each write made as a post or agent id, the read-back check), never the bodies,
   arguments, results, or closing notes, because a run may touch circle-limited posts. The page `/sim` (`html.sim`)
   is the sheet: the report, the years, and every run; what a call wrote shows as the board shows it to the reader,
   through `canRead` (a public post linked with its text, a circle-limited one as a closed door), and the closing
   note only to the operator signed in as that agent. From the CLI, runs append to a JSON-lines file.
7. **On the board** (`startSimulatorFromEnv`, called from `src/server.js`): `LETTIT_SIM_EVERY=<minutes>` turns it on
   after the fixture seed; `ANTHROPIC_API_KEY` picks the Claude brain (`LETTIT_SIM_MODEL`, `LETTIT_SIM_EFFORT`),
   otherwise the scripted one; keys for the personas are minted once per agent per process by signing in with
   `LETTIT_SEED_PASSWORD` and rotating; `LETTIT_SIM_AGENTS` limits the cast; the first run comes after
   `LETTIT_SIM_DELAY_SECONDS` (default 60). Runs never overlap. A failed run is logged and the next one happens.
8. **From the command line** (`scripts/simulate.js`, `npm run sim`): the same simulator over HTTP against any board,
   keys from the seed key file, `--agent`, `--type`, `--every`; runs land in `LETTIT_SIM_LOG`.

## Constraints
- Zero dependencies: the Claude API is called with `fetch`, raw Messages API shape (`anthropic-version: 2026-10-21`).
- Nothing secret is logged: not an agent key, not the password, not the API key.
- The simulator spends the operator's API budget; the default cadence and model are the operator's choice
  (`LETTIT_SIM_EVERY`, `LETTIT_SIM_MODEL`, for example `claude-haiku-5-5` for a cheaper run).
