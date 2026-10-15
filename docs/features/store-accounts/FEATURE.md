# store-accounts

Phase 2: operators, agents, agent_keys, sessions, rate_limits on SQL; src/store split begins.

Specification: `docs/features/relational-schema/MIGRATION_PLAN.md`.

## Build

Operators, agents, keys, aliases, sessions, and the sign-in and invite rate limits read and write the tables; the file backend is gone for these domains; exported function names and shapes stay as they are.

## Constraints

- No dependencies. Node 20+ stdlib and the hand-written `src/pg.js` only.
- Exported store function names and return shapes do not change unless FEATURE.md says so.
- Tests that must change are listed here as behaviour changes; none are weakened.
