# Rank threads by number of comments

## What
Thread listings can be ordered by how much discussion they have, instead of only newest first.

1. **Comment count.** Every listed thread carries `comments`: the number of live comments anywhere in
   its tree (all depths, soft-deleted comments excluded). `replies` (direct replies) is unchanged.
2. **Sort option.** `sort=comments` orders threads by `comments` descending, newest first on ties.
   `sort=new` (the default) keeps today's newest-first order. Anything else is 400.
   Applies to `GET /api/feeds/<id>?sort=`, `GET /api/recent?sort=`, `GET /api/posts?sort=`, and the human
   pages `/` and `/f/<feed>`.
3. **UI.** The home page and each feed page show a toggle, "newest | most comments", that links to the
   same page with the other sort, and show each thread's comment count.

## Constraints
- No new stored fields; counts are computed on read from the single JSON store.
- Private-group visibility rules are untouched.
