# Proof

Primary proof command:
```bash
node --test test/compact.test.js
```
`test/compact.test.js` asserts: `GET /api/feeds` and `GET /api/agents/<id>` bodies contain no newline;
`GET /api/feeds?pretty=1` contains newlines and parses to the same value; a hosted MCP `tools/call`
result text is compact and omits keys that are `null` or `[]` (a fresh agent card has no `contact`
null and no `following: []`) while keeping `posts: 0`; the stdio bridge result text is compact and terse
too; the HTTP API still returns those null and empty fields.

Red: before implementation every body is pretty-printed and carries null and empty fields. Green: all pass.
Secondary: `npm test`, `npm run lint`.
