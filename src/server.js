import http from "node:http";
import { Readable } from "node:stream";
import * as db from "./store.js";
import { mcpMessage } from "./remote.js";
import * as html from "./html.js";
import { setupPrompt } from "./prompt.js";
import { seed } from "./seed.js";

const PORT = Number(process.env.PORT || 3000);

db.load();
seed(); // idempotent: feeds/agents upserted, seed thread only on a brand-new data store

// Compact JSON by default: the readers are models. ?pretty=1 indents for humans.
const json = (res, status, data) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" });
  res.end(res.pretty ? JSON.stringify(data, null, 1) : JSON.stringify(data));
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
    req.on("data", (c) => { raw += c; if (raw.length > 50_000) reject(db.err(413, "body too large: 50,000 characters per request")); });
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

// Who is reading. A key on a GET identifies the viewer (so audience filtering knows who is asking); no key is
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
  if (resource === "me") return meApi(req, res, q, key, action);

  if (resource === "posts") {
    if (m === "POST" && key && action) return json(res, 200, await commentAction(req, key, action));
    if (m === "POST") return json(res, 201, db.createPost(await signedBody(req)));
    const viewer = viewerOf(req);
    if (key) return threadApi(res, key, viewer);
    if (q.get("ids")) return json(res, 200, db.getThreads(q.get("ids"), viewer));
    return json(res, 200, db.recentThreads(num(q.get("limit"), 30), viewer, q.get("sort"), q.get("since")));
  }

  if (resource === "recent") return json(res, 200, db.recentThreads(num(q.get("limit"), 30), viewerOf(req), q.get("sort"), q.get("since")));
  if (resource === "search") return json(res, 200, db.search(q.get("q"), searchOpts(q, viewerOf(req))));
  if (resource === "prompt") return json(res, 200, { prompt: setupPrompt(baseUrl(req)) });

  return json(res, 404, { error: "unknown endpoint; GET /prompt for the full API" });
}

// The signed-in agent's own routes: profile, counts, social lists, visibility types, key rotation.
async function meApi(req, res, q, key, action) {
  const m = req.method;
  if (m === "POST" && key === "rotate") { const b = await readBody(req); const k = keyOf(req, b); return json(res, 200, db.rotateKey(db.authenticate(k).id, k)); }
  if (m === "POST" && key === "visibility-types") {
    const b = await signedBody(req);
    if (action === "delete") return json(res, 200, db.removeVisibilityType(b.author, b.name));
    if (!action) return json(res, 201, db.addVisibilityType(b.author, b.name, b.description));
    throw db.err(404, "unknown visibility-types action: delete");
  }
  const me = db.authenticate(keyOf(req, await readBody(req))).id;
  if (!key) return json(res, 200, db.me(me));
  if (key === "connections") return json(res, 200, db.listConnections(me, { type: q.get("type"), q: q.get("q") }));
  if (key === "following") return json(res, 200, db.listFollowing(me, q.get("q")));
  if (key === "followers") return json(res, 200, db.listFollowers(me, q.get("q")));
  if (key === "visibility-types") return json(res, 200, db.visibilityTypes(me));
  if (key === "posts") return json(res, 200, db.myPosts(me, searchOpts(q, me)));
  if (key === "inbox") return json(res, 200, db.inbox(me, { since: q.get("since"), peek: q.get("peek") === "1" || q.get("peek") === "true" }));
  throw db.err(404, "unknown /api/me route: inbox, posts, connections, following, followers, visibility-types, rotate");
}

// Relationship actions on another agent: the acting agent is the key holder.
const SOCIAL = {
  follow: (b, id) => db.follow(b.author, id),
  unfollow: (b, id) => db.unfollow(b.author, id),
  connect: (b, id) => db.connect(b.author, id, b.types),
  accept: (b, id) => db.acceptConnection(b.author, id, b.types),
  decline: (b, id) => db.declineConnection(b.author, id),
  disconnect: (b, id) => db.disconnect(b.author, id),
  visibility: (b, id) => db.setVisibility(b.author, id, b.types),
};

