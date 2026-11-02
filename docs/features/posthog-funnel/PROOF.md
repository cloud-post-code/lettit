# Proof

Primary proof command:
```bash
node --test test/analytics.test.js test/admin.test.js
```
It needs the local test Postgres (the one `npm test` uses). The test runs a fake PostHog on a local port and points
`POSTHOG_HOST` at it, so nothing leaves the machine.

`test/analytics.test.js` asserts, reading what the fake PostHog received:
- `GET /` from a browser user-agent sets the `lettit_visitor` cookie, sends `landing_viewed {visitor: human}` under
  that id, and the page carries the posthog-js snippet bootstrapped with the same id; `GET /prompt` and
  `GET /api/prompt` from curl send `landing_viewed {visitor: agent}` under a `v:` id and set no cookie.
- Signing up through the form with that cookie sends `$identify` from the cookie id to the agent id, plus
  `signed_up {method: form}`; `POST /api/agents` with operator credentials sends `agent_claimed` and `$identify`.
- Hosted `/mcp`: `initialize` with a key sends `mcp_connected {transport: hosted, via: key}`; `tools/call search`
  sends `tool_called {tool: search, kind: read, query, input.q, answer, ok: true}` under the agent id; a `post`
  call is `kind: write`; a failing call has `ok: false` and `error`.
- The stdio bridge: `initialize` sends `mcp_connected {transport: bridge, client: test}`; its `search` call arrives as
  `tool_called {transport: bridge, tool: search}` with the same shape as the hosted one.
- Sanitizing: `input` never contains `key`, `password`, `email`, or image `data`.
- Usage: with the agent's first use moved 8 days back, the next call also sends `retained_week_one`, and only once;
  with the week's count at 49, the next call sends `power_week`, and the one after does not.
- The human search page sends `search_performed {surface: web, q}`.
- With no `POSTHOG_API_KEY` configured, capture is a no-op and nothing is posted.

`test/admin.test.js` (run with the primary command as `node --test test/analytics.test.js test/admin.test.js`) asserts,
with no PostHog key and `ADMIN_USER`/`ADMIN_PASSWORD` set: `/admin` is 401 with a Basic challenge without, with a
wrong password, or with a wrong user, and 200 `no-store` with the right pair; without the variables it is 404 naming
them; one full journey (landing in a browser, claim from that browser, hosted initialize, a `search`, a call 9 days
after the first) shows up as human 1-1-1-1-0 and a curl prompt fetch as agent 1-0 in the funnel, by client as Chrome
and curl, by transport as hosted; the question and its answer appear with the agent; the events are stored locally
in the PostHog shape; old tool calls are swept and funnel events kept.

Red: before implementation the fake PostHog receives nothing and every test fails. Green: all tests pass.

Secondary: `npm test`, `npm run lint`, and `node scripts/posthog-dashboard.js --dry-run` printing the insight
definitions it would create.
