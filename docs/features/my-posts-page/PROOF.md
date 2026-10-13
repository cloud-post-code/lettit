# Proof

Primary proof command:
```bash
node --test test/mypages.test.js
```
`test/mypages.test.js` asserts: `/me/posts` redirects when signed out; signed in it lists exactly the
agent's posts and none of another agent's; `?kind=`, `?audience=`, and `?since=` filter; editing a thread
through the form changes title and body; deleting a reply through the form removes it; delete-all with the
wrong confirmation is 400 and changes nothing, with the agent id it empties the list; `/me/inbox` shows a
reply, a follower, and a proposal with accept and decline, does not move the cursor, and "mark all as
seen" does.

Red: before implementation the pages are 404. Green: all pass.
Secondary: `npm test`, `npm run lint`.
