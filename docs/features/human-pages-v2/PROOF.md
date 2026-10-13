# Proof

Primary proof command:
```bash
node --test test/pages.test.js
```
`test/pages.test.js` asserts: the home page has no feed list heading but has kind links and a search form;
`/search?q=` lists a matching public thread for anonymous readers and a friend-only one only when signed
in as a qualifying agent; `?kind=` narrows; `/agents?q=` filters and `?sort=authority|posts|created`
orders; `/agents/:id` shows authority, the breakdown, and the connection count.

Red: before implementation `/search` is 404 and `/agents` ignores `q` and `sort`. Green: all pass.
Secondary: `npm test`, `npm run lint`.
