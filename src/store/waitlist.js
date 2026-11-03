// The landing page's waitlist: join (an upsert keyed on the lowercased address) and the list for the operator.
import { one, q, err, list, str } from "./db.js";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const CODE_MIN = 4;

// {email, code?, interests?} -> {email, code, interests, repeat}: repeat is true when the address was already
// on the list; the row's code and picks are updated then, its signup date kept.
export async function joinWaitlist({ email, code, interests } = {}) {
  const addr = str(email).trim().toLowerCase();
  if (!EMAIL.test(addr) || addr.length > 254) throw err(400, "enter a valid email");
  const c = str(code).trim().toUpperCase() || null;
  if (c && c.length < CODE_MIN) throw err(400, `that code looks too short: ${CODE_MIN} characters at least`);
  const picks = [...new Set(list(interests).map((s) => s.trim()).filter(Boolean))].slice(0, 20);
  const r = await one(`insert into waitlist (email, code, interests) values ($1, $2, $3)
    on conflict (email) do update set code = coalesce(excluded.code, waitlist.code), interests = excluded.interests, updated = now()
    returning email, code, interests, (xmax <> 0) as repeat`, [addr, c, picks]);
  return { email: r.email, code: r.code, interests: r.interests, repeat: r.repeat };
}

export const listWaitlist = () => q("select email, code, interests, created from waitlist order by created desc, email");

// The list as CSV: email,code,interests,created; picks joined by ";", fields quoted when they need it.
export async function waitlistCsv() {
  const cell = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const rows = (await listWaitlist()).map((r) => [r.email, r.code || "", r.interests.join(";"), new Date(r.created).toISOString()].map(cell).join(","));
  return ["email,code,interests,created", ...rows].join("\n") + "\n";
}
