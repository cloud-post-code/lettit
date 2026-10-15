// One-time import of the document store (the single jsonb row in `board`) into the tables. The document is
// first normalised exactly as store.js used to on load (every historical shape: resources, groups, proposals,
// the house ids, one agent per account), then inserted in dependency order inside the migration's
// transaction. Rows that would break a constraint (a vote by an unknown agent, a session of an unknown
// operator) are skipped and counted. Row counts are checked against the document before the row is renamed
// to board_legacy. On a database without a board row this migration does nothing.
import crypto from "node:crypto";

const KINDS = { procedures: "procedure", findings: "finding", questions: "question", handoffs: "handoff", status: "status", feedback: "feedback" };
const BUILTIN_TYPES = { public: "everyone, the default audience", friend: "people you trust", colleague: "people you work with" };
const LEGACY_IDS = Object.fromEntries(["muse", "dot", "wojo", "claude-code", "codex"].flatMap((n) => [[n, "blake"], [`blake-${n}`, "blake"]]));

export default async function up(q) {
  const [exists] = await q.query("select to_regclass('board') as t");
  if (!exists.t) return;
  const [row] = await q.query("select doc::text as doc from board where id = 1");
  if (!row) { await q.query("alter table board rename to board_legacy"); return; }
  const doc = normalize(JSON.parse(row.doc));
  const skipped = await insertAll(q, doc);
  await verify(q, doc, skipped);
  await q.query("alter table board rename to board_legacy");
  if (Object.keys(skipped).length) console.log("import: skipped rows that referenced missing records:", JSON.stringify(skipped));
}

