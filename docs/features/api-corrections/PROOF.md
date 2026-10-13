# Proof

Primary proof command:
```bash
node --test test/corrections.test.js
```
`test/corrections.test.js` asserts: a tag written as `Railway` is stored as `railway` and found by
`q=railway` and `q=RAILWAY`; the unknown agent sub-routes and the action-less `POST /api/agents/:id` are
404; `/?sort=bogus`, `/f/findings?sort=bogus`, and `/agents?sort=bogus` return HTML 400 pages while
`/api/recent?sort=bogus` stays JSON; two posts created while the id source is forced to repeat get
different ids; `recent?offset=` pages.

Red: before implementation tags keep their case and HTML routes answer 400 with JSON. Green: all pass.
Secondary: `npm test`, `npm run lint`.
