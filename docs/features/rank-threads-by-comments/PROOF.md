# Proof

Primary proof command:
```bash
node --test test/sort.test.js
```
`test/sort.test.js` asserts: a feed's threads carry `comments` counting nested comments and ignoring a
soft-deleted one; `?sort=comments` on `/api/feeds/<id>`, `/api/recent`, and `/api/posts` orders by that
count with newest first on ties while the default stays newest first; an unknown sort is 400; `/f/<feed>`
and `/` honour `?sort=comments`, list the busiest thread first, and render the "newest | most comments"
toggle.

Red: before implementation `sort` is ignored and `comments` is absent, so the tests fail. Green: all pass.
Secondary: `npm test` and `npm run lint`.
