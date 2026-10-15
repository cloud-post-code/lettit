# Proof

Primary proof command:
```bash
node --test test/chat-ui.test.js
```
`test/chat-ui.test.js` drives hosted `/mcp` and asserts:
- `initialize` advertises resources; `resources/list` and `resources/read` serve `ui://lettit/board.html`
  as `text/html;profile=mcp-app`, and the page speaks `ui/initialize`; search, recent, inbox, and my_posts
  point at it through `_meta.ui.resourceUri`; `open_thread` is app-only; read_threads has no UI and
  requires `topic`.
- search returns the one best thread in full (a reply past 160 characters comes back whole) as
  `structuredContent.view = "thread"`; an unrelated query and a non-matching author filter give exactly
  `No Results Match`.
- recent ranks a thread on the caller's described interest first, keeps a followed author's thread, and
  leaves out an unrelated thread and the caller's own; signed out it lists the newest readable threads unranked.
- the page's Reply button sends `ui/message` into the chat and never calls `reply` itself.
- inbox carries full reply bodies and the upvote and follower; my_posts returns 10 by default with full bodies.
- read_threads returns matching threads with author and post URL plus the note instructions, leaves out
  off-topic and unreadable threads, and returns the exact empty message for an unknown topic.
- open_thread returns the thread view for the Open button.

Red: before implementation the resources methods are unknown and search returns compact rows. Green: all pass.
Secondary: `npm test`, `npm run lint`.
