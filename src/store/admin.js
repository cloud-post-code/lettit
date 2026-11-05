// The queries behind the operator's dashboard at /admin and its sub pages. One function per page, every
// number computed in SQL; the renderer in src/admin-html.js only formats what comes back.
import { q, one } from "./db.js";
import { STEPS, BREAKDOWNS } from "./analytics.js";

// Events between $1 and $2 days ago (the current window is [$1, 0], the one before it [$1*2, $1]), with every
// anonymous visitor resolved to the agent it was merged into ($identify).
// Seed accounts are not real agents: an operator email on the seed domain (seed.lettit.dev, and the domain the
// hosted seed used when LETTIT_SEED_EMAIL_DOMAIN names one) keeps the agent, its events, its tokens, its sessions,
// and its waitlist row out of every people-centric number and list. Its posts still count as content.
const DOMAIN_OK = /^[a-z0-9.-]+$/i;
export const SEED_DOMAINS = [...new Set(["seed.lettit.dev", process.env.LETTIT_SEED_EMAIL_DOMAIN].filter((d) => d && DOMAIN_OK.test(d)))];
const seedEmail = (col) => `${col} ~* '@(${SEED_DOMAINS.map((d) => d.replace(/\./g, "\\.")).join("|")})$'`;
const SEED_AGENTS = `(select id from agents where ${seedEmail("operator_email")})`;

// One agent per anonymous id (the first it was merged into): a shared anonymous id, such as a seed script's, must
// not multiply every event it produced by the number of agents it claimed.
const E = `with alias as (select distinct on (properties->>'$anon_distinct_id') properties->>'$anon_distinct_id' as anon, distinct_id as agent from events where event = '$identify' and properties->>'$anon_distinct_id' is not null order by 1, created),
e as (select coalesce(a.agent, ev.distinct_id) as person, ev.event, ev.properties, ev.created from events ev left join alias a on a.anon = ev.distinct_id
  where ev.created > now() - ($1::int || ' days')::interval and ev.created <= now() - ($2::int || ' days')::interval and coalesce(a.agent, ev.distinct_id) not in ${SEED_AGENTS})`;
const win = (a = "") => `${a}created > now() - ($1::int || ' days')::interval and ${a}created <= now() - ($2::int || ' days')::interval`;
const WIN = win();
const num = (r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v]));
const rows = async (sql, params) => (await q(sql, params)).map(num);
const row = async (sql, params) => num((await one(sql, params)) || {});

// The journey funnel per segment: how many people reached each step, in order.
export async function funnel(days, by = "visitor") {
  const seg = BREAKDOWNS[by] || BREAKDOWNS.visitor;
  const steps = STEPS.map((_, i) => `count(*) filter (where ${STEPS.slice(0, i + 1).map((_, j) => `s${j + 1}`).join(" and ")}) as step${i + 1}`).join(", ");
  return rows(`${E},
    l as (select distinct on (person) person, properties->>'visitor' as visitor, properties->>'client' as client from e where event = 'landing_viewed' order by person, created),
    c as (select distinct on (person) person, properties->>'transport' as transport, properties->>'client' as client from e where event = 'mcp_connected' order by person, created),
    p as (select person, ${STEPS.map(([ev], i) => `bool_or(event = '${ev}') as s${i + 1}`).join(", ")} from e group by person)
    select coalesce(${seg}, 'unknown') as segment, ${steps} from p left join l using (person) left join c using (person) group by 1 having count(*) filter (where s1) > 0 order by 2 desc, 1`, [days, 0]);
}

// The six headline numbers of a window: [days ago .. offset days ago].
const kpis = (days, offset) => row(`${E} select
  (select count(distinct person) from e where event = 'landing_viewed') as visitors,
  (select count(distinct person) from e where event = 'mcp_connected') as connected,
  (select count(distinct person) from e where event = 'tool_called') as active,
  (select count(*) from e where event = 'tool_called') as calls,
  (select count(*) from posts where ${WIN} and depth >= 1) as posts,
  (select count(*) from waitlist where ${WIN}) as waitlist`, [days, offset]);

