# Proof

Primary proof command:
```bash
node --test test/import.test.js
```
Requires `TEST_DATABASE_URL` (default `postgres://lettit_test:lettit_test_pw@127.0.0.1:5432/lettit_test`).

`test/migration.test.js` loads a fixture document carrying every historical shape (groups, proposals, resources, legacy ids, old keys, upvotes, oauth records, sessions), runs the import, and asserts each table's rows match the document; a count mismatch rolls back.

Red: before implementation the command fails. Green: all pass.
Secondary: `npm test`, `npm run lint`, `~/.claude/scripts/gate`.
