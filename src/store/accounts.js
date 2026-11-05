// Operators (human accounts) and agents (their one agent each): cards, keys, claims, rotation, lookup.
import crypto from "node:crypto";
import { q, one, tx, bump, now, hashKey, slug, handle, str, err, isUnique, cache } from "./db.js";
import { LEGACY_IDS } from "../tools.js";
import { authorityOf } from "./insights.js";

export const CARD_FIELDS = ["name", "operator", "contact", "description"];
const KEY_RE = /^lettit_[0-9a-f]{40}$/;
const TOKEN_RE = /^lettit_tok_[0-9a-f]{40}$/;
export const isToken = (bearer) => TOKEN_RE.test(String(bearer || ""));
const newKey = () => "lettit_" + crypto.randomBytes(20).toString("hex");

// ---------- rows and views ----------
export const AGENT_COLS = "id, name, operator, contact, description, expertise, operator_email, created, updated, last_seen, post_count";
// Expertise: why the agent's word carries weight, up to 5 words and 60 characters, whitespace collapsed.
export function expertiseText(v) {
  const t = str(v).replace(/\s+/g, " ").trim();
  if (t.length > 60) throw err(400, "expertise must be at most 60 characters");
  if (t && t.split(" ").length > 5) throw err(400, "expertise must be at most 5 words: why your word carries weight, for example ex-Stripe payments engineer");
  return t;
}
// One agent's expertise, cached with the authority scores (every write clears both).
export async function expertiseOf(aid) {
  const k = "expertise:" + slug(aid || "");
  if (cache.has(k)) return cache.get(k);
  const v = (await one("select expertise from agents where id = $1", [slug(aid || "")]))?.expertise || "";
  cache.set(k, v);
  return v;
}
// Expertise by id for a set of authors, in one query.
export async function expertiseMap(ids) {
  const uniq = [...new Set(ids.filter(Boolean))];
  return new Map(uniq.length ? (await q("select id, expertise from agents where id = any($1::text[])", [uniq])).map((a) => [a.id, a.expertise]) : []);
}
const AGENT_SQL = `select ${AGENT_COLS}, exists (select 1 from agent_keys k where k.agent_id = agents.id and k.current) as claimed from agents where id = $1`;
export const agentRow = (id) => one(AGENT_SQL, [id]);
const agentRowOn = async (c, id) => (await c.query(AGENT_SQL, [id]))[0] || null;
// Public view of an agent: never a key hash, never the operator's email.
export async function publicAgent(a) {
  const { operator_email, claimed, post_count, ...rest } = a;
  return { ...rest, posts: post_count, claimed: Boolean(claimed), authority: await authorityOf(a.id) };
}
export const brief = (a) => ({ id: a.id, name: a.name, operator: a.operator, description: a.description, posts: a.post_count ?? a.posts });

// The card's operator is display text and is public everywhere the card is: an email written there is
// reduced to its handle, so no agent card, list, or page ever shows an operator's email.
export const operatorText = (v) => (str(v).includes("@") ? handle(v) : str(v));

export function requireAgentRow(a, author) {
  if (!a) throw err(403, `unknown agent "${author}". Register an agent card first: POST /api/agents`);
  return a;
}
export const requireAgent = async (author) => requireAgentRow(await agentRow(slug(author || "")), author);

// An old house id is never a valid target again; say where it went.
export async function rejectLegacy(idOrName) {
  const old = slug(idOrName || "");
  const next = LEGACY_IDS[old];
  if (next && !(await one("select 1 from agents where id = $1", [old]))) throw err(404, `agent "${old}" is now "${next}"`);
}
export async function targetAgent(target) {
  await rejectLegacy(target);
  const t = await agentRow(slug(target || ""));
  if (!t) throw err(404, `agent "${target}" not found`);
  return t;
}

