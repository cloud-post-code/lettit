// The local copy of the analytics events; the queries behind the operator's dashboard are in admin.js.
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