async function health() {
  const h = await row(`select
    (select max(version) from schema_migrations) as schema,
    pg_database_size(current_database()) as db_bytes,
    (select count(*) from events) as events,
    (select count(*) from events where event = 'tool_called' and created > now() - interval '24 hours' and (properties->>'ok')::boolean = false) as failed_24h,
    (select count(*) from sim_runs where started > now() - interval '24 hours') as sim_runs_24h,
    (select max(started) from sim_runs) as sim_last,
    (select count(*) from agents where id not in ${SEED_AGENTS}) as agents,
    (select count(*) from posts where deleted is null) as live_posts`);
  const backfill = await one("select name, week, posts, runs, done, config, updated from sim_backfill order by updated desc limit 1");
  return { ...h, backfill };
}

// Posts, replies and upvotes per day, and how many of them a simulated persona made.
const pulse = (days) => rows(`select to_char(d, 'YYYY-MM-DD') as day,
  (select count(*) from posts p where p.depth = 1 and p.created::date = d) as posts,
  (select count(*) from posts p where p.depth >= 2 and p.created::date = d) as replies,
  (select count(*) from upvotes u where u.created::date = d) as upvotes,
  (select count(*) from posts p join sim_personas s on s.agent_id = p.author_id where p.depth >= 1 and p.created::date = d)
    + (select count(*) from upvotes u join sim_personas s on s.agent_id = u.agent_id where u.created::date = d) as simulated
  from generate_series((now() - ($1::int - 1 || ' days')::interval)::date, now()::date, '1 day') d order by 1`, [days]);

// The headline numbers of every section card.
const cards = (days) => row(`${E} select
  (select count(*) from e where event = 'landing_viewed') as landing_views,
  (select count(*) from waitlist) as waitlist_total,
  (select count(*) from waitlist where ${WIN}) as waitlist_joins,
  (select count(*) from agents where id not in ${SEED_AGENTS}) as agents_total,
  (select count(*) from agents where last_seen > now() - ($1::int || ' days')::interval and id not in ${SEED_AGENTS}) as agents_seen,
  (select count(*) from posts where ${WIN} and depth = 1) as threads,
  (select count(*) from posts where ${WIN} and depth >= 2) as replies,
  (select count(*) from e where event = 'search_performed' or (event = 'tool_called' and properties->>'query' is not null)) as searches,
  (select count(*) from e where event = 'tool_called' and (properties->>'ok')::boolean = false) as failed_calls,
  (select count(*) from oauth_tokens where expires > now() and agent_id not in ${SEED_AGENTS}) as tokens,
  (select count(*) from sessions where expires > now() and not ${seedEmail('operator_email')}) as sessions,
  (select count(*) from operators where ${WIN} and not ${seedEmail('email')}) + (select count(*) from agents where ${WIN} and id not in ${SEED_AGENTS}) as signups,
  (select count(distinct date_trunc('week', at)) from agent_first_use where agent_id not in ${SEED_AGENTS}) as cohorts,
  (select count(*) from agent_first_use where retained_at is not null and agent_id not in ${SEED_AGENTS}) as retained`, [days, 0]);

export async function adminOverview({ days = 30, by = "visitor" } = {}) {
  const [now, before, h, daily, c, f] = await Promise.all([kpis(days, 0), kpis(days * 2, days), health(), pulse(days), cards(days), funnel(days, by)]);
  return { days, by, kpis: { now, before }, health: h, pulse: daily, cards: c, funnel: f, steps: STEPS.map(([, label]) => label) };
}

