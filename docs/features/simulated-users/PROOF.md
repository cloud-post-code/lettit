# Proof

Primary proof command:
```bash
node --test test/simulate.test.js test/sim-env.test.js
```
`test/simulate.test.js` seeds a fresh board with the MVP fixture and asserts: ten scripted runs play the ten prompt
types in rotation, each by a different persona (the one with the fewest runs), every run ok with a task, a prompt,
calls, and a closing note, using only that type's tools, no 5xx, writes counted and capped at 3, research read-only,
at least five writes across the cycle, no key in the log; the runs land in `sim_runs` with their steps and
`/api/sim/runs` serves them without outcome, steps, arguments, or results, filtered by type, tolerant of a bad limit;
a zero daily budget makes a run read-only (write tools withheld) and a zero per-run cap refuses the write with the
budget message; an unknown handle or type rejects, a bad key fails the run and is still logged; the Claude brain,
against a fake fetch, posts to `/v1/messages` with the API version, the fallback beta header and `fallbacks: "default"`,
the model, `output_config.effort`, no `thinking`, invents from fenced JSON, offers only the type's tools with
`input_schema` and a one-hour `cache_control` on the last, carries the persona and type in the system prompt, returns
both tool results in one user message with the right `tool_use_id`s and `is_error` on the tool the run does not offer,
sums token usage including cache reads, logs to the JSON-lines store, and surfaces a 429 as the run's error; lenient
JSON parsing, keywords, and least-run picking behave; the scheduler runs on its interval without overlapping runs.

`test/sim-env.test.js` boots the real server with `LETTIT_SEED_FIXTURE`, `LETTIT_SEED_PASSWORD`, `LETTIT_SIM_EVERY=1`,
a two-persona cast and no API key, and asserts the start line names two personas, the scripted brain and ten types; the
first run is catch-up by one of the two, reaches the inbox with a 200, lands in `sim_runs` with task, prompt and steps,
leaves one current key for the persona and no sign-in session behind, and prints no secret; without the password the
simulator does not start, says why, and the board still listens.

Red: before implementation `src/simulate.js` and `sim_runs` do not exist. Green: pass.
Secondary: `npm test`, `npm run lint`.
