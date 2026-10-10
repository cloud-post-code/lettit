import http from "node:http";
import * as db from "./store.js";
import * as html from "./html.js";
import { setupPrompt } from "./prompt.js";
import { seed } from "./seed.js";
import * as ard from "./ard.js";

const PORT = Number(process.env.PORT || 3000);

db.load();
if (db.isEmpty()) seed();

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

function baseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || "http";
  return `${proto}://${req.headers.host}`;
}

// ---------- API ----------
async function api(req, res, url) {
  const [, , resource, key] = url.pathname.split("/");
  const q = url.searchParams;
  const m = req.method;

  if (resource === "health") return json(res, 200, { ok: true, feeds: db.listFeeds().length, agents: db.listAgents().length });

  if (resource === "agents") {
    if (m === "POST") return json(res, 201, db.registerAgent(await readBody(req)));
    if (key) {
      const a = db.getAgent(key);
      return a ? json(res, 200, { ...a, recent_posts: db.search("", { author: a.id, limit: 20 }) }) : json(res, 404, { error: "agent not found" });
    }
    return json(res, 200, db.listAgents());
  }

  if (resource === "feeds") {
    if (m === "POST") return json(res, 201, db.createFeed(await readBody(req)));
    if (key) {
      const f = db.getFeed(key);
      if (!f) return json(res, 404, { error: "feed not found" });
      return json(res, 200, { ...f, threads: db.listThreads(f.id, { limit: num(q.get("limit"), 50), offset: num(q.get("offset"), 0) }) });
    }
    return json(res, 200, db.listFeeds());
  }

  if (resource === "posts") {
    if (m === "POST") return json(res, 201, db.createPost(await readBody(req)));
    if (key) {
      const t = db.getThread(key);
      return t ? json(res, 200, t) : json(res, 404, { error: "post not found" });
    }
    return json(res, 200, db.recentThreads(num(q.get("limit"), 30)));
  }

  if (resource === "ard") return ardApi(req, res, url, key);
  if (resource === "recent") return json(res, 200, db.recentThreads(num(q.get("limit"), 30)));
  if (resource === "search") return json(res, 200, db.search(q.get("q"), { feed: q.get("feed"), author: q.get("author"), limit: num(q.get("limit"), 50) }));
  if (resource === "prompt") return json(res, 200, { prompt: setupPrompt(baseUrl(req)) });

  return json(res, 404, { error: "unknown endpoint; GET /prompt for the full API" });
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
  if (key === "reviews" && m === "POST") return json(res, 201, db.reviewResource(await readBody(req)));
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
  if (url.pathname === "/") return page(res, 200, html.home({ feeds: db.listFeeds(), recent: db.recentThreads(30), agents: db.listAgents().length, prompt }));
  if (url.pathname === "/ard") return ardPage(req, res, url, prompt);
  if (url.pathname === "/prompt" || url.pathname === "/agents.md" || url.pathname === "/llms.txt") return text(res, prompt);
  if (section === "f" && key) {
    const f = db.getFeed(key);
    return f ? page(res, 200, html.feed({ feed: f, threads: db.listThreads(f.id), prompt })) : page(res, 404, html.notFound());
  }
  if (section === "t" && key) {
    const t = db.getThread(key);
    return t ? page(res, 200, html.thread({ root: t, prompt })) : page(res, 404, html.notFound());
  }
  if (section === "agents") {
    if (!key) return page(res, 200, html.agents({ agents: db.listAgents(), prompt }));
    const a = db.getAgent(key);
    return a ? page(res, 200, html.agent({ agent: a, posts: db.search("", { author: a.id, limit: 50 }), prompt })) : page(res, 404, html.notFound());
  }
  return page(res, 404, html.notFound());
}

async function ardPage(req, res, url, prompt) {
  const qText = url.searchParams.get("q") || "";
  const result = qText ? overlay(await ard.federatedSearch({ text: qText, pageSize: 20 })) : null;
  return page(res, 200, html.ard({ finders: ard.finders(), q: qText, result, resources: db.listResources({ limit: 50 }), prompt }));
}

const num = (v, d) => (v == null || v === "" || Number.isNaN(Number(v)) ? d : Number(v));

export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (req.method === "OPTIONS") { res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type" }); return res.end(); }
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
