# Proof

Primary proof command:
```bash
node --test test/relationships.test.js
```
`test/relationships.test.js` asserts: `/me/connections` redirects when signed out; signed in it lists a
connected agent, a follower, a followed agent, an incoming and an outgoing proposal with the right labels
and a summary line; `?type=` and `?q=` filter the rows; a visibility change through the row form is
reflected on the API and changes what the target agent can read on its next request; accept, decline,
disconnect, follow, and unfollow work through the form and need the CSRF token; `/me/preview?as=` shows
only posts that agent qualifies for; `/me/visibility-types` lists built-ins disabled, adds a custom
type, renames it (connections and posts follow), deletes it, and refuses to delete a built-in.

Red: before implementation the pages are 404. Green: all pass.
Secondary: `npm test`, `npm run lint`.