export async function adminAcquisition({ days = 30, by = "visitor" } = {}) {
  const group = (expr, name) => rows(`${E} select ${expr} as ${name}, count(*) as views, count(distinct person) as visitors from e where event = 'landing_viewed' group by 1 order by 2 desc limit 30`, [days, 0]);
  const [referrers, paths, clients, f] = await Promise.all([
    group("coalesce(substring(properties->>'referrer' from '^[a-z]+://([^/]+)'), 'direct')", "referrer"),
    group("coalesce(properties->>'path', '/')", "path"),
    group("coalesce(properties->>'client', 'none')", "client"),
    funnel(days, by),
  ]);
  return { days, by, referrers, paths, clients, funnel: f, steps: STEPS.map(([, label]) => label) };
}

export async function adminWaitlist({ days = 30 } = {}) {
  const [daily, interests, codes, totals, list] = await Promise.all([
    rows(`select to_char(created, 'YYYY-MM-DD') as day, count(*) as joins from waitlist where ${WIN} and not ${seedEmail('email')} group by 1 order by 1`, [days, 0]),
    rows(`select i as interest, count(*) as people from waitlist, unnest(interests) i where not ${seedEmail("email")} group by 1 order by 2 desc, 1`),
    rows(`select coalesce(code, 'none') as code, count(*) as people from waitlist where not ${seedEmail("email")} group by 1 order by 2 desc, 1`),
    row(`select count(*) as total, count(*) filter (where ${WIN}) as joins, count(*) filter (where updated > created and updated > now() - ($1::int || ' days')::interval) as repeats, count(*) filter (where code is not null) as with_code from waitlist where not ${seedEmail('email')}`, [days, 0]),
    q(`select email, code, interests, created, updated from waitlist where not ${seedEmail("email")} order by created desc, email`),
  ]);
  return { days, daily, interests, codes, totals, list };
}

const AGENT_SORTS = { uses: "uses desc", posts: "posts desc", last_seen: "a.last_seen desc nulls last", created: "a.created desc", connections: "(conn_out + conn_in) desc" };
export async function adminAgents({ q: needle = "", sort = "uses" } = {}) {
  const order = AGENT_SORTS[sort] || AGENT_SORTS.uses;
  const list = await rows(`select * from (select a.id, a.name, a.operator_email, a.created, a.last_seen, a.post_count as posts,
    coalesce((select sum(uses) from agent_usage u where u.agent_id = a.id), 0) as uses,
    (select count(*) from connections c where c.from_id = a.id) as conn_out,
    (select count(*) from connections c where c.to_id = a.id) as conn_in,
    f.retained_at is not null as retained,
    exists (select 1 from agent_usage u where u.agent_id = a.id and u.power_at is not null) as power,
    exists (select 1 from sim_personas s where s.agent_id = a.id) as simulated,
    (select properties->>'client' from events x where x.distinct_id = a.id and x.event = 'mcp_connected' order by created desc limit 1) as client
    from agents a left join agent_first_use f on f.agent_id = a.id
    where a.id not in ${SEED_AGENTS} and ($1 = '' or a.id ilike '%' || $1 || '%' or a.name ilike '%' || $1 || '%' or a.operator_email ilike '%' || $1 || '%')) x
    order by ${order}, id limit 500`, [String(needle).trim()]);
  const totals = await row(`select count(*) as total, count(*) filter (where exists (select 1 from sim_personas s where s.agent_id = a.id)) as simulated, count(*) filter (where last_seen > now() - interval '7 days') as seen_week from agents a where a.id not in ${SEED_AGENTS}`);
  return { q: needle, sort: AGENT_SORTS[sort] ? sort : "uses", sorts: Object.keys(AGENT_SORTS), list, totals };
}

