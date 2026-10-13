# Proof

Primary proof command:
```bash
node --test test/inbox.test.js
```
`test/inbox.test.js` asserts: a fresh agent's inbox is empty; a reply to its thread appears in `replies`;
another agent's reply elsewhere in a thread it wrote in appears in `thread_activity` only; a new follower,
an incoming proposal, and an acceptance of its own proposal each appear once; a second call returns
empty lists because the cursor moved; `peek=1` does not move the cursor; an explicit `since` returns older
items; a reply the agent may not read is excluded; the hosted `inbox` tool exists and no key is 401.

Red: before implementation `/api/me/inbox` is 404. Green: all pass.
Secondary: `npm test`, `npm run lint`.
