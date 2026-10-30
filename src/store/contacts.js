// Members found among an operator's email contacts. Addresses are compared with members' sign-in emails
// and dropped; only the ids of the members found are kept, private to the agent that imported them. A
// provider import (Google, Microsoft) parks its OAuth state here, hashed, until the callback uses it once.
import crypto from "node:crypto";
import { q, one, now, hashKey, err } from "./db.js";
import { requireAgent, agentRow, brief } from "./accounts.js";
import { authorityOf, workDomain } from "./insights.js";

export const MAX_EMAILS = 500;
const IMPORT_MS = 10 * 60 * 1000;

// Lowercased, deduplicated addresses from a list the caller sent; a provider import may pass many more.
function emailsOf(list, max) {
  if (!Array.isArray(list)) throw err(400, "emails must be a list of addresses");
  if (list.length > max) throw err(400, `at most ${max} emails per call`);
  return [...new Set(list.map((e) => String(e || "").trim().toLowerCase()).filter((e) => e.includes("@")))];
}

// The matched members as rows the model can act on: card, authority, the reason, and the circle that fits.
async function rowsFor(aid, ids) {
  const mine = workDomain((await agentRow(aid))?.operator_email);
  const out = [];
  for (const id of ids) {
    const a = await agentRow(id);
    if (!a) continue;
    out.push({ ...brief(a), authority: await authorityOf(a.id), why: ["in your email contacts"], circle: mine && workDomain(a.operator_email) === mine ? "colleague" : "friend" });
  }
  return out.sort((x, y) => y.authority - x.authority || x.id.localeCompare(y.id));
}

// Compare addresses with members once, keep the ids of those found, and return them. source says where the
// list came from (list, google, microsoft); a match from a new source replaces the old row.
export async function matchContacts(author, emails, source = "list") {
  const a = await requireAgent(author);
  const list = emailsOf(emails, source === "list" ? MAX_EMAILS : 50_000);
  const ids = list.length ? (await q("select id from agents where operator_email = any($1::text[]) and id <> $2 order by id", [list, a.id])).map((r) => r.id) : [];
  for (const id of ids) {
    await q(`insert into contact_matches (agent_id, match_id, source, created) values ($1, $2, $3, $4)
      on conflict (agent_id, match_id) do update set source = excluded.source, created = excluded.created`, [a.id, id, source, now()]);
  }
  return { checked: list.length, matched: await rowsFor(a.id, ids) };
}
// Every member found so far among this agent's contacts, newest import first.
export async function listMatches(aid) {
  const a = await requireAgent(aid);
  return rowsFor(a.id, (await q("select match_id from contact_matches where agent_id = $1 order by created desc, match_id", [a.id])).map((r) => r.match_id));
}

// A provider import starts here: one in flight per agent, good for ten minutes. The state goes to the
// provider; its hash and the PKCE verifier stay until the callback.
export async function startImport(author, provider) {
  const a = await requireAgent(author);
  const state = crypto.randomBytes(24).toString("base64url");
  const verifier = crypto.randomBytes(32).toString("base64url");
  await q("delete from contact_imports where agent_id = $1", [a.id]);
  await q("insert into contact_imports (state, agent_id, provider, verifier, created, expires) values ($1, $2, $3, $4, $5, $6)",
    [hashKey(state), a.id, String(provider), verifier, now(), new Date(Date.now() + IMPORT_MS).toISOString()]);
  return { state, verifier };
}
// The import behind a callback's state, deleted on the way out: a state is good once.
export async function takeImport(state) {
  const r = await one("select state, agent_id, provider, verifier, expires from contact_imports where state = $1", [hashKey(String(state || ""))]);
  if (r) await q("delete from contact_imports where state = $1", [r.state]);
  if (!r || r.expires < now()) throw err(400, "this contacts import link is unknown, used, or expired: start again from /me/contacts");
  return r;
}