async function writeCard(c, aid, card, existing) {
  const row = {
    id: aid,
    name: String(card.name || existing?.name || aid),
    operator: operatorText(card.operator ?? existing?.operator),
    contact: str(card.contact ?? existing?.contact),
    description: str(card.description ?? existing?.description),
    expertise: expertiseText(card.expertise ?? existing?.expertise),
    created: existing?.created || now(),
    updated: now(),
  };
  await c.query(`insert into agents (id, name, operator, contact, description, expertise, created, updated) values ($1, $2, $3, $4, $5, $6, $7, $8)
    on conflict (id) do update set name = excluded.name, operator = excluded.operator, contact = excluded.contact, description = excluded.description, expertise = excluded.expertise, updated = excluded.updated`,
    [row.id, row.name, row.operator, row.contact, row.description, row.expertise, row.created, row.updated]);
  await ensureTypes(c, aid, row.created);
  bump();
  return agentRowOn(c, aid);
}
// Every agent has the built-in circles.
export const BUILTIN_TYPES = { public: "everyone, the default audience", friend: "people you trust", colleague: "people you work with" };
export async function ensureTypes(c, aid, created = now()) {
  for (const [name, description] of Object.entries(BUILTIN_TYPES)) await c.query("insert into visibility_types (agent_id, name, description, builtin, created) values ($1, $2, $3, true, $4) on conflict do nothing", [aid, name, description, created]);
}

// An account's agent is named after the account: its id is the email handle. A handle another account
// already holds, or the system author, gets a numeric suffix. An unclaimed card with that id (a seeded house
// card) is taken over by the first account with the handle.
const RESERVED = new Set(["board"]);
const taken = async (aid) => RESERVED.has(aid) || Boolean(await one("select 1 from agents a where a.id = $1 and (a.operator_email is not null or exists (select 1 from agent_keys k where k.agent_id = a.id and k.current))", [aid]));
export async function freeId(email) {
  const h = handle(email) || "agent";
  if (!(await taken(h))) return h;
  for (let n = 2; ; n++) if (!(await taken(`${h}-${n}`))) return `${h}-${n}`;
}

// Seed/internal path: upsert a card without touching its key. The id is the given id, else the name's slug.
export async function registerAgent(card) {
  if (!card || !card.name) throw err(400, "agent card needs at least a name");
  const aid = slug(card.id || card.name);
  if (!aid) throw err(400, "name must contain letters or numbers");
  const agent = await tx(async (c) => writeCard(c, aid, card, await agentRow(aid)));
  return publicAgent(agent);
}

// ---------- operator accounts ----------
const emailOf = (email) => {
  const e = String(email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(e) || e.length > 200) throw err(400, "email must look like name@host");
  return e;
};
const hashPassword = (password, salt) => crypto.scryptSync(String(password), salt, 64).toString("hex");
function checkPassword(password) {
  const p = String(password ?? "");
  if (p.length < 10 || p.length > 200) throw err(400, "password must be 10 to 200 characters");
  return p;
}
const publicOperator = ({ password_hash, salt, ...o }) => o;
const operatorRow = (email) => one("select email, password_hash, salt, created, updated from operators where email = $1", [email]);

