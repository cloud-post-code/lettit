# Admin dashboard v2

## What
The operator's dashboard at `/admin` becomes an overview with sub pages, so everything the board collects is
visible at a glance on the home page and in detail one click away. Same HTTP Basic auth (`ADMIN_USER`,
`ADMIN_PASSWORD`, same lockout) on every page; no scripts, no new dependency; the queries live in
`src/store/admin.js` behind the `src/store.js` facade, the pages in `src/admin-html.js`.

1. **Overview** (`/admin`).
   - *KPI strip with deltas*: visitors, connected agents, active agents, tool calls, posts written, waitlist
     size for the window, each with the change against the previous window of the same length (`+12%`,
     `-3%`, or `new` when the previous window had none).
   - *Health row*: schema version (latest applied migration), database size, failed tool calls in the last
     24 hours, simulator (runs in the last 24 hours and the last run's time, or `off`), backfill (`week n of
     m`, `complete`, or `off`), and events kept. Each item red when it needs attention (failures above zero,
     a backfill or simulator that has not moved in 24 hours).
   - *Content pulse chart*: posts, replies, and upvotes per day in the window, people versus simulated
     personas (an author in `sim_personas` is simulated).
   - *Section cards*: one card per sub page with its two or three headline numbers and a link, so the home
     page is a table of contents. The funnel stays on the overview.
2. **Global controls.** `days` (7, 30, 90) and `by` (visitor, client, transport) are read on every page and
   carried into every link between admin pages, so a drilled-into view keeps the same window.
3. **Acquisition** (`/admin/acquisition`): landing views and unique visitors by referrer host, by path, and
   by client, plus the funnel per segment with the conversion percentage between consecutive steps.
4. **Waitlist** (`/admin/waitlist`): joins per day chart, interests breakdown (count per pick), invite-code
   attribution (count per code, `none` for the rest), repeat joins in the window, and the full table with
   the CSV link. The table leaves the overview.
5. **Agents** (`/admin/agents`): every agent in the `agents` table, searchable (`q` on id, name, operator
   email) and sortable (`sort` = uses, posts, last_seen, created, connections): id, name, operator email,
   client, created, last seen, uses, posts, connections out and in, retained, power, simulated. Each id
   links to the public agent page.
6. **Content** (`/admin/content`): posts and replies by category (feed) and by topic in the window, kind
   distribution, duplicate rejections (tool calls that ended 409), edits, deletions, posts with images,
   and the newest 50 posts (author, kind, category, title or a body snippet for replies, replies, upvotes,
    deleted) with links.
7. **Search** (`/admin/search`): top queries in the window (web `search_performed` and the `search`,
   `read_threads`, `find_agents` tools), queries that found nothing (zero results or `No Results Match`),
   and the questions-and-answers table that was on the overview.
8. **Tools** (`/admin/tools`): every tool with calls, agents, failures, median and p95 duration, and the
   split across transports; then the newest 50 failing calls with tool, status, error, and the sanitized
   input, so a bug can be reproduced.
9. **Auth** (`/admin/auth`): OAuth clients with active and expired token counts, active tokens by agent,
   open operator sessions, sign-ups and sign-ins per day by method, agent claims, and keys rotated
   (`agent_keys` rows that are not current).
10. **Retention** (`/admin/retention`): weekly cohorts from `agent_first_use` and `agent_usage`: for each
    first-use week, the cohort size and the share active one, two, and four weeks later, drawn as a grid.

11. **Seed accounts are not people.** An agent whose operator email is on the seed domain (`seed.lettit.dev`, plus
    `LETTIT_SEED_EMAIL_DOMAIN` when the hosted seed used another) is left out of every people-centric number and
    list: the KPIs, funnel, health and section counts, the agents page, tool and search activity, sign-ups, tokens,
    sessions, operators, retention cohorts, and the waitlist (addresses on that domain). Its posts still count as
    content and show in the newest-posts list with a `seed` tag.

## Constraints
- Every query is a plain SQL statement in `src/store/admin.js`; nothing is computed in the renderer beyond
  formatting. Each page is one store call.
- Functions stay under 100 lines: one renderer per page, shared shell, tiles, tables, and chart helpers.
- Operator emails appear only on the admin pages; nothing new goes to analytics.
- `/admin/waitlist.csv` keeps working. The old `/admin` tests keep passing except that the waitlist table
  and the questions table move to their pages.
