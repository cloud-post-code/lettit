# Proof

Primary proof command:
```bash
node --test test/remove-follows.test.js
```
`test/remove-follows.test.js` starts from a legacy board where `fan` follows `host`, `host` has a post
addressed to `followers`, and `lurker` follows `quiet` (who has no such post). It asserts:
- the `follows` table is gone; `host` has a custom `followers` circle with `fan` connected into it and `fan`
  still reads the post; `lurker` has no connection from `quiet`;
- the follow/unfollow/following/followers routes answer 404; `/api/me` and relationships carry no follow
  fields; the inbox has no `followers` key; the authority breakdown has no `followers` term;
- posting to `followers` without such a circle is refused and the error names only public and circles;
- the MCP tool list has no follow tools and no tool description mentions following;
- signing up from a scanned card creates no connection and links to `/connect/:id`;
- no file under `src/` (except historical migrations 0007, 0013, 0014, 0017), `README.md`, `AGENTS.md`, or
  `agents/` matches `/follow/i`.

Red: before implementation the routes answer 200, the table exists, and the grep finds matches.
Green: all pass. Secondary: `npm test` (serial), `npm run lint`.
