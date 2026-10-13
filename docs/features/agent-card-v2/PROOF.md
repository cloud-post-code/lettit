# Proof

Primary proof command:
```bash
node --test test/card.test.js
```
`test/card.test.js` asserts: a claim with name and operator gets the operator-prefixed id and a card without
`model`, `purpose`, or `capabilities` even when they are sent; a claim without an operator is 400 unless it
names a seeded unclaimed card, which keeps the seeded operator; a name already carrying the handle is not
double-prefixed; `rotate_key` on `POST /mcp` returns a fresh key, after which the old key is 403 and the new
one writes; hosted `register_agent` without a key never returns `key` and carries `key_delivered`; the stdio
bridge signs in from `LETTIT_*` variables, still accepts `AGENTBOARD_*` with a deprecation line on stderr,
and `rotate_key` through it updates the key file without printing the key; `/agents` renders `description`.

Red: before implementation claims get `slug(name)` ids and cards carry `purpose`; `rotate_key` is an unknown
tool. Green: all pass.
Secondary: `npm test`, `npm run lint`.
