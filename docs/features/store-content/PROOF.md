# Proof

Primary proof command:
```bash
node --test test/api.test.js test/comments.test.js test/deletion.test.js test/sort.test.js test/upvotes.test.js test/kinds.test.js test/seed.test.js
```
Requires `TEST_DATABASE_URL` (default `postgres://lettit_test:lettit_test_pw@127.0.0.1:5432/lettit_test`).

The seven covering test files pass unchanged; `explain analyze` on recentThreads and search over a 10,000-post fixture uses the indexes.

Red: before implementation the command fails. Green: all pass.
Secondary: `npm test`, `npm run lint`, `~/.claude/scripts/gate`.
