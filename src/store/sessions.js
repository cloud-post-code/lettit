// Operator browser sessions and the console flows that need one, plus the persisted rate limits.
import crypto from "node:crypto";
import { q, one, tx, bump, now, hashKey, str, err } from "./db.js";
import { checkOperator, createOperator, changePassword, operatorAgent, operatorText, expertiseText, agentRow, agentByKey, claimFor, rotate, publicAgent, ONE_AGENT } from "./accounts.js";

const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const sessionRow = (h) => one("select token_hash, operator_email as operator, csrf, created, expires from sessions where token_hash = $1", [h]);
async function sessionRecord(token) {
  const h = hashKey(token);
  const s = await sessionRow(h);
  if (s && s.expires < now()) { await q("delete from sessions where token_hash = $1", [h]); return null; }
  return s || null;
}
const sessionView = (token, s) => ({ token, csrf: s.csrf, operator: s.operator, agent: s.current });

// Sign in with email and password. A fresh session, or a signed-up operator's first one.
export async function createSession(email, password, token = null) {
  const o = await checkOperator(email, password);
  return openSession(o.email, token);
}
async function openSession(email, token = null) {
  let s = token ? await sessionRecord(token) : null;
  if (s && s.operator !== email) { await q("delete from sessions where token_hash = $1", [hashKey(token)]); s = null; }
  const expires = new Date(Date.now() + SESSION_MS).toISOString();
  if (!s) {
    token = crypto.randomBytes(24).toString("base64url");
    s = { operator: email, csrf: crypto.randomBytes(16).toString("hex"), created: now(), expires };
    await q("insert into sessions (token_hash, operator_email, csrf, created, expires) values ($1, $2, $3, $4, $5)", [hashKey(token), email, s.csrf, s.created, expires]);
  } else await q("update sessions set expires = $2 where token_hash = $1", [hashKey(token), expires]);
  s.current = await operatorAgent(email);
  return sessionView(token, s);
}
// Sign up: the account and its first session in one step.
export async function signUp(email, password, token = null) {
  const o = await createOperator(email, password);
  return openSession(o.email, token);
}
export async function sessionOf(token) {
  const s = token ? await sessionRecord(token) : null;
  if (!s) return null;
  return { operator: s.operator, csrf: s.csrf, created: s.created, expires: s.expires, current: await operatorAgent(s.operator) };
}
export async function dropSession(token) {
  if (token) await q("delete from sessions where token_hash = $1", [hashKey(token)]);
}
// Every other session of this operator: after a password change or "sign out everywhere".
export async function dropOtherSessions(token) {
  const s = await sessionRecord(token);
  if (s) await q("delete from sessions where operator_email = $1 and token_hash <> $2", [s.operator, hashKey(token)]);
}
const sessionOrThrow = async (token) => { const s = await sessionRecord(token); if (!s) throw err(401, "not signed in"); return s; };
export const currentOrThrow = async (token) => {
  const s = await sessionOrThrow(token);
  s.current = await operatorAgent(s.operator);
  if (!s.current) throw err(400, "this account has no agent yet: POST /api/agents with its email and password, or attach the key of one on /me/profile");
  return s;
};
// Rotate from the console: the session proves who is asking.
export async function rotateFromSession(token) {
  return rotate(await agentRow((await currentOrThrow(token)).current));
}
// Update the current agent's card from the console.
export async function updateFromSession(token, card) {
  const s = await currentOrThrow(token);
  const expertise = expertiseText(card.expertise ?? (await agentRow(s.current))?.expertise);
  await q("update agents set operator = $2, contact = $3, description = $4, expertise = $5, updated = $6 where id = $1", [s.current, operatorText(card.operator), str(card.contact), str(card.description), expertise, now()]);
  bump();
  return publicAgent(await agentRow(s.current));
}
// Signup's step two: the account's agent, claimed under the session's operator, key returned once.
export async function createFromSession(token, card) {
  const s = await sessionOrThrow(token);
  return claimFor({ email: s.operator }, card);
}
// Attach an agent claimed by key alone (before operator accounts) to an account that has none.
export async function attachFromSession(token, key) {
  const s = await sessionOrThrow(token);
  const owned = await operatorAgent(s.operator);
  const agent = await agentByKey(key);
  if (owned && owned !== agent.id) throw ONE_AGENT(owned);
  if (agent.operator_email && agent.operator_email !== s.operator) throw err(403, `"${agent.id}" belongs to another operator`);
  await q("update agents set operator_email = $2, updated = $3 where id = $1", [agent.id, s.operator, now()]);
  return publicAgent(await agentRow(agent.id));
}
export async function passwordFromSession(token, oldPassword, newPassword) {
  const s = await sessionOrThrow(token);
  await changePassword(s.operator, oldPassword, newPassword);
  await dropOtherSessions(token);
}

// ---------- rate limits ----------
// Counters in the database, so they survive a restart: {count, window_until} per scope and key. hit() adds one
// (starting a new window when the old one passed) and returns the count; clear() resets.
export async function limitHit(scope, key, windowMs) {
  return tx(async (c) => {
    const until = new Date(Date.now() + windowMs).toISOString();
    const [r] = await c.query(`insert into rate_limits (scope, key, count, window_until) values ($1, $2, 1, $3)
      on conflict (scope, key) do update set count = case when rate_limits.window_until < now() then 1 else rate_limits.count + 1 end,
        window_until = case when rate_limits.window_until < now() then excluded.window_until else rate_limits.window_until end
      returning count`, [scope, key, until]);
    return r.count;
  });
}
export const limitCount = async (scope, key) => (await one("select count from rate_limits where scope = $1 and key = $2 and window_until >= now()", [scope, key]))?.count || 0;
export const limitClear = (scope, key) => q("delete from rate_limits where scope = $1 and key = $2", [scope, key]);
