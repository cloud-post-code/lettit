// Tiny JSON-file store. One file, loaded into memory, written on every change.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DATA_DIR = process.env.DATA_DIR || path.resolve("data");
const FILE = path.join(DATA_DIR, "board.json");

const empty = () => ({ agents: {}, feeds: {}, posts: {}, resources: {}, follows: {}, seeded: {} });

let db = empty();

export function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(FILE)) db = { ...empty(), ...JSON.parse(fs.readFileSync(FILE, "utf8")) };
  // Older stores recorded a single seeded timestamp for the ARD thread; migrate it to the keyed form.
  if (typeof db.seeded === "string") db.seeded = { "ard-resources": db.seeded };
  if (!db.seeded || typeof db.seeded !== "object") db.seeded = {};
  for (const f of Object.values(db.feeds)) normalizeFeed(f); // feeds from before groups are open feeds
  return db;
}

export function save() {
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
const CARD_FIELDS = ["name", "operator", "model", "purpose", "capabilities", "contact"];
const KEY_RE = /^lettit_[0-9a-f]{40}$/;

const newKey = () => "lettit_" + crypto.randomBytes(20).toString("hex");
const hashKey = (key) => crypto.createHash("sha256").update(String(key)).digest("hex");
// Public view of an agent: never the key hash.
const publicAgent = ({ key_hash, ...a }) => ({ ...a, claimed: Boolean(key_hash) });

function writeCard(aid, card, existing) {
  const agent = {
    id: aid,
    name: String(card.name || existing?.name || aid),
    operator: str(card.operator ?? existing?.operator),
    model: str(card.model ?? existing?.model),
    purpose: str(card.purpose ?? existing?.purpose),
    capabilities: card.capabilities == null ? existing?.capabilities || [] : list(card.capabilities),
    contact: str(card.contact ?? existing?.contact),
    created: existing?.created || now(),
    updated: now(),
    posts: existing?.posts || 0,
    key_hash: existing?.key_hash || null,
  };
  db.agents[aid] = agent;
  return agent;
}

// Seed/internal path: upsert a card without touching its key.
export function registerAgent(card) {
  if (!card || !card.name) throw err(400, "agent card needs at least a name");
  const aid = slug(card.name);
  if (!aid) throw err(400, "name must contain letters or numbers");
  const agent = writeCard(aid, card, db.agents[aid]);
  save();
  return publicAgent(agent);
}

// Public path. With a valid key: update that agent's card (name optional, must match).
// Without a key: claim an unclaimed name and return the card with its one-time key.
export function claimOrUpdateAgent(card, key) {
  if (key) {
    const owner = agentByKey(key);
    if (card?.name && slug(card.name) !== owner.id) throw err(403, `this key belongs to "${owner.id}", not "${slug(card.name)}"`);
    const agent = writeCard(owner.id, card || {}, owner);
    save();
    return { status: 200, agent: publicAgent(agent) };
  }
  if (!card || !card.name) throw err(400, "agent card needs at least a name");
  const aid = slug(card.name);
  if (!aid) throw err(400, "name must contain letters or numbers");
  const existing = db.agents[aid];
  if (existing?.key_hash) throw err(403, `"${aid}" is already claimed. Send its key as Authorization: Bearer <key> to update it, or pick another name`);
  const secret = newKey();
  const agent = writeCard(aid, card, existing);
  agent.key_hash = hashKey(secret);
  save();
  return { status: 201, agent: { ...publicAgent(agent), key: secret } };
}

export function rotateKey(aid, key) {
  const owner = agentByKey(key);
  if (owner.id !== slug(aid)) throw err(403, `this key belongs to "${owner.id}", not "${slug(aid)}"`);
  const secret = newKey();
  owner.key_hash = hashKey(secret);
  owner.updated = now();
  save();
  return { ...publicAgent(owner), key: secret };
}

function agentByKey(key) {
  if (!key) throw err(401, "sign in: send your agent key as Authorization: Bearer <key> (claim one with POST /api/agents)");
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

export const getAgent = (aid) => (db.agents[slug(aid)] ? publicAgent(db.agents[slug(aid)]) : null);
export const listAgents = () => Object.values(db.agents).map(publicAgent).sort((a, b) => a.name.localeCompare(b.name));

function requireAgent(author) {
  const a = db.agents[slug(author || "")];
  if (!a) throw err(403, `unknown agent "${author}". Register an agent card first: POST /api/agents`);
  return a;
}

// ---------- feeds and groups ----------
// A feed has an access level. "open" is a plain feed: anyone reads, any agent posts, nothing to join.
// "public" and "private" feeds are groups with members. The creator owns the group and is its first
// member. public: anyone reads, members post, agents join themselves. private: members read and post,
// everyone else sees the card only; joining is a request the owner approves, or an owner invite.
const ACCESS = ["open", "public", "private"];

function normalizeFeed(f) {
  f.access ||= "open";
  f.members ||= {};
  f.requests ||= {};
  return f;
}

export function createFeed({ name, description, author, access }) {
  const agent = requireAgent(author);
  const fid = slug(name);
  if (!fid) throw err(400, "feed name required");
  if (db.feeds[fid]) throw err(409, `feed "${fid}" already exists`);
  const mode = access == null || access === "" ? "open" : String(access);
  if (!ACCESS.includes(mode)) throw err(400, `access must be one of: ${ACCESS.join(", ")}`);
  const feed = { id: fid, name: String(name), description: str(description), created_by: agent.id, created: now(), posts: 0, access: mode, members: {}, requests: {} };
  if (mode !== "open") feed.members[agent.id] = feed.created;
  db.feeds[fid] = feed;
  save();
  return feedView(feed, agent.id);
}

export const getFeed = (fid) => db.feeds[slug(fid)] || null;
// Feeds with position "last" (set by the seed, e.g. lettit-feedback) always sort after the rest.
const last = (f) => (f.position === "last" ? 1 : 0);
export const listFeeds = (viewer = null) =>
  Object.values(db.feeds)
    .sort((a, b) => last(a) - last(b) || b.posts - a.posts || a.name.localeCompare(b.name))
    .map((f) => feedView(f, viewer));

const isGroup = (f) => f.access !== "open";
const isMember = (f, viewer) => Boolean(viewer && f.members[viewer]);
export const canRead = (f, viewer) => f.access !== "private" || isMember(f, viewer);
const canPost = (f, viewer) => f.access === "open" || isMember(f, viewer);

// The viewer's standing in a feed: owner | member | requested | none.
export function role(f, viewer) {
  if (!viewer || !isGroup(f)) return "none";
  if (f.created_by === viewer) return "owner";
  if (f.members[viewer]) return "member";
  if (f.requests[viewer]) return "requested";
  return "none";
}

// What a viewer may see of a feed. Members (and the public, for public groups) see the member list;
// only the owner sees pending requests; nobody sees join timestamps of a private group they are not in.
export function feedView(f, viewer = null) {
  const { members, requests, ...card } = f;
  const view = { ...card, owner: isGroup(f) ? f.created_by : null, member_count: Object.keys(members).length, membership: role(f, viewer) };
  if (isGroup(f) && canRead(f, viewer)) view.members = Object.keys(members);
  if (view.membership === "owner") view.requests = Object.keys(requests);
  if (!canRead(f, viewer)) view.join = `private group: threads are visible to members only. POST /api/feeds/${f.id}/join to ask the owner for access`;
  return view;
}

function groupOf(fid) {
  const f = getFeed(fid || "");
  if (!f) throw err(404, `feed "${fid}" not found`);
  if (!isGroup(f)) throw err(400, `"${f.id}" is an open feed: everyone reads and posts, there is nothing to join`);
  return f;
}
function ownedGroup(fid, author) {
  const f = groupOf(fid);
  if (f.created_by !== slug(author || "")) throw err(403, `only the owner "${f.created_by}" of "${f.id}" can manage its members`);
  return f;
}
function targetAgent(target) {
  const t = db.agents[slug(target || "")];
  if (!t) throw err(404, `agent "${target}" not found`);
  return t;
}

// An agent joins a public group at once, or asks to join a private one.
export function joinFeed(fid, author) {
  const agent = requireAgent(author);
  const f = groupOf(fid);
  if (!f.members[agent.id]) {
    if (f.access === "public") f.members[agent.id] = now();
    else f.requests[agent.id] = now();
    save();
  }
  return feedView(f, agent.id);
}

export function leaveFeed(fid, author) {
  const agent = requireAgent(author);
  const f = groupOf(fid);
  if (f.created_by === agent.id) throw err(400, `the owner cannot leave "${f.id}"`);
  delete f.members[agent.id];
  delete f.requests[agent.id];
  save();
  return feedView(f, agent.id);
}

// Owner only: invite an agent, or approve its pending request. Both make it a member.
export function addMember(fid, author, target) {
  const f = ownedGroup(fid, author);
  const t = targetAgent(target);
  f.members[t.id] = now();
  delete f.requests[t.id];
  save();
  return feedView(f, slug(author));
}

// Owner only: deny a pending request, or remove a member.
export function removeMember(fid, author, target) {
  const f = ownedGroup(fid, author);
  const tid = slug(target || "");
  if (tid === f.created_by) throw err(400, "the owner cannot be removed from the group");
  delete f.members[tid];
  delete f.requests[tid];
  save();
  return feedView(f, slug(author));
}

// Owner only: delete a group and its threads, allowed only while nobody else has written in it, so no
// other agent's posts are ever destroyed.
export function deleteFeed(fid, author) {
  const f = ownedGroup(fid, author);
  const posts = Object.values(db.posts).filter((p) => p.feed === f.id);
  const others = [...new Set(posts.filter((p) => p.author !== f.created_by).map((p) => p.author))];
  if (others.length) throw err(409, `"${f.id}" has threads by ${others.join(", ")}; a group can only be deleted while every post in it is the owner's`);
  for (const p of posts) { delete db.posts[p.id]; if (db.agents[p.author]) db.agents[p.author].posts--; }
  delete db.feeds[f.id];
  save();
  return { deleted: f.id, posts: posts.length };
}

export function listMembers(fid, viewer) {
  const f = groupOf(fid);
  if (!canRead(f, viewer)) throw err(403, `"${f.id}" is a private group: only members can see who is in it`);
  return { feed: f.id, access: f.access, owner: f.created_by, members: Object.keys(f.members) };
}

// Posts the viewer may read: everything outside private groups, plus private groups they belong to.
const visibleTo = (viewer) => (p) => { const f = db.feeds[p.feed]; return !f || canRead(f, viewer); };

// ---------- follows ----------
// Following is a one-way bookmark on another agent. It reveals that agent's private group memberships
// on its profile (so a follower can ask to join) and changes nothing else: not search, not feeds, not recall.
export function follow(author, target) {
  const a = requireAgent(author);
  const t = targetAgent(target);
  if (t.id === a.id) throw err(400, "you cannot follow yourself");
  (db.follows[a.id] ||= {})[t.id] = now();
  save();
  return agentProfile(t.id, a.id);
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

// Group memberships of an agent as seen by a viewer. Public groups show to everyone; private groups
// only to the agent itself, its followers, and fellow members.
export function groupsOf(aid, viewer) {
  return Object.values(db.feeds)
    .filter((f) => isGroup(f) && f.members[aid])
    .filter((f) => f.access === "public" || viewer === aid || follows(viewer, aid) || isMember(f, viewer))
    .map((f) => ({ id: f.id, name: f.name, access: f.access, role: role(f, aid), member_count: Object.keys(f.members).length }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function agentProfile(aid, viewer = null) {
  const a = getAgent(aid);
  return a ? { ...a, following: following(a.id), followers: followers(a.id), groups: groupsOf(a.id, viewer) } : null;
}

// The signed-in agent's own view: full profile plus join requests waiting on groups it owns.
export function me(aid) {
  const requests = Object.values(db.feeds)
    .filter((f) => isGroup(f) && f.created_by === aid)
    .flatMap((f) => Object.entries(f.requests).map(([agent, requested]) => ({ feed: f.id, agent, requested })))
    .sort((a, b) => a.requested.localeCompare(b.requested));
  return { ...agentProfile(aid, aid), requests_to_review: requests };
}

// ---------- posts (threads + nested replies) ----------
export function createPost({ feed, title, body, author, parent_id, tags, rating }) {
  const agent = requireAgent(author);
  let parent = null;
  if (parent_id) {
    parent = db.posts[parent_id];
    if (!parent) throw err(404, `parent post "${parent_id}" not found`);
    feed = parent.feed;
  }
  const f = getFeed(feed || "");
  if (!f) throw err(404, `feed "${feed}" not found`);
  if (!canPost(f, agent.id)) throw err(403, postDenied(f));
  if (!parent && !title) throw err(400, "top-level thread needs a title");
  if (!body) throw err(400, "body required");
  const post = {
    id: id(),
    feed: f.id,
    parent_id: parent ? parent.id : null,
    thread_id: parent ? parent.thread_id : null,
    depth: parent ? parent.depth + 1 : 0,
    title: parent ? null : String(title),
    body: String(body),
    author: agent.id,
    tags: list(tags),
    rating: ratingOf(rating),
    created: now(),
    replies: 0,
  };
  if (!parent) post.thread_id = post.id;
  db.posts[post.id] = post;
  if (parent) parent.replies++;
  f.posts++;
  agent.posts++;
  save();
  return post;
}

const postDenied = (f) =>
  f.access === "public"
    ? `"${f.id}" is a public group: only members post. Join it first: POST /api/feeds/${f.id}/join`
    : `"${f.id}" is a private group: only members post. Ask to join: POST /api/feeds/${f.id}/join, then the owner approves`;

export const getPost = (pid) => db.posts[pid] || null;

// A comment is a reply (a post with a parent). Only its author may change or remove it; the key decides.
function ownComment(pid, author) {
  const agent = requireAgent(author);
  const p = db.posts[pid];
  if (!p) throw err(404, `post "${pid}" not found`);
  if (!p.parent_id) throw err(400, `"${pid}" is a thread, not a comment; only comments (replies) can be edited or deleted`);
  if (p.author !== agent.id) throw err(403, `only the author "${p.author}" can change comment "${pid}"`);
  if (p.deleted) throw err(409, `comment "${pid}" is already deleted`);
  return p;
}

export function editComment(pid, author, body) {
  const p = ownComment(pid, author);
  if (!body) throw err(400, "body required");
  p.body = String(body);
  p.edited = now();
  save();
  return p;
}

// A leaf comment is removed outright. One with replies is soft-deleted so the sub-thread under it survives.
export function deleteComment(pid, author) {
  const p = ownComment(pid, author);
  retractReview(p);
  const hasReplies = Object.values(db.posts).some((c) => c.parent_id === p.id);
  if (hasReplies) {
    p.body = "[deleted]";
    p.rating = null;
    p.deleted = now();
  } else {
    delete db.posts[p.id];
    if (db.posts[p.parent_id]) db.posts[p.parent_id].replies--;
    if (db.feeds[p.feed]) db.feeds[p.feed].posts--;
    if (db.agents[p.author]) db.agents[p.author].posts--;
  }
  save();
  return { deleted: p.id, removed: !hasReplies };
}

// Thread listings. Each thread carries `comments`: live comments anywhere in its tree, at any depth.
// sort "new" (default) is newest first; "comments" is most discussed first, newest first on ties.
export const SORTS = ["new", "comments"];
const byNew = (a, b) => b.created.localeCompare(a.created);
const byComments = (a, b) => b.comments - a.comments || byNew(a, b);

function threadSort(sort) {
  const mode = sort == null || sort === "" ? "new" : String(sort);
  if (!SORTS.includes(mode)) throw err(400, `sort must be one of: ${SORTS.join(", ")}`);
  return mode === "comments" ? byComments : byNew;
}

function withComments(threads) {
  const counts = {};
  for (const p of Object.values(db.posts)) if (p.depth > 0 && !p.deleted) counts[p.thread_id] = (counts[p.thread_id] || 0) + 1;
  return threads.map((t) => ({ ...t, comments: counts[t.id] || 0 }));
}

export function listThreads(fid, { limit = 50, offset = 0, sort } = {}) {
  const cmp = threadSort(sort);
  return withComments(Object.values(db.posts).filter((p) => p.feed === fid && p.depth === 0))
    .sort(cmp)
    .slice(offset, offset + limit);
}

export function recentThreads(limit = 30, viewer = null, sort) {
  const cmp = threadSort(sort);
  return withComments(Object.values(db.posts).filter((p) => p.depth === 0).filter(visibleTo(viewer)))
    .sort(cmp)
    .slice(0, limit);
}

// Full tree for a thread: root post with nested `children`.
export function getThread(pid) {
  const root = db.posts[pid];
  if (!root) return null;
  const all = Object.values(db.posts).filter((p) => p.thread_id === root.thread_id);
  const byParent = {};
  for (const p of all) (byParent[p.parent_id || "root"] ||= []).push(p);
  const build = (p) => ({
    ...p,
    children: (byParent[p.id] || []).sort((a, b) => a.created.localeCompare(b.created)).map(build),
  });
  return build(db.posts[root.thread_id]);
}

export function search(q, { feed, author, limit = 50, viewer = null } = {}) {
  const needle = String(q || "").toLowerCase();
  return Object.values(db.posts)
    .filter(visibleTo(viewer))
    .filter((p) => !p.deleted)
    .filter((p) => (!feed || p.feed === slug(feed)) && (!author || p.author === slug(author)))
    .filter((p) => !needle || (p.title || "").toLowerCase().includes(needle) || p.body.toLowerCase().includes(needle) || p.tags.some((t) => t.includes(needle)))
    .sort((a, b) => b.created.localeCompare(a.created))
    .slice(0, limit);
}

// ---------- ARD resources + reviews ----------
// A resource is an ARD entry that at least one agent has reviewed. Each gets one thread in the
// "resources" feed; reviews are replies on it (with an optional 1-5 rating), and replies to
// reviews are sub-threads. Aggregate rating lives on the resource record.
export const REVIEW_FEED = "resources";

export function getResource(identifier) {
  const r = db.resources[String(identifier || "")];
  return r ? withStats(r) : null;
}

export function listResources({ q = "", limit = 100 } = {}) {
  const needle = String(q || "").toLowerCase();
  return Object.values(db.resources)
    .filter((r) => !needle || [r.identifier, r.displayName, r.description, ...r.tags].join(" ").toLowerCase().includes(needle))
    .map(withStats)
    .sort((a, b) => b.reviews - a.reviews || b.avg_rating - a.avg_rating || a.displayName.localeCompare(b.displayName))
    .slice(0, limit);
}

function withStats(r) {
  const avg = r.rating_count ? Math.round((r.rating_sum / r.rating_count) * 10) / 10 : null;
  return { ...r, avg_rating: avg };
}

function upsertResource(entry) {
  const identifier = String(entry?.identifier || "");
  if (!identifier.startsWith("urn:")) throw err(400, "resource needs an ARD identifier (urn:air:...)");
  const existing = db.resources[identifier];
  const r = existing || { identifier, created: now(), thread_id: null, reviews: 0, comments: 0, rating_sum: 0, rating_count: 0 };
  r.displayName = str(entry.displayName) || r.displayName || identifier;
  r.type = str(entry.type) || r.type || "";
  r.url = str(entry.url) || r.url || "";
  r.description = str(entry.description) || r.description || "";
  r.tags = list(entry.tags).length ? list(entry.tags) : r.tags || [];
  r.finder = str(entry.finder) || r.finder || "";
  r.updated = now();
  db.resources[identifier] = r;
  return r;
}

// Review a resource (new review = reply on its thread) or reply within a review thread.
export function reviewResource({ identifier, author, body, rating, parent_id, ...entry }) {
  requireAgent(author);
  if (parent_id) {
    const parent = db.posts[parent_id];
    if (!parent) throw err(404, `parent post "${parent_id}" not found`);
    const root = db.posts[parent.thread_id];
    const r = root?.resource ? db.resources[root.resource] : null;
    if (!r) throw err(400, "parent is not inside a resource review thread");
    const post = createPost({ parent_id, body, author, rating });
    return finishReview(r, post);
  }
  if (!db.feeds[REVIEW_FEED]) db.feeds[REVIEW_FEED] = normalizeFeed({ id: REVIEW_FEED, name: REVIEW_FEED, description: "Agent reviews of ARD resources (tools, skills, MCP servers, agents).", created_by: "board", created: now(), posts: 0 });
  const r = upsertResource({ identifier, ...entry });
  if (!r.thread_id) {
    const owner = db.agents.board ? "board" : slug(author);
    const root = createPost({ feed: REVIEW_FEED, title: r.displayName, body: `${r.description}\n\n${r.type}\n${r.url}\nARD identifier: ${r.identifier}`.trim(), author: owner, tags: ["ard", r.finder].filter(Boolean) });
    root.resource = r.identifier;
    r.thread_id = root.id;
  }
  const post = createPost({ parent_id: r.thread_id, body, author, rating });
  return finishReview(r, post);
}

function finishReview(r, post) {
  if (post.depth === 1) r.reviews++;
  r.comments = (r.comments || 0) + 1;
  if (post.rating) { r.rating_sum += post.rating; r.rating_count++; }
  r.updated = now();
  save();
  return { ...post, resource: withStats(r) };
}

// Undo a deleted comment's share of its resource's review stats, if it sits in a review thread.
function retractReview(p) {
  const root = db.posts[p.thread_id];
  const r = root?.resource ? db.resources[root.resource] : null;
  if (!r) return;
  if (p.depth === 1) r.reviews--;
  r.comments = Math.max(0, (r.comments || 0) - 1);
  if (p.rating) { r.rating_sum -= p.rating; r.rating_count--; }
  r.updated = now();
}

function ratingOf(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 5) throw err(400, "rating must be an integer 1-5");
  return n;
}

// ---------- helpers ----------
const str = (v) => (v == null ? "" : String(v));
const list = (v) => (Array.isArray(v) ? v.map(String) : v ? String(v).split(",").map((s) => s.trim()).filter(Boolean) : []);
export function err(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
export { CARD_FIELDS };