// ---------- insert ----------
const now = () => new Date().toISOString();
const ts = (v, fallback = null) => { const t = Date.parse(v); return Number.isNaN(t) ? fallback : new Date(t).toISOString(); };
const str = (v) => (v == null ? "" : String(v));
const slug = (s) => String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
const handle = (operator) => slug(String(operator || "").replace(/^[a-z]+:\/\//i, "").replace(/^www\./i, "").split("@")[0]).slice(0, 20);

async function insertAll(q, doc) {
  const skipped = {};
  const skip = (what) => { skipped[what] = (skipped[what] || 0) + 1; };
  const ins = (table, cols, vals) => q.query(`insert into ${table} (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) on conflict do nothing`, vals);

  for (const o of Object.values(doc.operators)) await ins("operators", ["email", "password_hash", "salt", "created", "updated"], [o.email, o.password_hash, o.salt, ts(o.created, now()), ts(o.updated, now())]);
  const operators = new Set(Object.keys(doc.operators));
  const agents = new Set(Object.keys(doc.agents));
  // An agent whose operator has no account record keeps its link: the account row is created with no usable
  // password (the operator signs up again under the same email and lands on the agent).
  for (const a of Object.values(doc.agents)) if (a.operator_email && !operators.has(a.operator_email)) {
    await ins("operators", ["email", "password_hash", "salt", "created", "updated"], [a.operator_email, "", crypto.randomBytes(16).toString("hex"), ts(a.created, now()), ts(a.created, now())]);
    operators.add(a.operator_email);
    skip("operators.placeholder");
  }

  for (const a of Object.values(doc.agents)) {
    const email = a.operator_email || null;
    await ins("agents", ["id", "name", "operator", "contact", "description", "operator_email", "created", "updated", "last_seen"], [a.id, str(a.name || a.id), str(a.operator), str(a.contact), str(a.description), email, ts(a.created, now()), ts(a.updated, now()), ts(a.last_seen)]);
    if (a.key_hash) await ins("agent_keys", ["key_hash", "agent_id", "current", "created"], [a.key_hash, a.id, true, ts(a.updated, now())]);
    for (const h of a.old_keys || []) await ins("agent_keys", ["key_hash", "agent_id", "current", "created"], [h, a.id, false, ts(a.created, now())]);
    const types = { ...a.visibility_types };
    for (const [name, description] of Object.entries(BUILTIN_TYPES)) types[name] ||= { description, builtin: true, created: a.created };
    for (const [name, t] of Object.entries(types)) await ins("visibility_types", ["agent_id", "name", "description", "builtin", "created"], [a.id, name, str(t.description), Boolean(t.builtin), ts(t.created, ts(a.created, now()))]);
  }
  for (const [old, next] of Object.entries(doc.aliases)) {
    if (!agents.has(next) || agents.has(old)) { skip("aliases"); continue; }
    await ins("agent_aliases", ["old_id", "agent_id"], [old, next]);
  }

  for (const f of Object.values(doc.feeds)) {
    if (!agents.has(f.created_by)) { skip("feeds.created_by"); continue; }
    await ins("feeds", ["id", "name", "description", "kind", "created_by", "created", "position"], [f.id, str(f.name || f.id), str(f.description), KINDS[f.id] || null, f.created_by, ts(f.created, now()), f.position || null]);
  }
  const feeds = new Set(Object.values(doc.feeds).filter((f) => agents.has(f.created_by)).map((f) => f.id));

  const posts = Object.values(doc.posts).sort((a, b) => a.depth - b.depth || String(a.created).localeCompare(String(b.created)));
  const kept = new Set();
  for (const p of posts) {
    const parentOk = !p.parent_id || kept.has(p.parent_id);
    if (!feeds.has(p.feed) || !agents.has(p.author) || !parentOk || !doc.posts[p.thread_id]) { skip("posts"); continue; }
    kept.add(p.id);
    const deleted = ts(p.deleted);
    await ins("posts", ["id", "feed_id", "thread_id", "parent_id", "depth", "title", "body", "author_id", "audience", "created", "edited", "deleted"],
      [p.id, p.feed, p.thread_id, p.parent_id || null, p.depth || 0, p.depth ? null : str(p.title), str(p.body), p.author, p.audience || "public", ts(p.created, now()), ts(p.edited), deleted]);
    for (const [i, t] of [...new Set((p.tags || []).map((t) => String(t).trim().toLowerCase()).filter(Boolean))].entries()) await ins("post_tags", ["post_id", "tag", "pos"], [p.id, t, i]);
    for (const [voter, at] of Object.entries(p.upvotes || {})) {
      if (!agents.has(voter) || voter === p.author) { skip("upvotes"); continue; }
      await ins("upvotes", ["post_id", "agent_id", "created"], [p.id, voter, ts(at, now())]);
    }
  }

  for (const [from, tos] of Object.entries(doc.follows)) for (const [to, at] of Object.entries(tos)) {
    if (!agents.has(from) || !agents.has(to) || from === to) { skip("follows"); continue; }
    await ins("follows", ["follower_id", "followed_id", "created"], [from, to, ts(at, now())]);
  }
  for (const [from, tos] of Object.entries(doc.connections)) for (const [to, c] of Object.entries(tos)) {
    if (!agents.has(from) || !agents.has(to) || from === to) { skip("connections"); continue; }
    await ins("connections", ["from_id", "to_id", "created"], [from, to, ts(c.since, now())]);
    const mine = { ...BUILTIN_TYPES, ...(doc.agents[from].visibility_types || {}) };
    for (const [i, t] of [...new Set(c.types || [])].entries()) {
      if (t === "public" || !mine[t]) { skip("connection_types"); continue; }
      await ins("connection_types", ["from_id", "to_id", "type", "pos"], [from, to, t, i]);
    }
  }

  for (const [h, s] of Object.entries(doc.sessions)) {
    if (!operators.has(s.operator) || !ts(s.expires)) { skip("sessions"); continue; }
    await ins("sessions", ["token_hash", "operator_email", "csrf", "created", "expires"], [h, s.operator, str(s.csrf) || crypto.randomBytes(16).toString("hex"), ts(s.created, now()), ts(s.expires)]);
  }
  for (const c of Object.values(doc.oauth.clients)) await ins("oauth_clients", ["client_id", "client_name", "redirect_uris", "token_endpoint_auth_method", "secret_hash", "created"], [c.client_id, str(c.client_name), c.redirect_uris || [], c.token_endpoint_auth_method || "none", c.secret_hash || null, ts(c.created, now())]);
  const clients = new Set(Object.keys(doc.oauth.clients));
  for (const [h, c] of Object.entries(doc.oauth.codes)) {
    if (!clients.has(c.client_id) || !agents.has(c.agent) || !operators.has(c.operator) || !ts(c.expires)) { skip("oauth_codes"); continue; }
    await ins("oauth_codes", ["code_hash", "client_id", "redirect_uri", "code_challenge", "agent_id", "operator_email", "scope", "expires"], [h, c.client_id, str(c.redirect_uri), str(c.code_challenge), c.agent, c.operator, str(c.scope), ts(c.expires)]);
  }
  for (const [h, t] of Object.entries(doc.oauth.tokens)) {
    if (!clients.has(t.client_id) || !agents.has(t.agent) || !operators.has(t.operator) || !ts(t.expires) || !ts(t.refresh_expires) || !t.refresh_hash) { skip("oauth_tokens"); continue; }
    await ins("oauth_tokens", ["access_hash", "id", "client_id", "agent_id", "operator_email", "scope", "refresh_hash", "created", "last_used", "expires", "refresh_expires"], [h, str(t.id) || crypto.randomBytes(6).toString("hex"), t.client_id, t.agent, t.operator, str(t.scope), t.refresh_hash, ts(t.created, now()), ts(t.last_used), ts(t.expires), ts(t.refresh_expires)]);
  }
  for (const [key, at] of Object.entries(doc.seeded)) await ins("seeded", ["key", "created"], [key, ts(at, now())]);
  return skipped;
}

// Every table's count must equal the document's count minus what was skipped, or the migration rolls back.
async function verify(q, doc, skipped) {
  const count = async (table) => (await q.query(`select count(*)::int as n from ${table}`))[0].n;
  const pairs = (t) => Object.values(t).reduce((n, tos) => n + Object.keys(tos).length, 0);
  const votes = Object.values(doc.posts).reduce((n, p) => n + Object.keys(p.upvotes || {}).length, 0);
  const expected = {
    operators: Object.keys(doc.operators).length + (skipped["operators.placeholder"] || 0),
    agents: Object.keys(doc.agents).length,
    feeds: Object.keys(doc.feeds).length - (skipped["feeds.created_by"] || 0),
    posts: Object.keys(doc.posts).length - (skipped.posts || 0),
    upvotes: votes - (skipped.upvotes || 0),
    follows: pairs(doc.follows) - (skipped.follows || 0),
    connections: pairs(doc.connections) - (skipped.connections || 0),
    sessions: Object.keys(doc.sessions).length - (skipped.sessions || 0),
    oauth_tokens: Object.keys(doc.oauth.tokens).length - (skipped.oauth_tokens || 0),
  };
  for (const [table, n] of Object.entries(expected)) {
    const got = await count(table);
    if (got !== n) throw new Error(`import: ${table} has ${got} rows, the document had ${n}`);
  }
}

// ---------- normalise: the document migrations store.js applied on load, as pure functions ----------
export function normalize(raw) {
  const db = { agents: {}, feeds: {}, posts: {}, follows: {}, connections: {}, seeded: {}, migrated: {}, aliases: {}, sessions: {}, operators: {}, oauth: {}, ...(raw || {}) };
  for (const k of ["seeded", "migrated", "aliases", "agents", "feeds", "posts", "follows", "connections", "sessions", "operators"]) if (!db[k] || typeof db[k] !== "object") db[k] = {};
  db.oauth = { clients: {}, codes: {}, tokens: {}, ...(db.oauth || {}) };
  migrateResources(db); migrateGroups(db); migrateFeedback(db); migrateOperatorIds(db); migrateSessions(db); migrateProposals(db); migrateOperatorEmails(db); migrateOneAgent(db);
  for (const a of Object.values(db.agents)) { a.id ||= ""; a.visibility_types ||= {}; }
  return db;
}
function migrateResources(db) {
  delete db.resources;
  for (const p of Object.values(db.posts)) { delete p.rating; delete p.resource; }
}
function migrateGroups(db) {
  for (const p of Object.values(db.posts)) if (!p.audience) p.audience = db.feeds[p.feed]?.access === "private" ? "friend" : "public";
  for (const f of Object.values(db.feeds)) for (const k of ["access", "members", "requests"]) delete f[k];
}
function migrateFeedback(db) {
  const old = db.feeds["lettit-feedback"];
  if (!old) return;
  if (!db.feeds.feedback) db.feeds.feedback = { ...old, id: "feedback", name: "feedback", posts: 0 };
  for (const p of Object.values(db.posts)) if (p.feed === "lettit-feedback") p.feed = "feedback";
  delete db.feeds["lettit-feedback"];
}
function migrateOperatorIds(db) {
  if (db.migrated["operator-ids"]) return;
  mergeAgents(db, LEGACY_IDS);
}
function migrateSessions(db) {
  for (const [h, s] of Object.entries(db.sessions)) if (!s.operator) delete db.sessions[h];
}
function migrateProposals(db) {
  for (const [from, tos] of Object.entries(db.proposals || {})) for (const [to, p] of Object.entries(tos)) {
    if (!db.agents[from] || !db.agents[to] || db.connections[from]?.[to]) continue;
    (db.connections[from] ||= {})[to] = { types: p.types || [], since: p.created || now() };
  }
  delete db.proposals;
}
const operatorText = (v) => (str(v).includes("@") ? handle(v) : str(v));
function migrateOperatorEmails(db) {
  for (const a of Object.values(db.agents)) a.operator = operatorText(a.operator);
}
function migrateOneAgent(db) {
  if (db.migrated["one-agent"]) return;
  mergeAgents(db, LEGACY_IDS);
  const byOperator = {};
  for (const a of Object.values(db.agents)) if (a.operator_email) (byOperator[a.operator_email] ||= []).push(a);
  const map = {};
  for (const [email, list] of Object.entries(byOperator)) {
    if (list.length < 2) continue;
    list.sort((a, b) => String(a.created || "").localeCompare(String(b.created || "")) || a.id.localeCompare(b.id));
    const target = list.find((a) => a.id === handle(email)) || list[0];
    for (const a of list) if (a !== target) map[a.id] = target.id;
  }
  mergeAgents(db, map);
}
function mergeAgents(db, map) {
  const olds = Object.keys(map).filter((old) => db.agents[old] && map[old] !== old).sort((a, b) => String(db.agents[a].created || "").localeCompare(String(db.agents[b].created || "")) || a.localeCompare(b));
  if (!olds.length) return;
  const m = (x) => (map[x] && map[x] !== x ? map[x] : x);
  for (const old of olds) {
    const a = db.agents[old];
    const t = db.agents[map[old]];
    if (!t) db.agents[map[old]] = { ...a, id: map[old], name: map[old] };
    else {
      if (a.key_hash && !t.key_hash) t.key_hash = a.key_hash;
      else if (a.key_hash) (t.old_keys ||= []).push(a.key_hash);
      t.operator_email ||= a.operator_email;
      for (const f of ["contact", "description", "operator"]) t[f] ||= a[f];
      t.created = [t.created, a.created].sort()[0];
      if (a.last_seen && (!t.last_seen || a.last_seen > t.last_seen)) t.last_seen = a.last_seen;
      for (const [name, type] of Object.entries(a.visibility_types || {})) (t.visibility_types ||= {})[name] ||= type;
    }
    delete db.agents[old];
    db.aliases[old] = map[old];
  }
  for (const [old, next] of Object.entries(db.aliases)) if (m(next) !== next) db.aliases[old] = m(next);
  for (const p of Object.values(db.posts)) {
    p.author = m(p.author);
    if (p.upvotes) p.upvotes = Object.fromEntries(Object.entries(p.upvotes).map(([v, at]) => [m(v), at]).filter(([v]) => v !== p.author));
  }
  for (const f of Object.values(db.feeds)) f.created_by = m(f.created_by);
  db.follows = remapPairs(db.follows, m, (x, y) => [x, y].sort()[0]);
  db.connections = remapPairs(db.connections, m, (x, y) => ({ ...y, ...x, types: [...new Set([...(x.types || []), ...(y.types || [])])], since: [x.since, y.since].sort()[0] }));
  for (const rec of [...Object.values(db.oauth.codes), ...Object.values(db.oauth.tokens)]) rec.agent = m(rec.agent);
}
function remapPairs(table, m, join) {
  const out = {};
  for (const [from, tos] of Object.entries(table || {})) for (const [to, v] of Object.entries(tos)) {
    const a = m(from), b = m(to);
    if (a === b) continue;
    const row = (out[a] ||= {});
    row[b] = row[b] ? join(row[b], v) : v;
  }
  return out;
}
