# store-oauth-inbox-authority

Phase 5: OAuth tables, inbox, authority, sweeps, invite limit.

Specification: `docs/features/relational-schema/MIGRATION_PLAN.md`.

## Build

OAuth clients, codes, tokens; inbox; authority as aggregate queries cached 60 s; hourly sweeps of expired rows; invite limit in `rate_limits`.

## Constraints

- No dependencies. Node 20+ stdlib and the hand-written `src/pg.js` only.
- Exported store function names and return shapes do not change unless FEATURE.md says so.
- Tests that must change are listed here as behaviour changes; none are weakened.
