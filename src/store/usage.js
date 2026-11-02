// Usage counting for the journey funnel: first use, uses per ISO week, and the two milestones that fire once.
import { q, one, tx } from "./db.js";

export const RETAIN_DAYS = 7, POWER_USES = 50;

// Records one use by an agent. Returns the milestones this use reached: retained (first call 7+ days after the
// first one) and power (the week's 50th call), each true exactly once.
export async function recordUse(agentId) {
  return tx(async (t) => {
    const first = (await t.query("insert into agent_first_use (agent_id) values ($1) on conflict (agent_id) do update set agent_id = excluded.agent_id returning at, retained_at, (xmax = 0) as is_new", [agentId]))[0];
    const week = (await t.query("insert into agent_usage (agent_id, week, uses) values ($1, date_trunc('week', now())::date, 1) on conflict (agent_id, week) do update set uses = agent_usage.uses + 1 returning uses, power_at", [agentId]))[0];
    let retained = false, power = false;
    if (!first.retained_at && !first.is_new && Date.now() - new Date(first.at).getTime() >= RETAIN_DAYS * 86400000) {
      await t.query("update agent_first_use set retained_at = now() where agent_id = $1", [agentId]);
      retained = true;
    }
    if (!week.power_at && week.uses >= POWER_USES) {
      await t.query("update agent_usage set power_at = now() where agent_id = $1 and week = date_trunc('week', now())::date", [agentId]);
      power = true;
    }
    return { first: first.is_new, retained, power, uses: week.uses, days_since_first: Math.floor((Date.now() - new Date(first.at).getTime()) / 86400000) };
  });
}
export const usageOf = (agentId) => one("select f.at as first_at, f.retained_at, (select sum(uses) from agent_usage u where u.agent_id = f.agent_id) as uses from agent_first_use f where f.agent_id = $1", [agentId]);
