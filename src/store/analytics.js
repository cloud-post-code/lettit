// The local copy of the analytics events, and the queries behind the operator's dashboard at /admin.
import { q } from "./db.js";

export const STEPS = [["landing_viewed", "Sees landing page"], ["mcp_connected", "Connected to MCP"], ["tool_called", "First read or write"], ["retained_week_one", "Back after one week"], ["power_week", "50 uses in a week"]];
export const BREAKDOWNS = { visitor: "l.visitor", client: "coalesce(l.client, c.client)", transport: "c.transport" };

// One insert per batch: the same rows that go to PostHog.
export async function recordEvents(batch) {
  if (!batch.length) return;
  await q("insert into events (event, distinct_id, properties, created) select * from unnest($1::text[], $2::text[], $3::jsonb[], $4::timestamptz[])",
    [batch.map((e) => e.event), batch.map((e) => e.distinct_id), batch.map((e) => JSON.stringify(e.properties || {})), batch.map((e) => e.timestamp)]);
}
export const sweepEvents = () => q("delete from events where event = 'tool_called' and created < now() - interval '90 days'");

// Events in the window with every anonymous visitor resolved to the agent it was merged into ($identify).
const RESOLVED = `with alias as (select distinct properties->>'$anon_distinct_id' as anon, distinct_id as agent from events where event = '$identify' and properties->>'$anon_distinct_id' is not null),
e as (select coalesce(a.agent, ev.distinct_id) as person, ev.event, ev.properties, ev.created from events ev left join alias a on a.anon = ev.distinct_id where ev.created > now() - ($1::int || ' days')::interval)`;

// Everything the dashboard draws, for the last `days` days, the funnel broken down by `by`.
export async function dashboard({ days = 30, by = "visitor" } = {}) {
  const seg = BREAKDOWNS[by] || BREAKDOWNS.visitor;
  const steps = STEPS.map(([ev], i) => `count(*) filter (where ${STEPS.slice(0, i + 1).map((_, j) => `s${j + 1}`).join(" and ")}) as step${i + 1}`).join(", ");
  const funnel = await q(`${RESOLVED},
    l as (select distinct on (person) person, properties->>'visitor' as visitor, properties->>'client' as client from e where event = 'landing_viewed' order by person, created),
    c as (select distinct on (person) person, properties->>'transport' as transport, properties->>'client' as client from e where event = 'mcp_connected' order by person, created),
    p as (select person, ${STEPS.map(([ev], i) => `bool_or(event = '${ev}') as s${i + 1}`).join(", ")} from e group by person)
    select coalesce(${seg}, 'unknown') as segment, ${steps} from p left join l using (person) left join c using (person) group by 1 having count(*) filter (where s1) > 0 order by 2 desc, 1`, [days]);
  const daily = await q(`${RESOLVED} select to_char(created, 'YYYY-MM-DD') as day,
    count(*) filter (where event = 'landing_viewed' and properties->>'visitor' = 'human') as human, count(*) filter (where event = 'landing_viewed' and properties->>'visitor' <> 'human') as agent,
    count(*) filter (where event = 'tool_called') as calls, count(distinct person) filter (where event = 'tool_called') as active, count(distinct person) filter (where event = 'mcp_connected') as connected
    from e group by 1 order by 1`, [days]);
  const tools = await q(`${RESOLVED} select properties->>'tool' as tool, count(*) as calls, count(distinct person) as agents, count(*) filter (where (properties->>'ok')::boolean = false) as failed from e where event = 'tool_called' group by 1 order by 2 desc limit 15`, [days]);
  const questions = await q(`${RESOLVED} select person, created, properties->>'tool' as tool, properties->>'query' as query, properties->>'answer' as answer, properties->>'transport' as transport, properties->>'client' as client, (properties->>'ok')::boolean as ok from e where event = 'tool_called' and properties->>'query' is not null order by created desc limit 100`, [days]);
  const agents = await q(`${RESOLVED} select person, min(created) as first_seen, max(created) as last_seen, count(*) filter (where event = 'tool_called') as uses,
    bool_or(event = 'mcp_connected') as connected, bool_or(event = 'retained_week_one') as retained, bool_or(event = 'power_week') as power,
    (select properties->>'client' from e x where x.person = e.person and x.event = 'mcp_connected' order by created limit 1) as client
    from e where person not like 'v:%' and person not in (select anon from alias) and exists (select 1 from e y where y.person = e.person and y.event in ('mcp_connected', 'tool_called', 'signed_up', 'agent_claimed'))
    group by person order by uses desc, last_seen desc limit 50`, [days]);
  const totals = await q(`${RESOLVED} select count(distinct person) filter (where event = 'landing_viewed') as visitors, count(distinct person) filter (where event = 'mcp_connected') as connected, count(distinct person) filter (where event = 'tool_called') as active, count(*) filter (where event = 'tool_called') as calls, count(*) filter (where event = 'tool_called' and properties->>'query' is not null) as questions from e`, [days]);
  const num = (r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v]));
  return { days, by, steps: STEPS.map(([, label]) => label), funnel: funnel.map(num), daily: daily.map(num), tools: tools.map(num), questions, agents: agents.map(num), totals: num(totals[0] || {}) };
}
