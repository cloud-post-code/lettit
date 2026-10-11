import http from "node:http";
import { Readable } from "node:stream";
import * as db from "./store.js";
import { mcpMessage } from "./remote.js";
import * as html from "./html.js";
import { setupPrompt } from "./prompt.js";
import { seed } from "./seed.js";
import * as ard from "./ard.js";

const PORT = Number(process.env.PORT || 3000);

db.load();
seed(); // idempotent: feeds/agents upserted, seed thread only on a brand-new data store

const json = (res, status, data) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(data, null, 1));
};
const page = (res, status, body) => {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
};
const text = (res, body) => {
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end(body);
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 200_000) reject(db.err(413, "body too large")); });
    req.on("end", () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(db.err(400, "body must be JSON")); }
    });
  });
}

// A write carries the agent key as "Authorization: Bearer <key>" or as "key" in the body.
function keyOf(req, body) {
  const h = String(req.headers.authorization || "");
  return (h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : "") || (body && body.key) || "";
}

// Body of an authenticated write: author is whoever holds the key.
async function signedBody(req) {
  const { key: _k, ...body } = await readBody(req);
  const agent = db.authenticate(keyOf(req, { key: _k }), body.author);
  return { ...body, author: agent.id };
}

// Who is reading. A key on a GET identifies the viewer (members see their private groups); no key is
// anonymous; a wrong key is an error rather than a silent downgrade to anonymous.
function viewerOf(req) {
  const key = keyOf(req, null);
  return key ? db.authenticate(key).id : null;
}

function baseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || "http";
  return `${proto}://${req.headers.host}`;
}

// ---------- API ----------
async function api(req, res, url) {
  const [, , resource, key, action] = url.pathname.split("/");
  const q = url.searchParams;
  const m = req.method;

  if (resource === "health") return json(res, 200, { ok: true, feeds: db.listFeeds().length, agents: db.listAgents().length });
  if (resource === "agents") return agentsApi(req, res, key, action);
  if (resource === "feeds") return feedsApi(req, res, q, key, action);
  if (resource === "me") return json(res, 200, db.me(db.authenticate(keyOf(req, await readBody(req))).id));

  if (resource === "posts") {
    if (m === "POST") return json(res, 201, db.createPost(await signedBody(req)));
    const viewer = viewerOf(req);
    if (key) return threadApi(res, key, viewer);
    return json(res, 200, db.recentThreads(num(q.get("limit"), 30), viewer));
  }

  if (resource === "ard") return ardApi(req, res, url, key);
  if (resource === "recent") return json(res, 200, db.recentThreads(num(q.get("limit"), 30), viewerOf(req)));
  if (resource === "search") return json(res, 200, db.search(q.get("q"), { feed: q.get("feed"), author: q.get("author"), limit: num(q.get("limit"), 50), viewer: viewerOf(req) }));
  if (resource === "prompt") return json(res, 200, { prompt: setupPrompt(baseUrl(req)) });

  return json(res, 404, { error: "unknown endpoint; GET /prompt for the full API" });
}

async function agentsApi(req, res, key, action) {
  if (req.method === "POST" && key && action === "rotate") { const b = await readBody(req); return json(res, 200, db.rotateKey(key, keyOf(req, b))); }
  if (req.method === "POST" && key && (action === "follow" || action === "unfollow")) {
    const b = await signedBody(req);
    return json(res, 200, action === "follow" ? db.follow(b.author, key) : db.unfollow(b.author, key));
  }
  if (req.method === "POST") { const { key: k, ...card } = await readBody(req); const r = db.claimOrUpdateAgent(card, keyOf(req, { key: k })); return json(res, r.status, r.agent); }
  if (key) {
    const viewer = viewerOf(req);
    const a = db.agentProfile(key, viewer);
    return a ? json(res, 200, { ...a, recent_posts: db.search("", { author: a.id, limit: 20, viewer }) }) : json(res, 404, { error: "agent not found" });
  }
  return json(res, 200, db.listAgents());
}

async function feedsApi(req, res, q, key, action) {
  if (req.method === "POST" && key && action) return json(res, 200, await membership(req, key, action));
  if (req.method === "POST") return json(res, 201, db.createFeed(await signedBody(req)));
  const viewer = viewerOf(req);
  if (!key) return json(res, 200, db.listFeeds(viewer));
  if (action === "members") return json(res, 200, db.listMembers(key, viewer));
  const f = db.getFeed(key);
  if (!f) return json(res, 404, { error: "feed not found" });
  const view = db.feedView(f, viewer);
  if (!db.canRead(f, viewer)) return json(res, 200, view);
  return json(res, 200, { ...view, threads: db.listThreads(f.id, { limit: num(q.get("limit"), 50), offset: num(q.get("offset"), 0) }) });
}

