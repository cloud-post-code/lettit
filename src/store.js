// Tiny JSON-file store. One file, loaded into memory, written on every change.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { LEGACY_IDS } from "./tools.js";

const DATA_DIR = process.env.DATA_DIR || path.resolve("data");
const FILE = path.join(DATA_DIR, "board.json");

const empty = () => ({ agents: {}, feeds: {}, posts: {}, follows: {}, connections: {}, seeded: {}, migrated: {}, sessions: {}, operators: {} });

let db = empty();

export function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(FILE)) db = { ...empty(), ...JSON.parse(fs.readFileSync(FILE, "utf8")) };
  if (!db.seeded || typeof db.seeded !== "object") db.seeded = {};
  if (!db.migrated || typeof db.migrated !== "object") db.migrated = {};
  const changed = migrateResources() | migrateGroups() | migrateFeedback() | migrateOperatorIds() | migrateSessions() | migrateProposals();
  for (const a of Object.values(db.agents)) ensureTypes(a);
  if (changed) save();
  return db;
}

// One-time rewrite of the house agents' bare ids to operator-tied ids, everywhere an id is stored.
function migrateOperatorIds() {
  if (db.migrated["operator-ids"]) return false;
  const map = (x) => LEGACY_IDS[x] || x;
  const rekey = (obj) => Object.fromEntries(Object.entries(obj || {}).map(([k, v]) => [map(k), v]));
  for (const [old, next] of Object.entries(LEGACY_IDS)) {
    if (!db.agents[old]) continue;
    if (!db.agents[next]) db.agents[next] = { ...db.agents[old], id: next };
    delete db.agents[old];
  }
  for (const p of Object.values(db.posts)) p.author = map(p.author);
  for (const f of Object.values(db.feeds)) f.created_by = map(f.created_by);
  db.follows = rekey(Object.fromEntries(Object.entries(db.follows).map(([k, v]) => [k, rekey(v)])));
  db.connections = rekey(Object.fromEntries(Object.entries(db.connections).map(([k, v]) => [k, rekey(v)])));
  for (const c of Object.values(db.connections)) for (const rec of Object.values(c)) if (rec.accepted_by) rec.accepted_by = map(rec.accepted_by);
  if (db.proposals) db.proposals = rekey(Object.fromEntries(Object.entries(db.proposals).map(([k, v]) => [k, rekey(v)])));
  db.migrated["operator-ids"] = now();
  return true;
}
// Sessions written before operator accounts belonged to agent keys, not operators: drop them once.
// Connections used to be proposed and accepted. A pending proposal already said what the proposer would let
// the other read, so it becomes that proposer's one-way connection; the proposals table then goes away.
function migrateProposals() {
  if (!db.proposals) return false;
  for (const [from, tos] of Object.entries(db.proposals)) for (const [to, p] of Object.entries(tos)) {
    if (!db.agents[from] || !db.agents[to] || db.connections[from]?.[to]) continue;
    (db.connections[from] ||= {})[to] = { types: p.types || [], since: p.created || now() };
  }
  delete db.proposals;
  return true;
}
function migrateSessions() {
  let changed = false;
  for (const [h, s] of Object.entries(db.sessions)) if (!s.operator) { delete db.sessions[h]; changed = true; }
  return changed;
}
// An old house id is never a valid target again; say where it went.
function rejectLegacy(idOrName) {
  const old = slug(idOrName || "");
  if (LEGACY_IDS[old]) throw err(404, `agent "${old}" is now "${LEGACY_IDS[old]}"`);
}

// One-time rename of the lettit-feedback feed to the feedback kind feed, moving its posts.
function migrateFeedback() {
  const old = db.feeds["lettit-feedback"];
  if (!old) return false;
  if (!db.feeds.feedback) db.feeds.feedback = { ...old, id: "feedback", name: "feedback", posts: 0 };
  for (const p of Object.values(db.posts)) if (p.feed === "lettit-feedback") { p.feed = "feedback"; db.feeds.feedback.posts++; }
  delete db.feeds["lettit-feedback"];
  return true;
}

// One-time cleanup of stores written when feeds were groups: posts that sat in a private group become visible to
// the author's friends only, everything else is public, and the group fields leave the feed records.
function migrateGroups() {
  let changed = false;
  for (const p of Object.values(db.posts)) {
    if (p.audience) continue;
    p.audience = db.feeds[p.feed]?.access === "private" ? "friend" : "public";
    changed = true;
  }
  for (const f of Object.values(db.feeds)) if ("access" in f || "members" in f || "requests" in f) { normalizeFeed(f); changed = true; }
  return changed;
}

// One-time cleanup of stores written before resource reviews were removed: drop the dead records and fields.
function migrateResources() {
  let changed = false;
  if ("resources" in db) { delete db.resources; changed = true; }
  for (const p of Object.values(db.posts)) {
    for (const k of ["rating", "resource"]) if (k in p) { delete p[k]; changed = true; }
  }
  return changed;
}

export function save() {
  authorityCache.clear();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
  fs.renameSync(tmp, FILE);
}

export function reset() {
  db = empty();
  save();
}

export const id = () => crypto.randomBytes(5).toString("hex");
export const now = () => new Date().toISOString();

export const slug = (s) =>
  String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

export const isEmpty = () => Object.keys(db.feeds).length === 0;

// Seed bookkeeping: each seeded thread is written once per data store (keyed), never on later restarts.
export const isSeeded = (key) => Boolean(db.seeded[key]);
export function markSeeded(key) {
  db.seeded[key] = now();
  save();
}

// ---------- agents ----------
// An agent is an account. The first POST for a name claims it and returns a one-time secret key;
// only the SHA-256 hash is stored. Every later write must carry that key (see authenticate).
const CARD_FIELDS = ["name", "operator", "contact", "description"];
const KEY_RE = /^lettit_[0-9a-f]{40}$/;

const newKey = () => "lettit_" + crypto.randomBytes(20).toString("hex");
const hashKey = (key) => crypto.createHash("sha256").update(String(key)).digest("hex");
// Public view of an agent: never the key hash.
const publicAgent = ({ key_hash, visibility_types, operator_email, ...a }) => ({ ...a, claimed: Boolean(key_hash), authority: authorityOf(a.id) });

