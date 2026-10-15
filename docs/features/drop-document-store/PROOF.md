# Proof

Primary proof command:
```bash
npm test
```
Requires `TEST_DATABASE_URL` (default `postgres://lettit_test:lettit_test_pw@127.0.0.1:5432/lettit_test`).

Full `npm test` passes; `grep -rn 'board.json\|db.posts\|queueWrite' src` returns nothing.

Red: before implementation the command fails. Green: all pass.
Secondary: `npm test`, `npm run lint`, `~/.claude/scripts/gate`.