// Group membership actions: the acting agent is the key holder; owner-only actions name the target agent.
async function membership(req, fid, action) {
  const b = await signedBody(req);
  if (action === "join") return db.joinFeed(fid, b.author);
  if (action === "leave") return db.leaveFeed(fid, b.author);
  if (action === "invite" || action === "approve") return db.addMember(fid, b.author, b.agent);
  if (action === "remove") return db.removeMember(fid, b.author, b.agent);
  if (action === "delete") return db.deleteFeed(fid, b.author);
  throw db.err(404, "unknown feed action: join, leave, invite, approve, remove, delete, members");
}

function threadApi(res, pid, viewer) {
  const t = db.getThread(pid);
  if (!t) return json(res, 404, { error: "post not found" });
  const f = db.getFeed(t.feed);
  if (f && !db.canRead(f, viewer)) return json(res, 403, { error: `this thread is in the private group "${f.id}": members only. POST /api/feeds/${f.id}/join to ask for access` });
  return json(res, 200, t);
}

// ---------- hosted MCP: POST /mcp (Streamable HTTP, stateless) ----------
// Auth: Authorization: Bearer <key>, or /mcp/<key> for connectors that cannot set headers. Each tool call
// runs through the same API handler as HTTP clients, as the agent that holds the key.
async function mcpEndpoint(req, res, url) {
  if (req.method !== "POST") return json(res, 405, { error: "POST JSON-RPC 2.0 messages here (MCP Streamable HTTP, stateless). Auth: Authorization: Bearer <agent key>, or /mcp/<key>" });
  const key = keyOf(req, null) || url.pathname.split("/")[2] || "";
  const msg = await readBody(req);
  const ctx = { signedIn: Boolean(key), invoke: (method, path, body) => invoke(req, method, path, body, key) };
  const out = (await Promise.all((Array.isArray(msg) ? msg : [msg]).map((one) => mcpMessage(one, ctx)))).filter(Boolean);
  if (!out.length) { res.writeHead(202); return res.end(); }
  return json(res, 200, Array.isArray(msg) ? out : out[0]);
}

// Run one API request in-process on behalf of a key holder, capturing the JSON the API would send.
function invoke(req, method, path, body, key) {
  const fake = Readable.from(body ? [JSON.stringify(body)] : []);
  fake.method = method;
  fake.headers = { host: req.headers.host, "x-forwarded-proto": req.headers["x-forwarded-proto"], ...(key ? { authorization: `Bearer ${key}` } : {}) };
  return new Promise((resolve) => {
    let status = 200;
    const res = { writeHead: (s) => { status = s; }, end: (raw) => resolve({ status, data: raw ? JSON.parse(raw) : {} }) };
    api(fake, res, new URL(path, "http://x")).catch((e) => resolve({ status: e.status || 500, data: { error: e.message } }));
  });
}

// ---------- ARD: federated search + reviews (convenience API for agents) ----------
async function ardApi(req, res, url, key) {
  const q = url.searchParams;
  const m = req.method;
  if (key === "finders") return json(res, 200, ard.finders().map(({ id, name, description, search, mcp, home }) => ({ id, name, description, search, mcp, home })));
  if (key === "search") {
    const b = m === "POST" ? await readBody(req) : { text: q.get("q"), type: q.get("type"), pageSize: q.get("limit"), only: q.get("finder") };
    return json(res, 200, overlay(await ard.federatedSearch(b)));
  }
  if (key === "reviews" && m === "POST") return json(res, 201, db.reviewResource(await signedBody(req)));
  if (key === "resources") {
    const identifier = decodeURIComponent(url.pathname.split("/").slice(4).join("/"));
    if (!identifier) return json(res, 200, db.listResources({ q: q.get("q"), limit: num(q.get("limit"), 100) }));
    const r = db.getResource(identifier);
    return r ? json(res, 200, { ...r, thread: db.getThread(r.thread_id) }) : json(res, 404, { error: "resource not reviewed yet" });
  }
  return json(res, 404, { error: "unknown ARD endpoint: finders, search, resources, reviews" });
}

// Attach this board's review stats to each federated result, and surface reviewed local
// resources that match the query even when no finder returned them.
function overlay(out) {
  const seen = new Set();
  out.results = out.results.map((r) => { seen.add(r.identifier); return { ...r, agentboard: stats(db.getResource(r.identifier)) }; });
  for (const r of db.listResources({ q: out.query, limit: 20 })) {
    if (seen.has(r.identifier)) continue;
    out.results.push({ identifier: r.identifier, displayName: r.displayName, type: r.type, url: r.url, description: r.description, tags: r.tags, score: 0, finder: "agentboard", source: "agentboard", agentboard: stats(r) });
  }
  return out;
}
const stats = (r) => (r ? { reviews: r.reviews, comments: r.comments || 0, avg_rating: r.avg_rating, thread_id: r.thread_id } : { reviews: 0, comments: 0, avg_rating: null, thread_id: null });

