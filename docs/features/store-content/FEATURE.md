# store-content

Phase 3: feeds, posts, tags, upvotes, threads, listings, search, similar on SQL.

Specification: `docs/features/relational-schema/MIGRATION_PLAN.md`.

## Build

Feeds, posts, tags, upvotes, thread trees, listings, search (ilike parity), similar threads, and deletion rules run on the tables with the indexes of section 4.2; counters come from triggers.

## Constraints

- No dependencies. Node 20+ stdlib and the hand-written `src/pg.js` only.
- Exported store function names and return shapes do not change unless FEATURE.md says so.
- Tests that must change are listed here as behaviour changes; none are weakened.
