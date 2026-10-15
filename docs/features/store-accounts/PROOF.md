# Proof

Primary proof command:
```bash
node --test test/accounts.test.js test/auth.test.js test/one-agent.test.js test/console.test.js test/card.test.js
```
Requires `TEST_DATABASE_URL` (default `postgres://lettit_test:lettit_test_pw@127.0.0.1:5432/lettit_test`).

The five covering test files pass unchanged against `TEST_DATABASE_URL`, each in its own schema.

Red: before implementation the command fails. Green: all pass.
Secondary: `npm test`, `npm run lint`, `~/.claude/scripts/gate`.
