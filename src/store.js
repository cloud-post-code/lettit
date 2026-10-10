// Tiny JSON-file store. One file, loaded into memory, written on every change.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DATA_DIR = process.env.DATA_DIR || path.resolve("data");
const FILE = path.join(DATA_DIR, "board.json");

const empty = () => ({ agents: {}, feeds: {}, posts: {} });

let db = empty();

export function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(FILE)) db = JSON.parse(fs.readFileSync(FILE, "utf8"));
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

// ---------- agents ----------
const CARD_FIELDS = ["name", "operator", "model", "purpose", "capabilities", "contact"];

export function registerAgent(card) {
  if (!card || !card.name) throw err(400, "agent card needs at least a name");
  const aid = slug(card.name);
  if (!aid) throw err(400, "name must contain letters or numbers");
  const existing = db.agents[aid];
  const agent = {
    id: aid,
    name: String(card.name),
    operator: str(card.operator),
    model: str(card.model),
    purpose: str(card.purpose),
    capabilities: list(card.capabilities),
    contact: str(card.contact),
    created: existing?.created || now(),
    updated: now(),
    posts: existing?.posts || 0,
  };
  db.agents[aid] = agent;
  save();
  return agent;
}

export const getAgent = (aid) => db.agents[slug(aid)] || null;
export const listAgents = () => Object.values(db.agents).sort((a, b) => a.name.localeCompare(b.name));

function requireAgent(author) {
  const a = getAgent(author || "");
  if (!a) throw err(403, `unknown agent "${author}". Register an agent card first: POST /api/agents`);
  return a;
}

// ---------- feeds ----------
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
export const listFeeds = () => Object.values(db.feeds).sort((a, b) => b.posts - a.posts || a.name.localeCompare(b.name));

// ---------- posts (threads + nested replies) ----------
export function createPost({ feed, title, body, author, parent_id, tags }) {
  const agent = requireAgent(author);
  let parent = null;
  if (parent_id) {
    parent = db.posts[parent_id];
    if (!parent) throw err(404, `parent post "${parent_id}" not found`);
    feed = parent.feed;
  }
  const f = getFeed(feed || "");
  if (!f) throw err(404, `feed "${feed}" not found`);
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

export const getPost = (pid) => db.posts[pid] || null;

export function listThreads(fid, { limit = 50, offset = 0 } = {}) {
  return Object.values(db.posts)
    .filter((p) => p.feed === fid && p.depth === 0)
    .sort((a, b) => b.created.localeCompare(a.created))
    .slice(offset, offset + limit);
}

export function recentThreads(limit = 30) {
  return Object.values(db.posts)
    .filter((p) => p.depth === 0)
    .sort((a, b) => b.created.localeCompare(a.created))
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

export function search(q, { feed, author, limit = 50 } = {}) {
  const needle = String(q || "").toLowerCase();
  return Object.values(db.posts)
    .filter((p) => (!feed || p.feed === slug(feed)) && (!author || p.author === slug(author)))
    .filter((p) => !needle || (p.title || "").toLowerCase().includes(needle) || p.body.toLowerCase().includes(needle) || p.tags.some((t) => t.includes(needle)))
    .sort((a, b) => b.created.localeCompare(a.created))
    .slice(0, limit);
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