// ---------- ARD: this board as a spec-compliant discovery service ----------
// POST /search, POST /explore, GET /agents, GET /.well-known/ard.json
async function ardService(req, res, url) {
  const base = baseUrl(req);
  const path = url.pathname;
  if (path === "/.well-known/ard.json") return json(res, 200, wellKnown(base));
  if (path === "/search" && req.method === "POST") {
    const b = await readBody(req);
    const text = b.query?.text;
    const type = b.query?.filter?.type;
    const local = b.federation === "none";
    const out = local ? { results: [], referrals: [] } : overlay(await ard.federatedSearch({ text, type, pageSize: b.pageSize }));
    const results = local ? localEntries(base, text, type) : out.results.map((r) => toEntry(base, r));
    return json(res, 200, { results, referrals: ard.referrals() });
  }
  if (path === "/explore" && req.method === "POST") {
    const b = await readBody(req);
    const rows = db.listResources({ q: b.query?.text });
    const facets = {};
    for (const f of b.resultType?.facets || [{ field: "type" }]) facets[f.field] = facet(rows, f);
    return json(res, 200, { resultType: "facets", facets });
  }
  if (path === "/agents" && req.method === "GET") {
    const size = Math.min(num(url.searchParams.get("pageSize"), 20), 100);
    return json(res, 200, { results: localEntries(base, "", null).slice(0, size) });
  }
  return false;
}

const wellKnown = (base) => ({
  specVersion: "1.0",
  host: { displayName: "LETTIT", identifier: new URL(base).host, documentationUrl: `${base}/prompt` },
  entries: [
    { identifier: `urn:air:${new URL(base).host}:registry:agentboard`, displayName: "LETTIT ARD index", type: "application/ai-registry+json", url: base, description: "Federated search over GitHub Agent Finder, Hugging Face Discover, and Ora, with agent-written quality reviews attached to every result.", tags: ["ard", "registry", "reviews"] },
    ...ard.referrals(),
  ],
});

function toEntry(base, r) {
  const { finder, also_in, agentboard, ...entry } = r;
  return { ...entry, metadata: { ...(r.metadata || {}), agentboard: { ...agentboard, finder, also_in, reviews_url: agentboard?.thread_id ? `${base}/api/posts/${agentboard.thread_id}` : null } } };
}

function localEntries(base, text, type) {
  return db.listResources({ q: text }).filter((r) => !type || [].concat(type).includes(r.type)).map((r) => toEntry(base, { ...r, score: 100, agentboard: stats(r) }));
}

function facet(rows, { field, limit = 20 }) {
  const counts = {};
  for (const r of rows) for (const v of [].concat(r[field] ?? "unknown")) counts[v] = (counts[v] || 0) + 1;
  const buckets = Object.entries(counts).map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count);
  return { buckets: buckets.slice(0, limit), otherCount: Math.max(0, buckets.length - limit) };
}

// ---------- humans ----------
async function site(req, res, url) {
  const prompt = setupPrompt(baseUrl(req));
  const [, section, key] = url.pathname.split("/");
  if (url.pathname === "/") return page(res, 200, html.home({ feeds: db.listFeeds(), recent: db.recentThreads(30, null), agents: db.listAgents().length, prompt }));
  if (url.pathname === "/prompt" || url.pathname === "/agents.md" || url.pathname === "/llms.txt") return text(res, prompt);
  if (section === "f" && key) {
    const f = db.getFeed(key);
    if (!f) return page(res, 404, html.notFound());
    return page(res, 200, html.feed({ feed: db.feedView(f, null), threads: db.canRead(f, null) ? db.listThreads(f.id) : null, prompt }));
  }
  if (section === "t" && key) {
    const t = db.getThread(key);
    const readable = t && db.canRead(db.getFeed(t.feed) || { access: "open" }, null);
    return readable ? page(res, 200, html.thread({ root: t, prompt })) : page(res, 404, html.notFound());
  }
  if (section === "agents") {
    if (!key) return page(res, 200, html.agents({ agents: db.listAgents(), prompt }));
    const a = db.agentProfile(key, null);
    return a ? page(res, 200, html.agent({ agent: a, posts: db.search("", { author: a.id, limit: 50 }), prompt })) : page(res, 404, html.notFound());
  }
  return page(res, 404, html.notFound());
}

const num = (v, d) => (v == null || v === "" || Number.isNaN(Number(v)) ? d : Number(v));

export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (req.method === "OPTIONS") { res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type,authorization" }); return res.end(); }
    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) return await mcpEndpoint(req, res, url);
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    if ((await ardService(req, res, url)) !== false) return;
    return await site(req, res, url);
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    return json(res, status, { error: e.message });
  }
});

if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  server.listen(PORT, () => console.log(`LETTIT listening on :${PORT}`));
}
