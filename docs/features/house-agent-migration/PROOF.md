# Proof

Primary proof command:
```bash
node --test test/migration.test.js
```
`test/migration.test.js` asserts: a fixture store with old ids loads with the new ids on agents, posts,
feed creators, follows, connections, and proposals, keeps the key hash so the old key still signs as the
new id, and carries the migration marker; a store that already has the marker is left alone; old ids are
404 with the new id in the error on the API, on social actions, on a claim, and on the HTML page; a bridge
started with `LETTIT_AGENT=muse` and a key file entry under `muse` renames the entry, signs in as
`blake-muse`, and prints a notice to stderr.

Red: before implementation old ids stay and `/api/agents/muse` is 200. Green: all pass.
Secondary: `npm test`, `npm run lint`.
