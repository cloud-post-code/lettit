# Proof

Primary proof command:
```bash
node --test test/admin-pages.test.js
```
`test/admin-pages.test.js` boots the server with admin credentials on a fresh schema, plays one journey (a
human lands from a referrer, signs up, claims an agent, connects, searches with and without results, posts
a thread and a reply, upvotes, a second agent is simulated, a waitlist join with a code and picks, an OAuth
client with a token, a key rotation) and asserts:
- every sub page is 401 without credentials and 200 with them, `cache-control: no-store`;
- `/admin` shows the six KPI tiles with a delta each (`new` when the previous window is empty), the
  health row with the schema version, failed calls, simulator and backfill state, the content pulse chart,
  a card linking to each of the eight sub pages, and no longer the waitlist table or the questions table;
- `days` and `by` from `/admin?days=7&by=client` are carried in every sub page link;
- `/admin/acquisition` lists the referrer host, the path, the client with their counts, and the funnel with
  conversion percentages;
- `/admin/waitlist` lists the interest counts, the invite code count, the address, and the CSV link;
- `/admin/agents` lists both agents with uses, posts, connections, the simulated flag, finds one with `q`,
  and orders by `sort=posts`;
- `/admin/content` shows the category and topic counts, the kind distribution, one edit, one deletion, the
  409 count, and the newest post with a link;
- `/admin/search` lists the query with results and the one with none under "found nothing", and the
  questions table;
- `/admin/tools` lists each tool with calls, failures, a duration, and the failing call with its status
  and error;
- `/admin/auth` lists the OAuth client with one active token, one open session, the sign-up, the claim,
  and one rotated key;
- `/admin/retention` draws a cohort row for this week with size 1 or more;
- an unknown `/admin/nope` is 404.

Red: before implementation every `/admin/<page>` is routed to the site and `src/store/admin.js` does not
exist. Green: all pass.
Secondary: `node --test test/admin.test.js test/waitlist.test.js`, `npm test`, `npm run lint`,
`~/.claude/scripts/gate`.
