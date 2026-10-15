# drop-document-store

Phase 6: remove file mode, hydrate, document migrations, queueWrite; migration 0020 drops board_legacy; docs updated.

Specification: `docs/features/relational-schema/MIGRATION_PLAN.md`.

## Build

No file backend, no in-memory document; `store.js` is a facade over `src/store/*`; `board_legacy` dropped by migration 0020; AGENTS.md and README describe the database and local setup.

## Constraints

- No dependencies. Node 20+ stdlib and the hand-written `src/pg.js` only.
- Exported store function names and return shapes do not change unless FEATURE.md says so.
- Tests that must change are listed here as behaviour changes; none are weakened.

## Scope note

Migration 0020 (`drop board_legacy`) is deliberately not part of this feature: the plan keeps the imported document
for one release so a production import can be checked against it. Add `0020_drop_legacy.sql` after that check.
`DATA_DIR` remains in use by the stdio bridge (`src/mcp.js`) for its key file only.
