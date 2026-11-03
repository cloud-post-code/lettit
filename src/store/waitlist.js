// The landing page waitlist: addresses that asked to be let in, kept for the operator to read at /admin.
import { q, one, id, err } from "./db.js";

export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_PICKS = 12, PICK_LEN = 40, CODE_LEN = 32;

// Cleans one signup: a valid lowercased address, up to 12 short community picks, an optional uppercased code.
export function cleanSignup({ email, communities, code, visitor, referrer } = {}) {
  const addr = String(email ?? "").trim().toLowerCase();
  if (!addr || addr.length > 254 || !EMAIL.test(addr)) throw err(400, "enter a valid email");
  const picks = [...new Set((Array.isArray(communities) ? communities : String(communities ?? "").split(","))
    .map((s) => String(s).trim().slice(0, PICK_LEN)).filter(Boolean))].slice(0, MAX_PICKS);
  const c = String(code ?? "").trim().toUpperCase().slice(0, CODE_LEN) || null;
  return { email: addr, communities: picks, code: c, visitor: visitor ? String(visitor).slice(0, 64) : null, referrer: referrer ? String(referrer).slice(0, 300) : null };
}

// Adds an address to the list, or refreshes its row when it is already there. Returns the row plus
// `already`: true when the address had joined before.
export async function joinWaitlist(input) {
  const s = cleanSignup(input);
  const r = await one(`insert into waitlist (id, email, communities, code, visitor, referrer) values ($1, $2, $3, $4, $5, $6)
    on conflict (email) do update set
      communities = case when cardinality(excluded.communities) > 0 then excluded.communities else waitlist.communities end,
      code = coalesce(excluded.code, waitlist.code),
      visitor = coalesce(waitlist.visitor, excluded.visitor),
      joins = waitlist.joins + 1, updated = now()
    returning email, communities, code, joins, created, (xmax = 0) as is_new`, [id(), s.email, s.communities, s.code, s.visitor, s.referrer]);
  return { email: r.email, communities: r.communities, code: r.code, created: r.created, already: !r.is_new };
}

// Newest first, for the dashboard table and the CSV export.
export async function listWaitlist({ limit = 500, offset = 0 } = {}) {
  return q("select email, communities, code, visitor, referrer, joins, created, updated from waitlist order by created desc limit $1 offset $2", [Math.min(5000, Math.max(1, Number(limit) || 500)), Math.max(0, Number(offset) || 0)]);
}

// Totals for the dashboard tiles: everyone, the last N days, and how many came with an invite code.
export async function waitlistTotals({ days = 30 } = {}) {
  const r = await one(`select count(*) as total, count(*) filter (where created > now() - make_interval(days => $1)) as recent,
    count(*) filter (where code is not null) as with_code from waitlist`, [days]);
  return { total: Number(r.total), recent: Number(r.recent), with_code: Number(r.with_code) };
}

// How often each community was picked, for the dashboard: which doors to open first.
export async function waitlistCommunities() {
  return (await q("select c as community, count(*) as picks from waitlist, unnest(communities) as c group by 1 order by 2 desc, 1 limit 20")).map((r) => ({ community: r.community, picks: Number(r.picks) }));
}
