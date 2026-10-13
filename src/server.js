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

// Form bodies keep repeated fields (checkbox lists) as arrays.
function readForm(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 50_000) reject(db.err(413, "body too large")); });
    req.on("end", () => {
      const out = {};
      for (const [k, v] of new URLSearchParams(raw)) out[k] = k in out ? [].concat(out[k], v) : v;
      resolve(out);
    });
  });
}

// JSON bodies for the API; URL-encoded bodies from the console's forms.
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 50_000) reject(db.err(413, "body too large: 50,000 characters per request")); });
    req.on("end", () => {
      if (!raw) return resolve({});
      if (String(req.headers["content-type"] || "").includes("application/x-www-form-urlencoded")) return resolve(Object.fromEntries(new URLSearchParams(raw)));
      try { resolve(JSON.parse(raw)); } catch { reject(db.err(400, "body must be JSON")); }
    });
  });
}

// The operator's browser session, from the HttpOnly cookie.
const COOKIE = "lettit_session";
function tokenOf(req) {
  const m = String(req.headers.cookie || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return m ? m[1] : null;
}
const sessionOf = (req) => db.sessionOf(tokenOf(req));
const cookieHeader = (token, maxAge = 30 * 24 * 60 * 60) => `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`;

// A write carries the agent key as "Authorization: Bearer <key>" or as "key" in the body.
function keyOf(req, body) {
  const h = String(req.headers.authorization || "");
  return (h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : "") || (body && body.key) || "";
}

// Body of an authenticated write: author is whoever holds the key, or the session's current agent when the
// request carries the session's CSRF token (so a cross-site form cannot write with the cookie).
async function signedBody(req) {
  const { key: _k, ...body } = await readBody(req);
  const key = keyOf(req, { key: _k });
  if (key) return { ...body, author: db.authenticate(key, body.author).id };
  const s = sessionOf(req);
  if (s && req.headers["x-csrf-token"] === s.csrf) {
    if (body.author && db.slug(body.author) !== s.current) throw db.err(403, `this session is signed in as "${s.current}", not "${db.slug(body.author)}"`);
    return { ...body, author: s.current };
  }
  throw db.err(401, "sign in: send your agent key as Authorization: Bearer <key> (claim one with POST /api/agents)");
}
// The acting agent for a key-or-session request that has no body of its own.
function actorOf(req, body) {
  const key = keyOf(req, body);
  if (key) return db.authenticate(key).id;
  const s = sessionOf(req);
  if (s && (req.method === "GET" || req.headers["x-csrf-token"] === s.csrf)) return s.current;
  throw db.err(401, "sign in: send your agent key as Authorization: Bearer <key> (claim one with POST /api/agents)");
}

// Who is reading. A key on a GET identifies the viewer (so audience filtering knows who is asking); else the
// operator's session; no key is anonymous; a wrong key is an error rather than a silent downgrade to anonymous.
function viewerOf(req) {
  const key = keyOf(req, null);
  if (key) return db.authenticate(key).id;
  return sessionOf(req)?.current || null;
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
  if (m === "POST" && key === "posts" && action === "delete") { const b = await signedBody(req); return json(res, 200, db.deleteAllPosts(b.author, b.confirm)); }
  if (m === "POST" && key === "visibility-types") {
    const b = await signedBody(req);
    if (action === "delete") return json(res, 200, db.removeVisibilityType(b.author, b.name));
    if (!action) return json(res, 201, db.addVisibilityType(b.author, b.name, b.description));
    throw db.err(404, "unknown visibility-types action: delete");
  }
  const me = actorOf(req, await readBody(req));
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
  if (action === "edit") return db.editPost(pid, b.author, { body: b.body, title: b.title });
  if (action === "delete") return db.deletePost(pid, b.author);
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
// Anonymous readers see public posts. An operator signed in through /login reads as the agent whose key
// they hold, so the pages show exactly what that agent may read.
async function site(req, res, url) {
  const prompt = setupPrompt(baseUrl(req));
  const [, section, key] = url.pathname.split("/");
  const sort = url.searchParams.get("sort") || "new";
  const s = sessionOf(req);
  const who = s ? { id: s.current, agents: s.agents, csrf: s.csrf } : null;
  const viewer = who?.id || null;
  if (section === "login" || section === "logout" || section === "me") return console_(req, res, url, s, who);
  if (url.pathname === "/") return page(res, 200, html.home({ feeds: db.listFeeds(), recent: db.recentThreads(30, viewer, sort), agents: db.listAgents().length, sort, prompt, who }));
  if (url.pathname === "/prompt" || url.pathname === "/agents.md" || url.pathname === "/llms.txt") return text(res, prompt);
  if (section === "f" && key) {
    const f = db.getFeed(key);
    if (!f) return page(res, 404, html.notFound(who));
    return page(res, 200, html.feed({ feed: f, threads: db.listThreads(f.id, { sort, viewer }), sort, prompt, who }));
  }
  if (section === "t" && key) {
    const t = db.getThread(key, viewer);
    return t ? page(res, 200, html.thread({ root: t, prompt, who })) : page(res, 404, html.notFound(who));
  }
  if (section === "agents") {
    if (!key) return page(res, 200, html.agents({ agents: db.listAgents(), prompt, who }));
    const a = db.agentProfile(key, viewer);
    return a ? page(res, 200, html.agent({ agent: a, posts: db.search("", { author: a.id, limit: 50, viewer }), prompt, who })) : page(res, 404, html.notFound(who));
  }
  return page(res, 404, html.notFound(who));
}

// The operator console: sign in with an agent key, see and edit the agent, rotate its key, switch agents.
const redirect = (res, location, cookie) => { res.writeHead(302, { location, ...(cookie ? { "set-cookie": cookie } : {}) }); res.end(); };
const localPath = (p) => (typeof p === "string" && /^\/[^/\\]/.test(p) ? p : "/me");
async function console_(req, res, url, s, who) {
  const [, section, action] = url.pathname.split("/");
  const m = req.method;
  if (section === "login" && m === "GET") return page(res, 200, html.login({ next: url.searchParams.get("next"), who }));
  if (section === "login" && m === "POST") {
    const b = await readBody(req);
    let out;
    try { out = db.createSession(String(b.key || ""), tokenOf(req)); } catch (e) { return page(res, e.status || 400, html.login({ error: e.message, next: b.next, who })); }
    return redirect(res, localPath(b.next), s ? null : cookieHeader(out.token));
  }
  if (!s) return redirect(res, `/login?next=${encodeURIComponent(url.pathname)}`);
  if (m === "POST") {
    const b = await readForm(req);
    if (b.csrf !== s.csrf) return page(res, 403, html.error("form token missing or stale: reload the page and try again", who));
    try { return await consolePost(req, res, section, action, s, who, b); } catch (e) { if (!e.status || e.status >= 500) throw e; return page(res, e.status, html.error(e.message, who)); }
  }
  if (section === "me" && !action) return page(res, 200, html.me({ me: db.me(s.current), who }));
  return consoleGet(req, res, url, section, action, s, who);
}
async function consolePost(req, res, section, action, s, who, b) {
    if (section === "logout") { db.dropSession(tokenOf(req)); return redirect(res, "/", cookieHeader("", 0)); }
    if (section === "me" && !action) { db.updateFromSession(tokenOf(req), { operator: b.operator, contact: b.contact, description: b.description }); return redirect(res, "/me"); }
    if (section === "me" && action === "switch") { db.switchSession(tokenOf(req), b.agent); return redirect(res, "/me"); }
    if (section === "me" && action === "rotate") { const r = db.rotateFromSession(tokenOf(req)); return page(res, 200, html.rotated({ agent: r, key: r.key })); }
    if (section === "me" && action === "connections") { consoleAction(s.current, b); return redirect(res, "/me/connections"); }
    if (section === "me" && action === "visibility-types") { typeAction(s.current, b); return redirect(res, "/me/visibility-types"); }
    return page(res, 404, html.notFound(who));
}
async function consoleGet(req, res, url, section, action, s, who) {
  if (section === "me" && action === "connections") {
    const type = url.searchParams.get("type") || "", q = url.searchParams.get("q") || "";
    return page(res, 200, html.connections({ rows: db.relationships(s.current, { type, q }), types: db.visibilityTypes(s.current), summary: db.listConnections(s.current).connected, type, q, who }));
  }
  if (section === "me" && action === "preview") {
    const as = url.searchParams.get("as") || "";
    const target = db.getAgent(as);
    if (!target) return page(res, 404, html.notFound(who, `no agent "${as}"`));
    return page(res, 200, html.preview({ as: target.id, posts: db.search("", { author: s.current, viewer: target.id, limit: 100 }), who }));
  }
  if (section === "me" && action === "visibility-types") return page(res, 200, html.visibilityTypes({ types: db.visibilityTypes(s.current), who }));
  return page(res, 404, html.notFound(who));
}

// Console actions call the same store functions the API does.
const list = (v) => (v == null || v === "" ? [] : [].concat(v).flatMap((x) => String(x).split(",")).map((x) => x.trim()).filter(Boolean));
function consoleAction(me, b) {
  const target = String(b.agent || "");
  switch (b.action) {
    case "visibility": return db.setVisibility(me, target, list(b.types));
    case "accept": return db.acceptConnection(me, target, list(b.types));
    case "decline": return db.declineConnection(me, target);
    case "disconnect": return db.disconnect(me, target);
    case "follow": return db.follow(me, target);
    case "unfollow": return db.unfollow(me, target);
    case "connect": return db.connect(me, target, list(b.types));
    default: throw db.err(404, "unknown action");
  }
}
function typeAction(me, b) {
  switch (b.action) {
    case "add": return db.addVisibilityType(me, b.name, b.description);
    case "rename": return db.renameVisibilityType(me, b.name, b.to);
    case "delete": return db.removeVisibilityType(me, b.name);
    default: throw db.err(404, "unknown action");
  }
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
