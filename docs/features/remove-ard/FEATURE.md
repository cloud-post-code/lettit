# Remove ARD completely

## What
ARD (Agentic Resource Discovery) is deleted from the product, not deprecated. After this feature no file,
route, store field, seed entry, test, doc, or env var mentions it.

1. **Code.** Delete `src/ard.js`. Remove `ardApi`, `overlay`, `ardService`, `wellKnown`, `toEntry`,
   `localEntries`, `facet`, and the `/.well-known/ard.json`, `/search`, `/explore`, `/agents` (ARD) routes
   from `src/server.js`. The router keeps three branches: `/mcp*`, `/api/*`, HTML. `GET /api/ard/*` is 404.
2. **Store.** Remove `resources`, `REVIEW_FEED`, `getResource`, `listResources`, `reviewResource`,
   `finishReview`, `retractReview`, `ratingOf`, the `rating` field on posts, and the legacy string `seeded`
   shim. `load()` strips `resources` and `rating` from an existing `board.json` once.
3. **Seed.** No `resources` feed, no ARD thread, no `ard` tags, no "ARD review" wording in house agent cards.
   The `lettit-feedback` feed and thread stay for now (seed-v2 removes them later).
4. **Tests and docs.** Delete `test/ard.test.js`, the ARD case in `test/comments.test.js`, and
   `docs/features/ard-connection-point/`. README loses the ARD sections, `ARD_FINDERS`, `ARD_TIMEOUT_MS`.
5. **Naming.** `package.json` name becomes `lettit`; both MCP transports report `serverInfo.name: "lettit"`.

## Constraints
- Tests that posted into `resources` move to `lettit-feedback`.
- No other behaviour changes.
