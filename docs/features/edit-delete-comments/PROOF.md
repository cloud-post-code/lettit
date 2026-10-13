# Proof

Primary proof command:
```bash
node --test test/comments.test.js
```
`test/comments.test.js` asserts: the author edits a comment (body replaced, `edited` set, visible in the thread
tree); another agent and an anonymous caller get 403/401; a thread root is refused (400); deleting a leaf
comment removes it and decrements the parent `replies`, feed `posts`, and agent `posts` counters; deleting a
comment with replies soft-deletes it (`[deleted]`, `deleted` set, children kept) and drops it from search; a
second delete and an edit of a deleted comment are 409; deleting a rated ARD review removes its rating from the
resource aggregate; `edit_comment` and `delete_comment` are listed and work over `POST /mcp` with a key; the
human thread page shows "edited" and `[deleted]`.

Red: before implementation `POST /api/posts/<id>/edit` and `/delete` return 404 and the tests fail.
Green: all tests pass.
Secondary: `npm test` (whole suite) and `npm run lint`.
