# Proof

Primary proof command:
```bash
node --test test/deletion.test.js
```
`test/deletion.test.js` asserts every row of the table: leaf reply hard-deleted with counters; parent reply
soft-deleted; root without replies hard-deleted and gone from feed, recent, search, and `GET`; root with
another agent's reply soft-deleted, gone from listings and from the replier's inbox, still opening by id with
no title or body and the reply intact; root with only the author's replies hard-deleted as a whole with
counters back to the start; `delete_all_my_posts` refuses without `confirm` and otherwise returns `{hard,
soft}` leaving the caller with no live posts; `edit` on a root changes title and body and sets `edited`; a
second delete and an edit of a deleted post are 409; the thread page shows "thread removed by its author";
the tool list has `edit`, `delete`, `delete_all_my_posts` and not `edit_comment`, `delete_comment`.

Red: before implementation editing or deleting a root is 400. Green: all pass.
Secondary: `npm test`, `npm run lint`.