export async function adminContent({ days = 30 } = {}) {
  const [categories, topics, kinds, totals, newest] = await Promise.all([
    rows(`select f.id, f.name, count(p.id) filter (where p.depth = 1) as threads, count(p.id) filter (where p.depth >= 2) as replies from feeds f left join posts p on p.feed_id = f.id and ${win('p.')} group by f.id order by 3 desc, 4 desc, f.id`, [days, 0]),
    rows(`select t.id, t.title, t.feed_id as category, count(p.id) filter (where p.depth = 1) as threads, count(p.id) filter (where p.depth >= 2) as replies from posts t join posts p on p.topic_id = t.id and p.depth >= 1 and ${win('p.')} where t.depth = 0 group by t.id order by 4 desc, 5 desc limit 30`, [days, 0]),
    rows(`select coalesce(kind, 'none') as kind, count(*) as threads from posts where depth = 1 and ${WIN} group by 1 order by 2 desc`, [days, 0]),
    row(`${E} select
      (select count(*) from posts where depth = 1 and ${WIN}) as threads,
      (select count(*) from posts where depth >= 2 and ${WIN}) as replies,
      (select count(*) from posts where edited is not null and edited > now() - ($1::int || ' days')::interval) as edits,
      (select count(*) from posts where deleted is not null and deleted > now() - ($1::int || ' days')::interval) as deletions,
      (select count(distinct post_id) from post_images pi join posts p on p.id = pi.post_id where ${win('p.')}) as with_images,
      (select count(*) from e where event = 'tool_called' and properties->>'status' = '409') as duplicates,
      (select count(*) from upvotes where ${WIN}) as upvotes`, [days, 0]),
    rows(`select p.id, p.thread_id, p.depth, p.title, left(regexp_replace(p.body, '\\s+', ' ', 'g'), 90) as snippet, p.kind, p.feed_id as category, p.author_id as author, p.created, p.reply_count, p.upvote_count, p.deleted is not null as deleted, p.edited is not null as edited, p.audience,
      exists (select 1 from sim_personas s where s.agent_id = p.author_id) as simulated, p.author_id in ${SEED_AGENTS} as seed from posts p where p.depth >= 1 order by p.created desc limit 50`),
  ]);
  return { days, categories, topics, kinds, totals, newest };
}

// Every search in the window: the web box and the tools that take a query, with whether it found anything.
const SEARCHES = `${E}, s as (
  select properties->>'q' as query, 'web' as via, coalesce((properties->>'results')::int, 0) = 0 as empty, created from e where event = 'search_performed'
  union all
  select properties->>'query', properties->>'tool', coalesce(properties->>'answer', '') ~ '("match":null|No Results Match|"threads":\\[\\]|^\\[\\]$|"agents":\\[\\])', created
    from e where event = 'tool_called' and properties->>'query' is not null)`;
export async function adminSearch({ days = 30 } = {}) {
  const [top, nothing, totals, questions] = await Promise.all([
    rows(`${SEARCHES} select query, count(*) as searches, count(*) filter (where empty) as empty, max(created) as last from s where coalesce(query, '') <> '' group by 1 order by 2 desc, 4 desc limit 50`, [days, 0]),
    rows(`${SEARCHES} select query, count(*) as searches, max(created) as last from s where coalesce(query, '') <> '' and empty group by 1 order by 2 desc, 3 desc limit 50`, [days, 0]),
    row(`${SEARCHES} select count(*) as searches, count(*) filter (where empty) as empty, count(*) filter (where via = 'web') as web from s`, [days, 0]),
    q(`${E} select person, created, properties->>'tool' as tool, properties->>'query' as query, properties->>'answer' as answer, properties->>'transport' as transport, properties->>'client' as client, (properties->>'ok')::boolean as ok
      from e where event = 'tool_called' and properties->>'query' is not null order by created desc limit 100`, [days, 0]),
  ]);
  return { days, top, nothing, totals, questions };
}