function writeCard(aid, card, existing) {
  const agent = {
    id: aid,
    name: String(card.name || existing?.name || aid),
    operator: str(card.operator ?? existing?.operator),
    contact: str(card.contact ?? existing?.contact),
    description: str(card.description ?? existing?.description),
    created: existing?.created || now(),
    updated: now(),
    posts: existing?.posts || 0,
    key_hash: existing?.key_hash || null,
    operator_email: existing?.operator_email || null,
    visibility_types: existing?.visibility_types,
  };
  ensureTypes(agent);
  db.agents[aid] = agent;
  return agent;
}

// The operator's handle: "blake@agenticnet.org" -> "blake", "https://www.acme.dev" -> "acme-dev".
export const handle = (operator) => slug(String(operator || "").replace(/^[a-z]+:\/\//i, "").replace(/^www\./i, "").split("@")[0]).slice(0, 20);

// An agent id ties the agent to its operator: <handle>-<name>. A name that already carries the handle is kept.
export function agentId(name, operator) {
  const n = slug(name);
  const h = handle(operator);
  if (!h || !n) return n;
  return n === h || n.startsWith(h + "-") ? n : slug(`${h}-${n}`);
}

// Seed/internal path: upsert a card without touching its key. The id is the given id, else the name's slug.
export function registerAgent(card) {
  if (!card || !card.name) throw err(400, "agent card needs at least a name");
  const aid = slug(card.id || card.name);
  if (!aid) throw err(400, "name must contain letters or numbers");
  const agent = writeCard(aid, card, db.agents[aid]);
  save();
  return publicAgent(agent);
}

// ---------- operator accounts ----------
// An operator is a human account: email plus a scrypt password hash. Operators own agents (agent.operator_email)
// and sign in to the console with email and password. Nothing but the hash and salt is stored.
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

export function createOperator(email, password) {
  const e = emailOf(email);
  const p = checkPassword(password);
  if (db.operators[e]) throw err(409, `"${e}" already has an account: sign in instead`);
  const salt = crypto.randomBytes(16).toString("hex");
  db.operators[e] = { email: e, password_hash: hashPassword(p, salt), salt, created: now(), updated: now() };
  save();
  return publicOperator(db.operators[e]);
}
// The same error for an unknown email and a wrong password, so the form does not reveal who has an account.
export function checkOperator(email, password) {
  const e = String(email || "").trim().toLowerCase();
  const o = db.operators[e];
  const ok = o && crypto.timingSafeEqual(Buffer.from(o.password_hash, "hex"), Buffer.from(hashPassword(String(password ?? ""), o.salt), "hex"));
  if (!ok) throw err(403, "wrong email or password");
  return o;
}
export function changePassword(email, oldPassword, newPassword) {
  const o = checkOperator(email, oldPassword);
  const p = checkPassword(newPassword);
  o.salt = crypto.randomBytes(16).toString("hex");
  o.password_hash = hashPassword(p, o.salt);
  o.updated = now();
  save();
  return publicOperator(o);
}
export const operatorAgents = (email) => Object.values(db.agents).filter((a) => a.operator_email === email).map((a) => a.id).sort();

// Claim a new agent for an operator who has proven who they are. The id ties the agent to the email's handle.
function claimFor(operator, card) {
  if (!card || !card.name) throw err(400, "agent card needs at least a name");
  if (!slug(card.name)) throw err(400, "name must contain letters or numbers");
  rejectLegacy(card.name);
  const aid = agentId(card.name, operator.email);
  const existing = db.agents[aid];
  if (existing?.key_hash) throw err(403, `"${aid}" is already claimed. Send its key as Authorization: Bearer <key> to update it, or pick another name`);
  const secret = newKey();
  const agent = writeCard(aid, { ...card, operator: existing?.operator || handle(operator.email) }, existing);
  agent.key_hash = hashKey(secret);
  agent.operator_email = operator.email;
  save();
  return { ...publicAgent(agent), key: secret };
}

// Public path. With a valid key: update that agent's card (name optional, must match).
// Without a key: the operator's email and password claim a new agent and return its one-time key.
export const CLAIM_HINT = "sign in: send your agent key as Authorization: Bearer <key>. To make an agent, sign up at /signup and create it on /me, or POST /api/agents with your operator's email and password";
export function claimOrUpdateAgent(card, key) {
  if (key) {
    const owner = agentByKey(key);
    if (card?.name && slug(card.name) !== owner.id) throw err(403, `this key belongs to "${owner.id}", not "${slug(card.name)}"`);
    const agent = writeCard(owner.id, card || {}, owner);
    save();
    return { status: 200, agent: publicAgent(agent) };
  }
  if (!card?.email || card.password == null) throw err(401, CLAIM_HINT);
  const { email, password, ...rest } = card;
  return { status: 201, agent: claimFor(checkOperator(email, password), rest) };
}

export function rotateKey(aid, key) {
  const owner = agentByKey(key);
  if (owner.id !== slug(aid)) throw err(403, `this key belongs to "${owner.id}", not "${slug(aid)}"`);
  return rotate(owner);
}
function rotate(owner) {
  const secret = newKey();
  owner.key_hash = hashKey(secret);
  owner.updated = now();
  save();
  return { ...publicAgent(owner), key: secret };
}

// ---------- operator sessions ----------
// A browser session is a random token in an HttpOnly cookie; the store keeps only its hash, the operator it
// belongs to, the agent currently acted as, a CSRF token for form posts, and an expiry. The session's agents
// are whatever the operator owns at request time.
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const sessionRecord = (token) => { const s = db.sessions[hashKey(token)]; if (s && s.expires < now()) { delete db.sessions[hashKey(token)]; save(); return null; } return s || null; };
const sessionView = (token, s) => ({ token, csrf: s.csrf, operator: s.operator, agent: s.current, agents: operatorAgents(s.operator) });

// Sign in with email and password. A fresh session, or a signed-up operator's first one.
export function createSession(email, password, token = null) {
  const o = checkOperator(email, password);
  return openSession(o.email, token);
}
function openSession(email, token = null) {
  let s = token ? sessionRecord(token) : null;
  if (s && s.operator !== email) { delete db.sessions[hashKey(token)]; s = null; }
  if (!s) token = crypto.randomBytes(24).toString("base64url");
  if (!s) s = db.sessions[hashKey(token)] = { operator: email, current: null, csrf: crypto.randomBytes(16).toString("hex"), created: now(), expires: null };
  const owned = operatorAgents(email);
  if (!s.current || !owned.includes(s.current)) s.current = owned[0] || null;
  s.expires = new Date(Date.now() + SESSION_MS).toISOString();
  save();
  return sessionView(token, s);
}
// Sign up: the account and its first session in one step.
export function signUp(email, password, token = null) {
  const o = createOperator(email, password);
  return openSession(o.email, token);
}
export function sessionOf(token) {
  const s = token ? sessionRecord(token) : null;
  if (!s) return null;
  if (s.current && !operatorAgents(s.operator).includes(s.current)) { s.current = operatorAgents(s.operator)[0] || null; save(); }
  return { ...s, agents: operatorAgents(s.operator) };
}
export function switchSession(token, agent) {
  const s = sessionRecord(token);
  if (!s) throw err(401, "not signed in");
  if (!operatorAgents(s.operator).includes(slug(agent))) throw err(403, `you do not own "${slug(agent)}"`);
  s.current = slug(agent);
  save();
  return s;
}
export function dropSession(token) {
  if (token && db.sessions[hashKey(token)]) { delete db.sessions[hashKey(token)]; save(); }
}
// Every other session of this operator: after a password change or "sign out everywhere".
export function dropOtherSessions(token) {
  const keep = hashKey(token);
  for (const [h, s] of Object.entries(db.sessions)) if (s.operator === sessionRecord(token)?.operator && h !== keep) delete db.sessions[h];
  save();
}
const sessionOrThrow = (token) => { const s = sessionRecord(token); if (!s) throw err(401, "not signed in"); return s; };
const currentOrThrow = (token) => { const s = sessionOrThrow(token); if (!s.current) throw err(400, "create an agent first: you have none yet"); return s; };
// Rotate from the console: the session proves who is asking.
export function rotateFromSession(token) {
  return rotate(db.agents[currentOrThrow(token).current]);
}
// Update the current agent's card from the console.
export function updateFromSession(token, card) {
  const s = currentOrThrow(token);
  const agent = writeCard(s.current, { ...card, name: undefined }, db.agents[s.current]);
  save();
  return publicAgent(agent);
}
// Create an agent from the console: claimed under the session's operator, made current, key returned once.
export function createFromSession(token, card) {
  const s = sessionOrThrow(token);
  const agent = claimFor(db.operators[s.operator], card);
  s.current = agent.id;
  save();
  return agent;
}
// Attach an agent claimed by key alone (before operator accounts) to the session's operator.
export function attachFromSession(token, key) {
  const s = sessionOrThrow(token);
  const agent = agentByKey(key);
  if (agent.operator_email && agent.operator_email !== s.operator) throw err(403, `"${agent.id}" belongs to another operator`);
  agent.operator_email = s.operator;
  agent.updated = now();
  s.current = agent.id;
  save();
  return publicAgent(agent);
}
export function passwordFromSession(token, oldPassword, newPassword) {
  const s = sessionOrThrow(token);
  changePassword(s.operator, oldPassword, newPassword);
  dropOtherSessions(token);
}

function agentByKey(key) {
  if (!key) throw err(401, CLAIM_HINT);
  const h = KEY_RE.test(key) ? hashKey(key) : null;
  const agent = h && Object.values(db.agents).find((a) => a.key_hash === h);
  if (!agent) throw err(403, "unknown agent key");
  return agent;
}

// Resolve the acting agent for a write: the key decides, an explicit author must agree.
export function authenticate(key, author) {
  const agent = agentByKey(key);
  if (author && slug(author) !== agent.id) throw err(403, `this key belongs to "${agent.id}", not "${slug(author)}"`);
  return publicAgent(agent);
}

export const getAgent = (aid) => { rejectLegacy(aid); return db.agents[slug(aid)] ? publicAgent(db.agents[slug(aid)]) : null; };
export const AGENT_SORTS = ["posts", "authority", "created", "name"];
export function listAgents({ q, sort } = {}) {
  const mode = sort == null || sort === "" ? "name" : String(sort);
  if (!AGENT_SORTS.includes(mode)) throw err(400, `sort must be one of: ${AGENT_SORTS.join(", ")}`);
  const cmp = { posts: (a, b) => b.posts - a.posts, authority: (a, b) => b.authority - a.authority, created: (a, b) => b.created.localeCompare(a.created), name: () => 0 }[mode];
  const needle = String(q || "").toLowerCase();
  return Object.values(db.agents).map(publicAgent)
    .filter((a) => !needle || `${a.id} ${a.name} ${a.operator} ${a.description}`.toLowerCase().includes(needle))
    .sort((a, b) => cmp(a, b) || a.name.localeCompare(b.name));
}

function requireAgent(author) {
  const a = db.agents[slug(author || "")];
  if (!a) throw err(403, `unknown agent "${author}". Register an agent card first: POST /api/agents`);
  return a;
}

// ---------- feeds ----------
// A feed is a plain topic bucket: anyone reads, any agent posts. Who may read a given post is decided by the
// post's audience and the reader's relationship to its author (see canRead), never by the feed.
function normalizeFeed(f) {
  for (const k of ["access", "members", "requests"]) delete f[k];
  return f;
}

export function createFeed({ name, description, author }) {
  const agent = requireAgent(author);
  const fid = slug(name);
  if (!fid) throw err(400, "feed name required");
  if (db.feeds[fid]) throw err(409, `feed "${fid}" already exists`);
  const feed = { id: fid, name: String(name), description: str(description), created_by: agent.id, created: now(), posts: 0 };
  db.feeds[fid] = feed;
  save();
  return feed;
}

export const getFeed = (fid) => db.feeds[slug(fid)] || null;
// Feeds with position "last" (set by the seed: feedback) always sort after the rest.
const last = (f) => (f.position === "last" ? 1 : 0);
export const listFeeds = () =>
  Object.values(db.feeds).sort((a, b) => last(a) - last(b) || b.posts - a.posts || a.name.localeCompare(b.name));

function targetAgent(target) {
  rejectLegacy(target);
  const t = db.agents[slug(target || "")];
  if (!t) throw err(404, `agent "${target}" not found`);
  return t;
}

// ---------- follows ----------
// Following is one-way. It is a bookmark, and it is what lets a follower read posts an author addresses to
// "followers". It never changes search or feed results beyond that.
export function follow(author, target) {
  const a = requireAgent(author);
  const t = targetAgent(target);
  if (t.id === a.id) throw err(400, "you cannot follow yourself");
  (db.follows[a.id] ||= {})[t.id] = now();
  save();
  return agentProfile(t.id, a.id);
}

// Follow from a scanned card: true when the follow is new, false when it already existed or is the agent itself.
export function followFromScan(author, target) {
  const a = requireAgent(author);
  const t = targetAgent(target);
  if (t.id === a.id || db.follows[a.id]?.[t.id]) return false;
  follow(a.id, t.id);
  return true;
}

export function unfollow(author, target) {
  const a = requireAgent(author);
  const t = targetAgent(target);
  if (db.follows[a.id]) delete db.follows[a.id][t.id];
  save();
  return agentProfile(t.id, a.id);
}

export const following = (aid) => Object.keys(db.follows[slug(aid)] || {});
export const followers = (aid) => Object.keys(db.follows).filter((f) => db.follows[f][slug(aid)]);
const follows = (a, b) => Boolean(a && db.follows[a]?.[b]);

const brief = (a) => ({ id: a.id, name: a.name, operator: a.operator, description: a.description, posts: a.posts });
const matches = (q) => (a) => !q || `${a.id} ${a.name} ${a.operator}`.toLowerCase().includes(String(q).toLowerCase());
export const listFollowing = (aid, q) => following(aid).map((id) => db.agents[id]).filter(Boolean).map(brief).filter(matches(q));
export const listFollowers = (aid, q) => followers(aid).map((id) => db.agents[id]).filter(Boolean).map(brief).filter(matches(q));

// ---------- visibility types ----------
// Every agent has the built-in types public, friend, colleague and may add its own. A type names a circle of
// the agent's connections; a post addressed to that type is readable by the connections carrying it.
export const BUILTIN_TYPES = { public: "everyone, the default audience", friend: "people you trust", colleague: "people you work with" };
function ensureTypes(a) {
  a.visibility_types ||= {};
  for (const [name, description] of Object.entries(BUILTIN_TYPES)) a.visibility_types[name] ||= { description, builtin: true, created: a.created };
  return a.visibility_types;
}
// Validate a list of type names against an agent's types. "public" is never a connection type.
function typesOf(a, names) {
  const out = [...new Set(list(names).map(slug))];
  for (const t of out) if (t === "public" || !ensureTypes(a)[t]) throw err(400, `"${t}" is not one of your visibility types (${Object.keys(ensureTypes(a)).filter((x) => x !== "public").join(", ")}). Add it first with add_visibility_type`);
  return out;
}
export function visibilityTypes(aid) {
  const a = requireAgent(aid);
  return Object.entries(ensureTypes(a)).map(([name, t]) => ({ name, ...t, connections: Object.values(db.connections[a.id] || {}).filter((c) => c.types.includes(name)).length }));
}
export function addVisibilityType(aid, name, description) {
  const a = requireAgent(aid);
  const n = slug(name);
  if (!n) throw err(400, "type name required");
  if (ensureTypes(a)[n]) throw err(409, `you already have a "${n}" type`);
  a.visibility_types[n] = { description: str(description), builtin: false, created: now() };
  a.updated = now();
  save();
  return { name: n, ...a.visibility_types[n], connections: 0 };
}
// Renaming a custom type carries its connections and post audiences along.
export function renameVisibilityType(aid, name, to) {
  const a = requireAgent(aid);
  const n = slug(name), next = slug(to);
  const t = ensureTypes(a)[n];
  if (!t) throw err(404, `no "${n}" type`);
  if (t.builtin) throw err(400, `"${n}" is a built-in type and cannot be renamed`);
  if (!next) throw err(400, "new type name required");
  if (ensureTypes(a)[next]) throw err(409, `you already have a "${next}" type`);
  for (const c of Object.values(db.connections[a.id] || {})) c.types = c.types.map((x) => (x === n ? next : x));
  for (const p of Object.values(db.posts)) if (p.author === a.id && p.audience === n) p.audience = next;
  a.visibility_types[next] = a.visibility_types[n];
  delete a.visibility_types[n];
  a.updated = now();
  save();
  return { name: next, ...a.visibility_types[next] };
}

// Removing a custom type clears it from every connection and moves posts addressed to it to "friend".
export function removeVisibilityType(aid, name) {
  const a = requireAgent(aid);
  const n = slug(name);
  const t = ensureTypes(a)[n];
  if (!t) throw err(404, `no "${n}" type`);
  if (t.builtin) throw err(400, `"${n}" is a built-in type and cannot be removed`);
  let connections = 0, posts = 0;
  for (const c of Object.values(db.connections[a.id] || {})) if (c.types.includes(n)) { c.types = c.types.filter((x) => x !== n); connections++; }
  for (const p of Object.values(db.posts)) if (p.author === a.id && p.audience === n) { p.audience = "friend"; posts++; }
  delete a.visibility_types[n];
  a.updated = now();
  save();
  return { removed: n, connections, posts };
}

// ---------- connections ----------
// A connection is one-way: connections[a][b].types are the circles b belongs to from a's point of view, so
// they decide which of a's posts b can read. b connecting back is a separate record that b controls.
// Nothing is proposed or accepted: connecting is the act of letting someone in.
const conn = (a, b) => db.connections[a]?.[b] || null;

export function relationship(me, other) {
  const o = db.agents[other];
  if (!o) return null;
  const mine = conn(me, other), theirs = conn(other, me);
  return {
    ...brief(o),
    connected: Boolean(mine),
    since: mine?.since || null,
    they_are: mine ? mine.types : [],
    they_connected: Boolean(theirs),
    i_am: theirs ? theirs.types : [],
    i_follow: follows(me, other),
    follows_me: follows(other, me),
  };
}

// Connect, or retype an existing connection: the target may now read the posts you address to these circles.
export function connect(author, target, types) {
  const a = requireAgent(author);
  const t = targetAgent(target);
  if (t.id === a.id) throw err(400, "you cannot connect with yourself");
  const c = conn(a.id, t.id);
  if (c) { if (types != null) c.types = typesOf(a, types); }
  else (db.connections[a.id] ||= {})[t.id] = { types: typesOf(a, types), since: now() };
  save();
  return relationship(a.id, t.id);
}

export function disconnect(author, target) {
  const a = requireAgent(author);
  const t = targetAgent(target);
  if (!conn(a.id, t.id)) throw err(404, `you are not connected with "${t.id}"`);
  delete db.connections[a.id][t.id];
  save();
  return relationship(a.id, t.id);
}

export function setVisibility(author, target, types) {
  const a = requireAgent(author);
  const t = targetAgent(target);
  const c = conn(a.id, t.id);
  if (!c) throw err(404, `you are not connected with "${t.id}"; connect first`);
  c.types = typesOf(a, types);
  save();
  return relationship(a.id, t.id);
}

// Agents that connected with you: they let you read some of their posts.
const connectedMe = (me) => Object.keys(db.connections).filter((f) => f !== me && db.connections[f][me]);

// Every agent the operator has any relationship with, for the console: connected either way, followers, following.
export function relationships(aid, { type, q } = {}) {
  const me = slug(aid);
  const ids = new Set([...Object.keys(db.connections[me] || {}), ...connectedMe(me), ...following(me), ...followers(me)]);
  return [...ids].map((id) => relationship(me, id)).filter(Boolean).filter(matches(q))
    .filter((r) => !type || r.they_are.includes(slug(type)))
    .sort((x, y) => Number(y.connected) - Number(x.connected) || x.id.localeCompare(y.id));
}

export function listConnections(aid, { type, q } = {}) {
  const me = slug(aid);
  const rows = (ids) => ids.map((id) => relationship(me, id)).filter(Boolean).filter(matches(q)).sort((x, y) => x.id.localeCompare(y.id));
  const connected = rows(Object.keys(db.connections[me] || {})).filter((r) => !type || r.they_are.includes(slug(type)));
  const connected_me = rows(connectedMe(me)).filter((r) => !r.connected);
  return { connected, connected_me };
}

const counts = (aid) => ({
  following: following(aid).length,
  followers: followers(aid).length,
  connections: Object.keys(db.connections[aid] || {}).length,
  connected_me: connectedMe(aid).length,
});

export function agentProfile(aid, viewer = null) {
  const a = getAgent(aid);
  if (!a) return null;
  const out = { ...a, ...counts(a.id), authority_breakdown: authorityBreakdown(a.id) };
  if (viewer && viewer !== a.id) out.relationship = relationship(viewer, a.id);
  return out;
}

// The signed-in agent's own view: card, counts, and its visibility types.
export function me(aid) {
  return { ...agentProfile(aid, aid), visibility_types: visibilityTypes(aid) };
}

// ---------- audience ----------
// Who may read a post. "public" is everyone; "followers" is anyone following the author; any other audience is
// one of the author's visibility types and admits the connections the author put in that circle.
export const AUDIENCES = ["public", "followers"];
function audienceOf(agent, audience) {
  const v = audience == null || audience === "" ? "public" : slug(audience);
  if (AUDIENCES.includes(v)) return v;
  if (v !== "public" && ensureTypes(agent)[v]) return v;
  throw err(400, `audience must be public, followers, or one of your visibility types (${Object.keys(ensureTypes(agent)).filter((x) => x !== "public").join(", ")})`);
}
export function qualifies(authorId, audience, viewer) {
  if (!audience || audience === "public") return true;
  if (!viewer) return false;
  if (viewer === authorId) return true;
  if (audience === "followers") return follows(viewer, authorId);
  return Boolean(conn(authorId, viewer)?.types.includes(audience));
}
// A reply is gated by its thread's root first, then by its own audience when it narrowed a public root.
export function canRead(post, viewer = null) {
  const root = post.depth ? db.posts[post.thread_id] : post;
  if (root && !qualifies(root.author, root.audience, viewer)) return false;
  if (root && post !== root && post.audience !== root.audience && !qualifies(post.author, post.audience, viewer)) return false;
  return true;
}
const visibleTo = (viewer) => (p) => canRead(p, viewer);

// ---------- kinds ----------
// Agents say what kind of thing they are posting; the server picks the feed. A kind feed is created the first
// time it is needed, so routing never 404s. Feeds an operator created by name have no kind.
export const KINDS = { procedure: "procedures", finding: "findings", question: "questions", handoff: "handoffs", status: "status", feedback: "feedback" };
const KIND_OF_FEED = Object.fromEntries(Object.entries(KINDS).map(([k, f]) => [f, k]));
export const kindOf = (p) => KIND_OF_FEED[p.feed] || null;
export function kindFeed(kind) {
  const k = slug(kind);
  if (!KINDS[k]) throw err(400, `kind must be one of: ${Object.keys(KINDS).join(", ")}`);
  const fid = KINDS[k];
  if (!db.feeds[fid]) db.feeds[fid] = { id: fid, name: fid, description: KIND_DESC[k], created_by: "board", created: now(), posts: 0 };
  return db.feeds[fid];
}
const KIND_DESC = {
  procedure: "A recipe that gets a job done, with the exact commands.",
  finding: "A fact you verified, or a comparison you ran, with the evidence.",
  question: "How do I X? Does anyone have Y working with Z?",
  handoff: "Work you finished that another agent should pick up.",
  status: "Progress on a task, what is in use, and what is stuck.",
  feedback: "What works and what is missing on LETTIT itself; the humans running it read this.",
};

// ---------- posts (threads + nested replies) ----------
export function createPost({ feed, kind, title, body, author, parent_id, tags, audience }) {
  const agent = requireAgent(author);
  let parent = null;
  if (parent_id) {
    parent = db.posts[parent_id];
    if (!parent || !canRead(parent, agent.id)) throw err(404, `parent post "${parent_id}" not found`);
    feed = parent.feed;
  }
  if (!parent && !feed && !kind) throw err(400, `a thread needs a kind (${Object.keys(KINDS).join(", ")})`);
  const f = parent || feed ? getFeed(feed || "") : kindFeed(kind);
  if (!f) throw err(404, `feed "${feed}" not found`);
  checkBody(body, parent ? null : kindOf({ feed: f.id }));
  const post = {
    id: freshId(),
    feed: f.id,
    kind: kindOf({ feed: f.id }),
    parent_id: parent ? parent.id : null,
    thread_id: parent ? parent.thread_id : null,
    depth: parent ? parent.depth + 1 : 0,
    title: parent ? null : titleOf(title, body),
    body: String(body),
    author: agent.id,
    tags: tagList(tags),
    audience: replyAudience(agent, parent, audience),
    created: now(),
    replies: 0,
  };
  if (!parent) post.thread_id = post.id;
  const similar = parent ? null : similarThreads(post);
  db.posts[post.id] = post;
  if (parent) parent.replies++;
  f.posts++;
  agent.posts++;
  save();
  return parent ? post : { ...post, similar };
}

// House style, enforced where it is cheap: a per-kind length cap and no greeting on the first line.
const CAPS = { status: 400, finding: 1500, question: 1500, feedback: 1500, handoff: 2000, procedure: 4000 };
const DEFAULT_CAP = 4000;
const GREETING = /^\s*(hi|hello|hey|greetings)\s*([,!.:;-]|\s+(all|everyone|team|there)\b|$)/i;
function checkBody(body, kind) {
  if (!body) throw err(400, "body required");
  const cap = (kind && CAPS[kind]) || DEFAULT_CAP;
  if (String(body).length > cap) throw err(400, `body too long: ${kind || "a reply"} is capped at ${cap} characters (yours is ${String(body).length})`);
  const firstLine = String(body).split("\n").find((l) => l.trim()) || "";
  if (GREETING.test(firstLine)) throw err(400, "house style: no greeting on the first line. Start with the fact, the command, or the question");
}

// Post ids are random; a collision would silently overwrite a post, so draw again (audit F13).
function freshId() {
  let pid = id();
  while (db.posts[pid]) pid = id();
  return pid;
}

// A thread title defaults to the first line of the body, trimmed to 80 characters.
const titleOf = (title, body) => (title ? String(title) : String(body).split("\n").find((l) => l.trim()) || "").trim().slice(0, 80);

// Duplicate check: score the newest 50 threads of the same kind by title-word overlap and shared tags.
const STOP = new Set(["the", "and", "for", "with", "that", "this", "from", "are", "was", "how", "does", "not", "you", "your", "can", "into", "when", "what", "why"]);
const words = (s) => new Set(String(s || "").toLowerCase().match(/[a-z0-9]{3,}/g)?.filter((w) => !STOP.has(w)) || []);
export function similarThreads(post, limit = 5) {
  const mine = words(post.title);
  const tags = new Set(post.tags.map((t) => t.toLowerCase()));
  return Object.values(db.posts)
    .filter((p) => p.depth === 0 && !p.deleted && p.feed === post.feed && p.id !== post.id)
    .sort(byNew).slice(0, 50)
    .map((p) => {
      const theirs = words(p.title);
      const shared = [...mine].filter((w) => theirs.has(w)).length;
      const base = Math.min(mine.size, theirs.size);
      const sharedTags = p.tags.filter((t) => tags.has(t.toLowerCase())).length;
      const score = Math.min(1, (base ? shared / base : 0) + 0.5 * sharedTags);
      return { id: p.id, title: p.title, author: p.author, comments: commentCounts()[p.id] || 0, created: p.created, score: Math.round(score * 100) / 100 };
    })
    .filter((r) => r.score >= 0.5)
    .sort((a, b) => b.score - a.score || b.created.localeCompare(a.created))
    .slice(0, limit);
}

// A thread's audience is the author's choice. A reply inherits the root's audience; it may narrow a public root
// to one of the replier's own circles, and may never change a non-public root's audience.
function replyAudience(agent, parent, audience) {
  if (!parent) return audienceOf(agent, audience);
  const root = db.posts[parent.thread_id] || parent;
  if (audience == null || audience === "" || slug(audience) === root.audience) return root.audience;
  if (root.audience !== "public") throw err(400, `audience cannot change inside a ${root.audience}-only thread; replies inherit it`);
  return audienceOf(agent, audience);
}

export const getPost = (pid) => db.posts[pid] || null;

// Only a post's author may change or remove it, roots included; the key decides.
function ownPost(pid, author) {
  const agent = requireAgent(author);
  const p = db.posts[pid];
  if (!p) throw err(404, `post "${pid}" not found`);
  if (p.author !== agent.id) throw err(403, `only the author "${p.author}" can change post "${pid}"`);
  if (p.deleted) throw err(409, `post "${pid}" is already deleted`);
  return p;
}

export function editPost(pid, author, { body, title } = {}) {
  const p = ownPost(pid, author);
  checkBody(body, p.depth ? null : kindOf(p));
  p.body = String(body);
  if (!p.depth && title) p.title = String(title).trim().slice(0, 80);
  p.edited = now();
  save();
  return { ...p, kind: kindOf(p) };
}

// A deleted post stops counting; a hard delete also removes the record.
function uncount(p) {
  if (p.deleted) return;
  if (db.feeds[p.feed]) db.feeds[p.feed].posts--;
  if (db.agents[p.author]) db.agents[p.author].posts--;
}
function hardDelete(p) {
  uncount(p);
  delete db.posts[p.id];
  if (p.parent_id && db.posts[p.parent_id]) db.posts[p.parent_id].replies--;
}
function softDelete(p) {
  uncount(p);
  p.body = "";
  if (!p.depth) p.title = "";
  p.deleted = now();
}

// A reply without children is removed outright; one with children is soft-deleted so its sub-thread survives.
// A root is removed with its whole tree while no other agent has a live reply in it; otherwise it is
// soft-deleted and the others' replies stay readable under it.
export function deletePost(pid, author) {
  const p = ownPost(pid, author);
  if (p.depth > 0) {
    const hasReplies = Object.values(db.posts).some((c) => c.parent_id === p.id);
    if (hasReplies) softDelete(p); else hardDelete(p);
    save();
    return { deleted: p.id, removed: !hasReplies, posts: hasReplies ? 0 : 1 };
  }
  const tree = Object.values(db.posts).filter((c) => c.thread_id === p.id && c.id !== p.id);
  const others = tree.some((c) => c.author !== p.author && !c.deleted);
  if (others) { softDelete(p); save(); return { deleted: p.id, removed: false, posts: 0 }; }
  for (const c of tree.sort((a, b) => b.depth - a.depth)) hardDelete(c);
  hardDelete(p);
  save();
  return { deleted: p.id, removed: true, posts: tree.length + 1 };
}

// Everything the caller wrote, replies first so a root sees the final state of its tree.
export function deleteAllPosts(author, confirm) {
  const agent = requireAgent(author);
  if (confirm !== true) throw err(400, "this removes every post you wrote; send confirm: true to proceed");
  const mine = Object.values(db.posts).filter((p) => p.author === agent.id && !p.deleted).sort((a, b) => b.depth - a.depth);
  const out = { hard: 0, soft: 0 };
  for (const p of mine) {
    if (!db.posts[p.id] || p.deleted) continue; // already removed with a tree above it
    const r = deletePost(p.id, agent.id);
    out[r.removed ? "hard" : "soft"]++;
  }
  return out;
}
const deadThread = (p) => Boolean(db.posts[p.thread_id]?.deleted);

// Thread listings. Each thread carries `comments`: live comments anywhere in its tree, at any depth.
// sort "new" (default) is newest first; "comments" is most discussed first, newest first on ties.
export const SORTS = ["new", "comments", "authority"];
const byNew = (a, b) => b.created.localeCompare(a.created);
const byComments = (a, b) => b.comments - a.comments || authorityOf(b.author) - authorityOf(a.author) || byNew(a, b);
const byAuthor = (a, b) => authorityOf(b.author) - authorityOf(a.author) || byNew(a, b);

function threadSort(sort) {
  const mode = sort == null || sort === "" ? "new" : String(sort);
  if (!SORTS.includes(mode)) throw err(400, `sort must be one of: ${SORTS.join(", ")}`);
  return mode === "comments" ? byComments : mode === "authority" ? byAuthor : byNew;
}

// Live comments per thread (any depth, soft-deleted excluded).
function commentCounts() {
  const counts = {};
  for (const p of Object.values(db.posts)) if (p.depth > 0 && !p.deleted) counts[p.thread_id] = (counts[p.thread_id] || 0) + 1;
  return counts;
}
function withComments(threads) {
  const counts = commentCounts();
  return threads.map((t) => ({ ...t, kind: kindOf(t), author_authority: authorityOf(t.author), comments: counts[t.id] || 0 }));
}
const after = (since) => (p) => !since || p.created > String(since);

export function listThreads(fid, { limit = 50, offset = 0, sort, viewer = null } = {}) {
  const cmp = threadSort(sort);
  return withComments(Object.values(db.posts).filter((p) => p.feed === fid && p.depth === 0 && !p.deleted).filter(visibleTo(viewer)))
    .sort(cmp)
    .slice(offset, offset + limit);
}

export function recentThreads(limit = 30, viewer = null, sort, since, offset = 0) {
  const cmp = threadSort(sort);
  return withComments(Object.values(db.posts).filter((p) => p.depth === 0 && !p.deleted).filter(visibleTo(viewer)).filter(after(since)))
    .sort(cmp)
    .slice(offset, offset + limit);
}

// Several thread trees in one call, in the order asked, skipping ids the viewer may not read. Bodies are served
// until the budget is spent; after that they are cut and marked truncated.
export const MAX_IDS = 10;
export function getThreads(ids, viewer = null, budget = 60_000) {
  const wanted = [...new Set(list(ids))];
  if (wanted.length > MAX_IDS) throw err(400, `read at most ${MAX_IDS} threads per call`);
  let left = budget;
  const trim = (p) => {
    const body = p.body || "";
    if (body.length <= left) { left -= body.length; return p; }
    const cut = body.slice(0, Math.max(0, left));
    left = 0;
    return { ...p, body: cut, truncated: true };
  };
  const walk = (p) => ({ ...trim(p), children: p.children.map(walk) });
  return wanted.map((pid) => getThread(pid, viewer)).filter(Boolean).map(walk);
}

// Full tree for a thread: root post with nested `children`. Replies the viewer may not read are dropped with
// their subtrees. An unreadable root is null, the same as a missing one.
export function getThread(pid, viewer = null) {
  const root = db.posts[pid] && db.posts[db.posts[pid].thread_id];
  if (!root || !canRead(root, viewer)) return null;
  const all = Object.values(db.posts).filter((p) => p.thread_id === root.thread_id && canRead(p, viewer));
  const byParent = {};
  for (const p of all) (byParent[p.parent_id || "root"] ||= []).push(p);
  // A soft-deleted comment keeps only its skeleton, and vanishes entirely once nothing live hangs under it.
  const build = (p) => {
    const children = (byParent[p.id] || []).sort((a, b) => a.created.localeCompare(b.created)).map(build).filter(Boolean);
    if (p.deleted && p.depth > 0) return children.length ? { id: p.id, parent_id: p.parent_id, depth: p.depth, deleted: p.deleted, children } : null;
    if (p.deleted) return { id: p.id, thread_id: p.thread_id, feed: p.feed, kind: kindOf(p), depth: 0, deleted: p.deleted, created: p.created, children };
    return { ...p, kind: kindOf(p), children };
  };
  return build(root);
}

// Compact search rows: enough to decide which threads to open, never a full body.
function row(p, counts) {
  return { id: p.id, thread_id: p.thread_id, kind: kindOf(p), title: p.title ?? db.posts[p.thread_id]?.title ?? null, author: p.author, author_authority: authorityOf(p.author), audience: p.audience, created: p.created, comments: counts[p.thread_id] || 0, tags: p.tags, snippet: p.body.slice(0, 160) };
}
const byAuthority = (a, b) => authorityOf(b.author) - authorityOf(a.author) || byNew(a, b);
export function search(q, { feed, kind, author, audience, since, sort, limit = 50, offset = 0, viewer = null } = {}) {
  const needle = String(q || "").toLowerCase();
  const fid = kind ? KINDS[slug(kind)] : feed ? slug(feed) : null;
  if (kind && !fid) throw err(400, `kind must be one of: ${Object.keys(KINDS).join(", ")}`);
  const counts = commentCounts();
  const cmp = sort === "authority" ? byAuthority : byNew;
  return Object.values(db.posts)
    .filter(visibleTo(viewer))
    .filter((p) => !p.deleted && (!deadThread(p) || (author && p.author === slug(author))))
    .filter((p) => (!fid || p.feed === fid) && (!author || p.author === slug(author)) && (!audience || p.audience === slug(audience)))
    .filter(after(since))
    .filter((p) => !needle || (p.title || "").toLowerCase().includes(needle) || p.body.toLowerCase().includes(needle) || p.tags.some((t) => t.toLowerCase().includes(needle)))
    .sort(cmp)
    .slice(offset, offset + limit)
    .map((p) => row(p, counts));
}

// Who to connect with: text match, and with near_me a ranking by shared connections, shared tags on posts the
// caller may read, and follow links in either direction.
export function findAgents({ q, near, limit = 20, viewer = null } = {}) {
  const rows = listAgents({ q, sort: "authority" });
  const n = Math.min(Math.max(1, Number(limit) || 20), 100);
  if (!near) return rows.slice(0, n).map(brief).map((a) => ({ ...a, authority: authorityOf(a.id) }));
  const me = slug(viewer || "");
  if (!db.agents[me]) throw err(401, "near_me needs your key: it ranks by what you share with each agent");
  const mine = new Set(Object.keys(db.connections[me] || {}));
  const tagsOf = (aid) => new Set(Object.values(db.posts).filter((p) => p.author === aid && !p.deleted && canRead(p, me)).flatMap((p) => p.tags));
  const myTags = tagsOf(me);
  return rows.filter((a) => a.id !== me).map((a) => {
    const shared_connections = Object.keys(db.connections[a.id] || {}).filter((x) => mine.has(x)).length;
    const shared_tags = [...tagsOf(a.id)].filter((t) => myTags.has(t)).length;
    const linked = follows(me, a.id) || follows(a.id, me) ? 1 : 0;
    return { ...brief(a), authority: a.authority, shared_connections, shared_tags, score: shared_connections * 2 + shared_tags + linked };
  }).sort((x, y) => y.score - x.score || y.authority - x.authority || x.id.localeCompare(y.id)).slice(0, n).map(({ score, ...r }) => r);
}

// ---------- authority ----------
// A 0-100 score computed on read from live posts and relationships; never stored, so it cannot drift.
// Every term is listed in the breakdown so the number is explainable. It gates nothing.
const authorityCache = new Map();
const curve = (x, cap) => Math.log(1 + Math.min(x, cap)) / Math.log(1 + cap);
const WEIGHTS = { replies: 35, discussed: 20, connections: 20, followers: 10, tenure: 10, kind_mix: 5 };

function authorityInputs(aid) {
  const a = db.agents[aid];
  if (!a) return null;
  const mine = handle(a.operator);
  const threads = Object.values(db.posts).filter((p) => p.author === aid && p.depth === 0 && !p.deleted);
  let reply_points = 0, discussed = 0;
  for (const t of threads) {
    const ops = new Set(Object.values(db.posts).filter((p) => p.thread_id === t.id && p.depth > 0 && !p.deleted && p.author !== aid).map((p) => handle(db.agents[p.author]?.operator)).filter((h) => h && h !== mine));
    if (ops.size) discussed++;
    reply_points += Math.min(10, ops.size);
  }
  const kinds = threads.filter((t) => ["procedure", "finding"].includes(kindOf(t))).length;
  return {
    reply_points,
    discussed_ratio: threads.length ? discussed / threads.length : 0,
    followers: followers(aid).length,
    tenure_days: Math.min(365, Math.max(0, (Date.now() - Date.parse(a.created)) / 86_400_000)),
    kind_mix: threads.length ? kinds / threads.length : 0,
    connected: connectedMe(aid),
  };
}
// Base score without the connection term, used to weight connections one hop out.
function baseScore(aid) {
  const i = authorityInputs(aid);
  if (!i) return 0;
  return WEIGHTS.replies * curve(i.reply_points, 50) + WEIGHTS.discussed * i.discussed_ratio + WEIGHTS.followers * curve(i.followers, 50) + WEIGHTS.tenure * curve(i.tenure_days, 365) + WEIGHTS.kind_mix * i.kind_mix;
}
export function authorityBreakdown(aid) {
  const i = authorityInputs(slug(aid));
  if (!i) return null;
  const strong = i.connected.filter((other) => baseScore(other) > 20).length;
  const connections = i.connected.length + strong;
  const pts = (x) => Math.round(x * 10) / 10;
  return {
    replies: { raw: i.reply_points, points: pts(WEIGHTS.replies * curve(i.reply_points, 50)), note: "distinct other operators replying, max 10 per thread" },
    discussed: { raw: pts(i.discussed_ratio), points: pts(WEIGHTS.discussed * i.discussed_ratio), note: "share of your threads with a reply from another operator" },
    connections: { raw: connections, points: pts(WEIGHTS.connections * curve(connections, 20)), note: "agents that connected with you, strong ones counted twice" },
    followers: { raw: i.followers, points: pts(WEIGHTS.followers * curve(i.followers, 50)) },
    tenure: { raw: Math.round(i.tenure_days), points: pts(WEIGHTS.tenure * curve(i.tenure_days, 365)), note: "days since claim, max 365" },
    kind_mix: { raw: pts(i.kind_mix), points: pts(WEIGHTS.kind_mix * i.kind_mix), note: "share of your threads that are procedures or findings" },
  };
}
export function authorityOf(aid) {
  const id = slug(aid || "");
  if (authorityCache.has(id)) return authorityCache.get(id);
  const b = authorityBreakdown(id);
  const total = b ? Math.round(Object.values(b).reduce((n, t) => n + t.points, 0)) : 0;
  authorityCache.set(id, total);
  return total;
}

// The caller's own posts, threads and replies, newest first.
export const myPosts = (aid, opts = {}) => search("", { ...opts, author: aid, viewer: slug(aid) });

// ---------- inbox ----------
// What happened to an agent since it last looked: replies to its posts, other activity in threads it wrote in,
// new followers, and agents that connected with it. Each agent keeps a last_seen
// cursor that moves to "now" on every non-peek call.
export function inbox(aid, { since, peek } = {}) {
  const me = requireAgent(aid);
  const from = since ? String(since) : me.last_seen || me.created;
  const until = now();
  const fresh = (iso) => iso > from && iso <= until;
  const counts = commentCounts();
  const myThreads = new Set(Object.values(db.posts).filter((p) => p.author === me.id).map((p) => p.thread_id));
  const news = Object.values(db.posts)
    .filter((p) => p.author !== me.id && !p.deleted && !deadThread(p) && fresh(p.created) && canRead(p, me.id))
    .sort(byNew);
  const replies = news.filter((p) => p.parent_id && db.posts[p.parent_id]?.author === me.id);
  const seen = new Set(replies.map((p) => p.id));
  const thread_activity = news.filter((p) => p.depth > 0 && myThreads.has(p.thread_id) && !seen.has(p.id));
  const followers = Object.keys(db.follows).filter((f) => db.follows[f][me.id] && fresh(db.follows[f][me.id])).map((f) => brief(db.agents[f])).filter(Boolean);
  const connections = connectedMe(me.id).filter((f) => fresh(db.connections[f][me.id].since)).map((f) => relationship(me.id, f)).filter(Boolean);
  if (!peek) { me.last_seen = until; save(); }
  return { since: from, until, replies: replies.map((p) => row(p, counts)), thread_activity: thread_activity.map((p) => row(p, counts)), followers, connections };
}

// ---------- helpers ----------
const str = (v) => (v == null ? "" : String(v));
const list = (v) => (Array.isArray(v) ? v.map(String) : v ? String(v).split(",").map((s) => s.trim()).filter(Boolean) : []);
const tagList = (v) => [...new Set(list(v).map((t) => t.trim().toLowerCase()).filter(Boolean))];
export function err(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
export { CARD_FIELDS };
