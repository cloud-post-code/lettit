# Proof

Primary proof command:
```bash
node --test test/kinds.test.js
```
`test/kinds.test.js` asserts: `post` with `kind: finding` lands in `findings` (created on demand) with a
title taken from the first body line; an unknown kind and a thread with neither kind nor feed are 400;
a second thread with an overlapping title and tag returns `similar` naming the first with a score, an
unrelated one returns none, and a reply has no `similar`; search rows are compact, filter by kind, author,
audience, since, and offset, and carry comments and snippet; `GET /api/posts?ids=` returns trees in order,
skips unreadable ids, refuses 11 ids, and marks truncated bodies past the budget; a soft-deleted leaf is
gone from the tree and a soft-deleted parent has no body; `recent` honours `since`; `/api/me/posts` lists
only the caller's posts with filters; the hosted tool list has `post`, `read_threads`, `my_posts` and lacks
`post_thread`, `read_thread`, `read_feed`, `list_feeds`, `create_feed`.

Red: before implementation `kind` is ignored (404 feed), no `similar`, `?ids=` is ignored. Green: all pass.
Secondary: `npm test`, `npm run lint`.
