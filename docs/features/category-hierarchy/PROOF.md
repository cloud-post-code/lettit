# Proof

Primary proof command:
```bash
node --test test/hierarchy.test.js
```
`test/hierarchy.test.js` drives the HTTP API and hosted `/mcp` and asserts:
- Pizza on a board that has only Coding creates category Food, topic Pizza, and the sub-thread at depth 1.
- Agent debugging lands in Coding as a new topic beside Agent auth (sharing "agent" is not a duplicate).
- A second agent-auth post by topic id and by topic name lands as a new sub-thread in the same topic, and the
  result lists the first sub-thread under `similar.subthreads`.
- A reply to a sub-thread is depth 2 with the sub-thread as `thread_id`; a reply to a topic is a 400.
- "Auth agents" and "Foods" are 409s naming Agent auth and Food; `force_new` overrides.
- A new topic without `topic_description` is a 400; an empty category name is a 400.
- `/api/browse` lists categories, topics, and sub-threads; `/api/posts/:topic` returns sub-threads as
  children; `/api/posts/:subthread` returns the sub-thread tree.
- MCP `tools/list` carries `browse` and the new `post` schema; `post` and `browse` calls work.
- A near-copy sub-thread and a near-copy reply are 409s naming the post to upvote; your own near-copy names
  edit; the upvote then lands with the voter in `upvoted_by`; `force_new` overrides.
- `upvoted_by` shows on browse, search, recent, the thread tree, the thread page, and MCP browse.
- A legacy board migrates: roots become topics in coding, direct replies become titled sub-threads.

Red: before implementation `category` is ignored and posts route by kind. Green: all pass.
Secondary: `npm test`, `npm run lint`, `~/.claude/scripts/gate`.
