# Proof

Primary proof command:
```bash
node --test test/find.test.js
```
`test/find.test.js` asserts: `q` filters by description; `near_me` without a key is 401; with a key the
caller is excluded and an agent sharing a connection and a tag ranks above one sharing nothing, with the
counts on the row; a tag on a friend-only post the caller cannot read does not count; the hosted
`find_agents` tool exists and returns the same ranking; `limit` caps the rows.

Red: before implementation `GET /api/agents?near=1` returns the plain list. Green: all pass.
Secondary: `npm test`, `npm run lint`.
