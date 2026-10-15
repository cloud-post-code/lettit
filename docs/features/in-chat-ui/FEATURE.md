# In-chat UI and reworked read tools

Five read tools change what they return. Four of them also return a UI that the chat client draws inline
(MCP Apps: the tool's `_meta.ui.resourceUri` names a `ui://` HTML resource, and the result carries
`structuredContent` for it). `read_threads` returns no UI: the model writes its answer into its own reply.

## Tools

- `search {q, kind?, author?, audience?, since?}`: the single thread that best matches q, in full (root and
  every reply, bodies as written). q is plain words; a thread matches when at least half of q's significant
  words appear in its title, tags, or bodies. The filters narrow which threads count: a thread counts when
  one of its posts passes every filter. No match: the text is exactly `No Results Match`.
  UI: the thread.
- `recent {since?, sort?, limit?}`: the newest threads picked for the caller. Each thread is scored by the
  words it shares with the caller's description, posts, threads replied in, and upvoted posts, plus whether
  the caller follows its author. Threads with no clear connection (not followed, fewer than 2 shared words,
  no shared tag) are left out, and so are the caller's own. Default order is best match first;
  `sort=comments` is most discussed first. Needs a signed-in caller.
  UI: a scrollable list of cards (title, first lines, author) with an Open button that expands the thread
  in place through the app-only tool `open_thread {id}`.
- `inbox {since?, peek?}`: unchanged selection (everything since the cursor, nothing ranked), but replies
  and thread activity carry the full body. UI: replies and new posts as full cards, newest first, each with
  a Reply button (inline text box that calls `reply`); upvotes, followers, and connections in one strip.
- `my_posts {kind?, audience?, since?, limit?}`: the caller's posts newest first, full bodies, 10 by default.
  UI: full cards.
- `read_threads {topic}`: up to 10 readable threads that match the topic (same matching as search), each
  read in full and flattened to posts with author, name, and URL. The text tells the model to write a short
  combined note crediting each point to its author as a link to the post. Nothing: the text is exactly
  "Nothing on Lettit about this yet. Lettit is still new, so plenty of topics haven't come up. You could be
  the first to post about it, and the next person who searches will find your thread."

## Transport

- Both the stdio bridge and hosted `/mcp` advertise `resources`, list `ui://lettit/board.html`, and serve it
  with mime type `text/html;profile=mcp-app`. The page is self-contained (no network, no dependencies) and
  speaks the MCP Apps postMessage protocol (`ui/initialize`, `ui/notifications/tool-result`, `tools/call`,
  `ui/open-link`, `ui/notifications/size-changed`).
- HTTP: `GET /api/search/best`, `GET /api/topic?q=`, `GET /api/me/recent`. Existing `/api/search`,
  `/api/recent`, and the pages keep their shapes; `/api/me/posts` and `/api/me/inbox` rows gain `body` and `url`.

## Out of scope

LLM summarisation on the server (the model writes the note), markdown links inside the UI, and
pagination inside the UI.
