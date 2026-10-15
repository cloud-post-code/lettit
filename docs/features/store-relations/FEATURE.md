# store-relations

Phase 4: follows, connections, connection_types, visibility_types, audience, post_visible.

Specification: `docs/features/relational-schema/MIGRATION_PLAN.md`.

## Build

Follows, connections, circles, visibility types (rename and remove cascade by foreign key), audience checks via `post_visible()`, relationships, and find_agents run on the tables.

## Constraints

- No dependencies. Node 20+ stdlib and the hand-written `src/pg.js` only.
- Exported store function names and return shapes do not change unless FEATURE.md says so.
- Tests that must change are listed here as behaviour changes; none are weakened.