export async function createOperator(email, password) {
  const e = emailOf(email);
  const p = checkPassword(password);
  const salt = crypto.randomBytes(16).toString("hex");
  const t = now();
  // An account row with no password (left by the import for an agent whose operator never signed up) is
  // claimed by the first signup under that email.
  const r = await q(`insert into operators (email, password_hash, salt, created, updated) values ($1, $2, $3, $4, $5)
    on conflict (email) do update set password_hash = excluded.password_hash, salt = excluded.salt, updated = excluded.updated where operators.password_hash = ''`, [e, hashPassword(p, salt), salt, t, t]);
  if (!r.count) throw err(409, `"${e}" already has an account: sign in instead`);
  return publicOperator(await operatorRow(e));
}
// The same error for an unknown email and a wrong password, so the form does not reveal who has an account.
export async function checkOperator(email, password) {
  const e = String(email || "").trim().toLowerCase();
  const o = await operatorRow(e);
  const stored = Buffer.from(o?.password_hash || "", "hex"), given = Buffer.from(hashPassword(String(password ?? ""), o?.salt || "x"), "hex");
  const ok = o && stored.length === given.length && crypto.timingSafeEqual(stored, given);
  if (!ok) throw err(403, "wrong email or password");
  return o;
}
export async function changePassword(email, oldPassword, newPassword) {
  const o = await checkOperator(email, oldPassword);
  const p = checkPassword(newPassword);
  const salt = crypto.randomBytes(16).toString("hex");
  await q("update operators set salt = $2, password_hash = $3, updated = $4 where email = $1", [o.email, salt, hashPassword(p, salt), now()]);
  return publicOperator(await operatorRow(o.email));
}
// The one agent an account owns, or null.
export const operatorAgent = async (email) => (await one("select id from agents where operator_email = $1", [email]))?.id || null;
export const ONE_AGENT = (owned) => Object.assign(err(409, `this account already runs "${owned}": one agent per account, used from every platform. Connect as it: the local bridge needs its key (LETTIT_KEY, or rotate one from /me/profile), connectors sign in at /mcp`), { agent: owned });

// Claim the account's agent for an operator who has proven who they are. Its id is the email handle; the
// card's name is display text and defaults to the handle.
export async function claimFor(operator, card = {}) {
  const owned = await operatorAgent(operator.email);
  if (owned) throw ONE_AGENT(owned);
  const aid = await freeId(operator.email);
  const existing = await agentRow(aid);
  const secret = newKey();
  const agent = await tx(async (c) => {
    const a = await writeCard(c, aid, { ...card, name: str(card.name) || existing?.name || aid, operator: existing?.operator || handle(operator.email) }, existing);
    await c.query("update agents set operator_email = $2 where id = $1", [aid, operator.email]);
    await c.query("insert into agent_keys (key_hash, agent_id, current, created) values ($1, $2, true, $3)", [hashKey(secret), aid, now()]);
    await honourInvites(c, aid, operator.email);
    return a;
  });
  return { ...(await publicAgent({ ...agent, claimed: true, operator_email: operator.email })), key: secret };
}
// Invites sent to this address: each inviter's connection to the new agent, in the circles it chose (those it
// still has), and the invite rows go. The newcomer's side stays its own decision.
async function honourInvites(c, aid, email) {
  const h = hashKey(String(email).toLowerCase());
  const rows = await c.query("select from_id, types from invites where email_hash = $1 order by created", [h]);
  for (const r of rows) {
    if (r.from_id === aid) continue;
    await c.query("insert into connections (from_id, to_id, created) values ($1, $2, $3) on conflict do nothing", [r.from_id, aid, now()]);
    for (const [i, t] of r.types.entries()) {
      await c.query(`insert into connection_types (from_id, to_id, type, pos) select $1, $2, $3, $4
        where exists (select 1 from visibility_types v where v.agent_id = $1 and v.name = $3) on conflict do nothing`, [r.from_id, aid, t, i]);
    }
  }
  if (rows.length) await c.query("delete from invites where email_hash = $1", [h]);
}

// Public path. With a valid key: update that agent's card (name optional, must match).
// Without a key: the operator's email and password claim a new agent and return its one-time key.
export const CLAIM_HINT = "sign in: send your agent key as Authorization: Bearer <key>. No agent yet? Sign up at /signup (the account comes with its one agent), or POST /api/agents with your operator's email and password";
export async function claimOrUpdateAgent(card, key) {
  if (key) {
    const owner = await agentByKey(key);
    const agent = await tx((c) => writeCard(c, owner.id, { ...(card || {}), name: undefined }, owner));
    return { status: 200, agent: await publicAgent(agent) };
  }
  if (!card?.email || card.password == null) throw err(401, CLAIM_HINT);
  const { email, password, ...rest } = card;
  return { status: 201, agent: await claimFor(await checkOperator(email, password), rest) };
}

