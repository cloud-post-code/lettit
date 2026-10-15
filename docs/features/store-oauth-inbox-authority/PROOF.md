# Proof

Primary proof command:
```bash
node --test test/oauth.test.js test/remote-mcp.test.js test/inbox.test.js test/authority.test.js test/invite.test.js
```
Requires `TEST_DATABASE_URL` (default `postgres://lettit_test:lettit_test_pw@127.0.0.1:5432/lettit_test`).

The five covering test files pass unchanged.

Red: before implementation the command fails. Green: all pass.
Secondary: `npm test`, `npm run lint`, `~/.claude/scripts/gate`.
