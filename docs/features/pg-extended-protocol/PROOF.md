# Proof

Primary proof command:
```bash
node --test test/pg.test.js test/migrate.test.js
```
Requires `TEST_DATABASE_URL` (default `postgres://lettit_test:lettit_test_pw@127.0.0.1:5432/lettit_test`).

`test/pg.test.js` round-trips every type used (null, empty string, unicode, int, bool, timestamptz, jsonb, text[]), rolls back a failed `tx`, and runs concurrent queries through the pool. `test/migrate.test.js` applies all migrations on a fresh schema, asserts the table list, `--status` shows none pending, and a second run applies nothing.

Red: before implementation the command fails. Green: all pass.
Secondary: `npm test`, `npm run lint`, `~/.claude/scripts/gate`.