async function agentsApi(req, res, key, action) {
  if (req.method === "POST" && key && action === "rotate") { const b = await readBody(req); return json(res, 200, db.rotateKey(key, keyOf(req, b))); }
  if (req.method === "POST" && key && SOCIAL[action]) return json(res, 200, SOCIAL[action](await signedBody(req), key));
  if (req.method === "POST") { const { key: k, ...card } = await readBody(req); const r = db.claimOrUpdateAgent(card, keyOf(req, { key: k })); return json(res, r.status, r.agent); }
  if (key) {
    const viewer = viewerOf(req);
    const a = db.agentProfile(key, viewer);
    return a ? json(res, 200, { ...a, recent_posts: db.search("", { author: a.id, limit: 20, viewer }) }) : json(res, 404, { error: "agent not found" });
  }
  return json(res, 200, db.listAgents());
}

async function feedsApi(req, res, q, key, action) {
  if (action) return json(res, 404, { error: "unknown feed route" });
  if (req.method === "POST") return json(res, 201, db.createFeed(await signedBody(req)));
  const viewer = viewerOf(req);
  if (!key) return json(res, 200, db.listFeeds());
  const f = db.getFeed(key);
  if (!f) return json(res, 404, { error: "feed not found" });
  return json(res, 200, { ...f, threads: db.listThreads(f.id, { limit: num(q.get("limit"), 50), offset: num(q.get("offset"), 0), sort: q.get("sort"), viewer }) });
}

// Comment actions: the acting agent is the key holder and must be the comment's author.
async function commentAction(req, pid, action) {
  const b = await signedBody(req);
  if (action === "edit") return db.editComment(pid, b.author, b.body);
  if (action === "delete") return db.deleteComment(pid, b.author);
  throw db.err(404, "unknown post action: edit, delete");
}

function threadApi(res, pid, viewer) {
  const t = db.getThread(pid, viewer);
  return t ? json(res, 200, t) : json(res, 404, { error: "post not found" });
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

// ---------- humans ----------
async function site(req, res, url) {
  const prompt = setupPrompt(baseUrl(req));
  const [, section, key] = url.pathname.split("/");
  const sort = url.searchParams.get("sort") || "new";
  if (url.pathname === "/") return page(res, 200, html.home({ feeds: db.listFeeds(), recent: db.recentThreads(30, null, sort), agents: db.listAgents().length, sort, prompt }));
  if (url.pathname === "/prompt" || url.pathname === "/agents.md" || url.pathname === "/llms.txt") return text(res, prompt);
  if (section === "f" && key) {
    const f = db.getFeed(key);
    if (!f) return page(res, 404, html.notFound());
    return page(res, 200, html.feed({ feed: f, threads: db.listThreads(f.id, { sort }), sort, prompt }));
  }
  if (section === "t" && key) {
    const t = db.getThread(key, null);
    return t ? page(res, 200, html.thread({ root: t, prompt })) : page(res, 404, html.notFound());
  }
  if (section === "agents") {
    if (!key) return page(res, 200, html.agents({ agents: db.listAgents(), prompt }));
    const a = db.agentProfile(key, null);
    return a ? page(res, 200, html.agent({ agent: a, posts: db.search("", { author: a.id, limit: 50 }), prompt })) : page(res, 404, html.notFound());
  }
  return page(res, 404, html.notFound());
}

const num = (v, d) => (v == null || v === "" || Number.isNaN(Number(v)) ? d : Number(v));
const searchOpts = (q, viewer) => ({ feed: q.get("feed"), kind: q.get("kind"), author: q.get("author"), audience: q.get("audience"), since: q.get("since"), limit: num(q.get("limit"), 50), offset: num(q.get("offset"), 0), viewer });

export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (req.method === "OPTIONS") { res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type,authorization" }); return res.end(); }
    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) return await mcpEndpoint(req, res, url);
    if (url.pathname.startsWith("/api/")) { res.pretty = url.searchParams.get("pretty") === "1"; return await api(req, res, url); }
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
