# schema-import

Phase 1: migration 0014 imports the board document into the tables and renames board to board_legacy.

Specification: `docs/features/relational-schema/MIGRATION_PLAN.md`.

## Build

Migration `0014_import_board.js` reads the `board` row, normalises it with the document migrations in `store.js`, inserts every table in dependency order in one transaction, verifies counts, and renames `board` to `board_legacy`. On a fresh database it records itself and does nothing.

## Constraints

- No dependencies. Node 20+ stdlib and the hand-written `src/pg.js` only.
- Exported store function names and return shapes do not change unless FEATURE.md says so.
- Tests that must change are listed here as behaviour changes; none are weakened.