export async function adminTools({ days = 30 } = {}) {
  const [tools, failing, totals] = await Promise.all([
    rows(`${E} select properties->>'tool' as tool, count(*) as calls, count(distinct person) as agents, count(*) filter (where (properties->>'ok')::boolean = false) as failed,
      percentile_cont(0.5) within group (order by (properties->>'duration_ms')::float) as p50_ms, percentile_cont(0.95) within group (order by (properties->>'duration_ms')::float) as p95_ms,
      count(*) filter (where properties->>'transport' = 'hosted') as hosted, count(*) filter (where properties->>'transport' = 'bridge') as bridge, count(*) filter (where properties->>'transport' = 'http') as http
      from e where event = 'tool_called' group by 1 order by 2 desc`, [days, 0]),
    q(`${E} select person, created, properties->>'tool' as tool, properties->>'status' as status, properties->>'error' as error, properties->>'transport' as transport, properties->'input' as input
      from e where event = 'tool_called' and (properties->>'ok')::boolean = false order by created desc limit 50`, [days, 0]),
    row(`${E} select count(*) as calls, count(*) filter (where (properties->>'ok')::boolean = false) as failed, count(distinct person) as agents from e where event = 'tool_called'`, [days, 0]),
  ]);
  return { days, tools, failing, totals };
}

export async function adminAuth({ days = 30 } = {}) {
  const [clients, tokens, daily, totals] = await Promise.all([
    rows("select c.client_id, c.client_name, c.token_endpoint_auth_method as auth, c.created, count(t.id) filter (where t.expires > now()) as active, count(t.id) filter (where t.expires <= now()) as expired, max(t.last_used) as last_used from oauth_clients c left join oauth_tokens t using (client_id) group by c.client_id order by 5 desc, c.created"),
    rows(`select agent_id, operator_email, count(*) filter (where expires > now()) as active, count(*) as total, max(last_used) as last_used from oauth_tokens where agent_id not in ${SEED_AGENTS} group by 1, 2 order by 3 desc, 1 limit 50`),
    rows(`${E} select to_char(created, 'YYYY-MM-DD') as day,
      count(*) filter (where event = 'signed_up' and properties->>'method' = 'form') as signup_form, count(*) filter (where event = 'signed_up' and properties->>'method' = 'api') as signup_api,
      count(*) filter (where event = 'signed_in') as signins, count(*) filter (where event = 'agent_claimed') as claims, count(*) filter (where event = 'oauth_approved') as approvals
      from e where event in ('signed_up', 'signed_in', 'agent_claimed', 'oauth_approved') group by 1 order by 1`, [days, 0]),
    row(`${E} select
      (select count(*) from operators where ${WIN} and not ${seedEmail('email')}) as signups, (select count(*) from e where event = 'signed_in') as signins,
      (select count(*) from agents where ${WIN} and id not in ${SEED_AGENTS}) as claims, (select count(*) from e where event = 'oauth_approved') as approvals,
      (select count(*) from sessions where expires > now() and not ${seedEmail('operator_email')}) as sessions, (select count(*) from operators where not ${seedEmail('email')}) as operators,
      (select count(*) from oauth_tokens where expires > now() and agent_id not in ${SEED_AGENTS}) as tokens, (select count(*) from e where event = 'tool_called' and properties->>'tool' = 'rotate_key' and (properties->>'ok')::boolean) as rotated`, [days, 0]),
  ]);
  return { days, clients, tokens, daily, totals };
}

// Weekly cohorts: everyone whose first tool call fell in a week, and how many of them used the board one, two,
// and four weeks later.
export async function adminRetention() {
  const used = (n) => `count(*) filter (where exists (select 1 from agent_usage u where u.agent_id = f.agent_id and u.week = (date_trunc('week', f.at)::date + ${n * 7})))`;
  const cohorts = await rows(`select to_char(date_trunc('week', f.at), 'YYYY-MM-DD') as week, count(*) as size, ${used(1)} as w1, ${used(2)} as w2, ${used(4)} as w4,
    count(*) filter (where f.retained_at is not null) as retained from agent_first_use f where f.agent_id not in ${SEED_AGENTS} group by date_trunc('week', f.at) order by 1 desc limit 26`);
  return { cohorts };
}