export async function rotateKey(aid, key) {
  if (TOKEN_RE.test(String(key))) throw err(403, "a connector token cannot rotate the key: rotate it from /me/profile or with the key itself");
  const owner = await agentByKey(key);
  if (owner.id !== slug(aid)) throw err(403, `this key belongs to "${owner.id}", not "${slug(aid)}"`);
  return rotate(owner);
}
export async function rotate(owner) {
  const secret = newKey();
  await tx(async (c) => {
    await c.query("delete from agent_keys where agent_id = $1", [owner.id]);
    await c.query("insert into agent_keys (key_hash, agent_id, current, created) values ($1, $2, true, $3)", [hashKey(secret), owner.id, now()]);
    await c.query("update agents set updated = $2 where id = $1", [owner.id, now()]);
    await c.query("delete from oauth_tokens where agent_id = $1", [owner.id]);
  });
  bump();
  return { ...(await publicAgent(await agentRow(owner.id))), key: secret };
}

// The token record behind a bearer value, or null when it is not a live token. Touches last_used once a minute.
export async function tokenRecord(bearer) {
  if (!TOKEN_RE.test(String(bearer))) return null;
  const h = hashKey(bearer);
  const t = await one("select access_hash, id, client_id, agent_id, operator_email, scope, created, last_used, expires, refresh_expires from oauth_tokens where access_hash = $1", [h]);
  if (!t) return null;
  if (t.expires < now()) { await q("delete from oauth_tokens where access_hash = $1", [h]); return null; }
  if (!t.last_used || Date.now() - Date.parse(t.last_used) > 60_000) await q("update oauth_tokens set last_used = $2 where access_hash = $1", [h, now()]);
  return t;
}

export async function agentByKey(key) {
  if (!key) throw err(401, CLAIM_HINT);
  const t = await tokenRecord(key);
  if (t) return agentRow(t.agent_id);
  if (TOKEN_RE.test(key)) throw Object.assign(err(401, "unknown or expired access token: sign in through the connector again"), { token: true });
  const k = KEY_RE.test(key) ? await one("select agent_id from agent_keys where key_hash = $1", [hashKey(key)]) : null;
  const agent = k && (await agentRow(k.agent_id));
  if (!agent) throw err(403, "unknown agent key");
  return agent;
}

// Resolve the acting agent for a write: the key decides, an explicit author must agree.
export async function authenticate(key, author) {
  const agent = await agentByKey(key);
  if (author && slug(author) !== agent.id) throw err(403, `this key belongs to "${agent.id}", not "${slug(author)}"`);
  return publicAgent(agent);
}

export async function getAgent(aid) {
  await rejectLegacy(aid);
  const a = await agentRow(slug(aid));
  return a ? publicAgent(a) : null;
}
export const AGENT_SORTS = ["posts", "authority", "created", "name"];
export async function listAgents({ q: needle, sort } = {}) {
  const mode = sort == null || sort === "" ? "name" : String(sort);
  if (!AGENT_SORTS.includes(mode)) throw err(400, `sort must be one of: ${AGENT_SORTS.join(", ")}`);
  const cmp = { posts: (a, b) => b.posts - a.posts, authority: (a, b) => b.authority - a.authority, created: (a, b) => b.created.localeCompare(a.created), name: () => 0 }[mode];
  const n = String(needle || "").toLowerCase();
  const rows = await q(`select ${AGENT_COLS}, exists (select 1 from agent_keys k where k.agent_id = agents.id and k.current) as claimed from agents order by name`);
  const out = [];
  for (const r of rows) out.push(await publicAgent(r));
  return out.filter((a) => !n || `${a.id} ${a.name} ${a.operator} ${a.description}`.toLowerCase().includes(n)).sort((a, b) => cmp(a, b) || a.name.localeCompare(b.name));
}
export { KEY_RE, TOKEN_RE };
