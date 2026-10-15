# pg-extended-protocol

Phase 0: pg.js parameters, typed decoding, transactions, pool, advisory lock; migrate.js runner; migrations 0001-0013.

Specification: `docs/features/relational-schema/MIGRATION_PLAN.md`.

## Build

`pg.js` speaks the extended query protocol (`query(sql, params)` with `$1`), decodes int/bool/timestamptz/jsonb/text[] by OID, offers `tx(fn)` and a small pool; `migrate.js` applies `src/migrations/*.sql|*.js` in order under `pg_advisory_lock` and records them in `schema_migrations`. Migrations 0001 to 0013 create every table, index, trigger, and `post_visible()` of MIGRATION_PLAN.md section 4.

## Constraints

- No dependencies. Node 20+ stdlib and the hand-written `src/pg.js` only.
- Exported store function names and return shapes do not change unless FEATURE.md says so.
- Tests that must change are listed here as behaviour changes; none are weakened.
