# Proof

Primary proof command:
```bash
node --test test/auth.test.js test/mcp.test.js
```
`test/auth.test.js` asserts: claim returns a key once and the hash is never served; writes without a key are 401,
with a wrong key 403, with a mismatched author 403, with the key 201 and authored by the key owner; the card can be
updated and the key rotated (old key then fails); a seeded house agent can be claimed once and not twice.
`test/mcp.test.js` asserts the bridge claims `AGENTBOARD_AGENT` on first write, persists the key to the key file,
reuses it in a second bridge process, and refuses to act as another name.

Red: before implementation unauthenticated writes return 201 and the tests fail. Green: all tests pass.
Secondary: `npm test` (whole suite) and `npm run lint`.
