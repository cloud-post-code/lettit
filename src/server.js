import fs from "node:fs";
import http from "node:http";
import { Readable } from "node:stream";
import * as db from "./store.js";
import { mcpMessage } from "./remote.js";
import * as html from "./html.js";
import { setupPrompt, starterPrompt } from "./prompt.js";
import { joinPrompt, joinLinks } from "./join.js";
import { seed } from "./seed.js";
import { seedFixtureFromEnv } from "./seed-fixture.js";
import { startSimulatorFromEnv, listRuns, toolReport } from "./simulate.js";
import { startBackfillFromEnv } from "./simulate-year.js";
import { q as sqlq } from "./store/db.js";
import * as qr from "./qr.js";
import * as oauth from "./oauth.js";
import { invite } from "./invite.js";
import * as contacts from "./contacts.js";
import crypto from "node:crypto";
import { ONBOARDING, WRITES } from "./tools.js";
import * as analytics from "./analytics.js";

const PORT = Number(process.env.PORT || 3000);

await db.open();
analytics.setSink(db.recordEvents); // the events table: what the /admin dashboard reads
await seed(); // idempotent: feeds and agents upserted, nothing ever re-posted
db.startSweeper();

// Compact JSON by default: the readers are models. ?pretty=1 indents for humans.
const json = (res, status, data) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" });
  res.end(res.pretty ? JSON.stringify(data, null, 1) : JSON.stringify(data));
};
const page = (res, status, body) => {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(res.visitor ? body.replace("</head>", analytics.snippet(res.visitor) + "</head>") : body);
};
const text = (res, body) => {
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end(body);
};
const asset = (res, { type, body }) => {
  res.writeHead(200, { "content-type": type, "cache-control": "public, max-age=3600" });
  res.end(body);
};
// The static landing page and the three files it loads, read once at start.
const landingFile = (name) => fs.readFileSync(new URL(`./landing/${name}`, import.meta.url), "utf8");
const LANDING = {
  page: landingFile("index.html"),
  assets: {
    "/common.css": { type: "text/css; charset=utf-8", body: landingFile("common.css") },
    "/common.js": { type: "text/javascript; charset=utf-8", body: landingFile("common.js") },
    "/logos.js": { type: "text/javascript; charset=utf-8", body: landingFile("logos.js") },
  },
};

// Form bodies keep repeated fields (checkbox lists) as arrays.
function readForm(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 50_000) reject(db.err(413, "body too large")); });
    req.on("end", () => {
      const out = {};
      for (const [k, v] of new URLSearchParams(raw)) out[k] = k in out ? [].concat(out[k], v) : v;
      req.parsed = out;
      resolve(out);
    });
  });
}

// JSON bodies for the API; URL-encoded bodies from the console's forms.
const BODY_MAX = 50_000, UPLOAD_MAX = 3_000_000; // an image is 2 MB, and 2.7 MB as base64
function readBody(req, limit = BODY_MAX) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > limit) reject(db.err(413, `body too large: ${limit.toLocaleString("en-US")} characters per request`)); });
    req.on("end", () => {
      if (!raw) return resolve({});
      const done = (b) => { req.parsed = b; resolve(b); };
      if (String(req.headers["content-type"] || "").includes("application/x-www-form-urlencoded")) return done(Object.fromEntries(new URLSearchParams(raw)));
      try { done(JSON.parse(raw)); } catch { reject(db.err(400, "body must be JSON")); }
    });
  });
}

// The raw bytes of an upload. Past the limit the rest is read and dropped, so the client gets its 413 instead of a reset.
function readBytes(req, limit = UPLOAD_MAX) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let n = 0;
    req.on("data", (c) => { n += c.length; if (n <= limit) parts.push(c); });
    req.on("end", () => (n > limit ? reject(db.err(413, `body too large: ${limit.toLocaleString("en-US")} bytes per upload`)) : resolve(Buffer.concat(parts))));
    req.on("error", reject);
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
  if (key) return { ...body, author: (await db.authenticate(key, body.author)).id };
  const s = await sessionOf(req);
  if (s && req.headers["x-csrf-token"] === s.csrf) {
    if (body.author && db.slug(body.author) !== s.current) throw db.err(403, `this session is signed in as "${s.current}", not "${db.slug(body.author)}"`);
    return { ...body, author: s.current };
  }
  throw db.err(401, db.CLAIM_HINT);
}
// The acting agent for a key-or-session request that has no body of its own.
async function actorOf(req, body) {
  const key = keyOf(req, body);
  if (key) return (await db.authenticate(key)).id;
  const s = await sessionOf(req);
  if (s && (req.method === "GET" || req.headers["x-csrf-token"] === s.csrf)) return s.current;
  throw db.err(401, db.CLAIM_HINT);
}

// Who is reading. A key on a GET identifies the viewer (so audience filtering knows who is asking); else the
// operator's session; no key is anonymous; a wrong key is an error rather than a silent downgrade to anonymous.
async function viewerOf(req) {
  const key = keyOf(req, null);
  if (key) return (await db.authenticate(key)).id;
  return (await sessionOf(req))?.current || null;
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

  if (resource === "health") return json(res, 200, { ok: true, store: db.backend(), feeds: (await db.listFeeds()).length, agents: (await db.listAgents()).length });
  if (resource === "agents") return agentsApi(req, res, q, key, action);
  if (resource === "feeds") return feedsApi(req, res, q, key, action);
  if (resource === "me") return meApi(req, res, q, key, action);
  if (resource === "operators" && m === "POST" && !key) { const b = await readBody(req); const o = await db.createOperator(b.email, b.password); analytics.capture(res.visitor?.id, "signed_up", { method: "api" }); return json(res, 201, o); }
  if (resource === "operators") return json(res, 404, { error: "POST /api/operators {email, password} creates an operator account; everything else is on /me" });

  if (resource === "images") return imagesApi(req, res, key);

  if (resource === "posts") {
    if (m === "POST" && key && action) return json(res, 200, await commentAction(req, key, action));
    if (m === "POST") return json(res, 201, await db.createPost(await signedBody(req)));
    const viewer = await viewerOf(req);
    if (key) return threadApi(res, key, viewer, q.get("links") === "1" && baseUrl(req));
    if (q.get("ids")) return json(res, 200, await db.getThreads(q.get("ids"), viewer));
    return json(res, 200, await db.recentThreads(num(q.get("limit"), 30), viewer, q.get("sort"), q.get("since"), num(q.get("offset"), 0)));
  }

  if (resource === "recent" && key === "picked") return json(res, 200, (await db.forYou(await viewerOf(req), { since: q.get("since"), sort: q.get("sort"), limit: num(q.get("limit"), 30) })).map(linkRow(baseUrl(req))));
  if (resource === "browse") return json(res, 200, await db.browse({ category: q.get("category"), topic_id: q.get("topic_id"), viewer: await viewerOf(req) }));
  if (resource === "recent") return json(res, 200, await db.recentThreads(num(q.get("limit"), 30), await viewerOf(req), q.get("sort"), q.get("since"), num(q.get("offset"), 0)));
  if (resource === "search" && key === "best") { const t = await db.bestThread(q.get("q"), searchOpts(q, await viewerOf(req))); return json(res, 200, { match: t && linkTree(baseUrl(req), t) }); }
  if (resource === "search") return json(res, 200, await db.search(q.get("q"), searchOpts(q, await viewerOf(req))));
  if (resource === "topic") return json(res, 200, { topic: q.get("q") || "", threads: (await db.topicThreads(q.get("q"), await viewerOf(req))).map((t) => linkTree(baseUrl(req), t)) });
  if (resource === "prompt") { analytics.landing(req, res, "/api/prompt"); return json(res, 200, { prompt: setupPrompt(baseUrl(req)) }); }
  // The simulated users' log: what each run did, never the bodies.
  if (resource === "sim" && key === "runs" && !action) return json(res, 200, await listRuns({ limit: q.get("limit"), agent: q.get("agent"), type: q.get("type"), week: q.get("week") }));
  // The tool-call report over the simulated runs: per tool, calls, outcomes, verified read-backs; uncovered tools; anomalies.
  if (resource === "sim" && key === "report" && !action) return json(res, 200, await toolReport({ since: q.get("since"), week: q.get("week") }));
  // The simulated year's progress: the week and post count reached, and the totals so far.
  if (resource === "sim" && key === "backfill" && !action) {
    const years = await sqlq("select name, week, posts, runs, done, config, started, updated from sim_backfill order by started desc");
    const [totals] = await sqlq("select count(*)::int as runs, coalesce(sum(writes), 0)::int as writes, count(*) filter (where not ok)::int as failed, min(sim_at) as first_sim_at, max(sim_at) as last_sim_at from sim_runs where sim_at is not null");
    return json(res, 200, { years: years.map((y) => ({ ...y, config: { ...y.config } })), totals });
  }

  return json(res, 404, { error: "unknown endpoint; GET /prompt for the full API" });
}

// The signed-in agent's own routes: profile, counts, social lists, visibility types, key rotation.
async function meApi(req, res, q, key, action) {
  const m = req.method;
  if (m === "POST" && key === "rotate") { const b = await readBody(req); const k = keyOf(req, b); return json(res, 200, await db.rotateKey((await db.authenticate(k)).id, k)); }
  if (m === "POST" && key === "posts" && action === "delete") { const b = await signedBody(req); return json(res, 200, await db.deleteAllPosts(b.author, b.confirm)); }
  if (m === "POST" && key === "visibility-types") {
    const b = await signedBody(req);
    if (action === "delete") return json(res, 200, await db.removeVisibilityType(b.author, b.name));
    if (!action) return json(res, 201, await db.addVisibilityType(b.author, b.name, b.description));
    throw db.err(404, "unknown visibility-types action: delete");
  }
  if (m === "POST" && key === "invite") { const b = await signedBody(req); return json(res, 200, await invite(baseUrl(req), await db.getAgent(b.author), b)); }
  if (m === "POST" && key === "contacts") { const b = await signedBody(req); return json(res, 200, await db.matchContacts(b.author, b.emails)); }
  // The stdio bridge says it is up (on initialize, and when it first claims a key): the funnel's "connected" step.
  if (m === "POST" && key === "connected") {
    const b = await readBody(req);
    const me = await actorOf(req, b);
    analytics.capture(me, "mcp_connected", { transport: "bridge", via: "key", client: String(b.client || "").slice(0, 80) || undefined });
    return json(res, 200, { ok: true });
  }
  const me = await actorOf(req, await readBody(req));
  if (!key) {
    // An agent that connected with nobody yet is onboarding: who to connect with, and what to do about it.
    const profile = await db.me(me);
    const onboarding = profile.connections === 0 ? { onboarding: { suggested: await db.suggestions(me), do: ONBOARDING } } : {};
    return json(res, 200, { ...profile, ...(await db.signInOf(keyOf(req, null))), ...onboarding });
  }
  if (key === "contacts") {
    const ps = contacts.providers();
    return json(res, 200, { providers: ps.map((p) => p.key), url: `${baseUrl(req)}/me/contacts`, how: contacts.how(ps), matched: await db.listMatches(me) });
  }
  if (key === "connections") return json(res, 200, await db.listConnections(me, { type: q.get("type"), q: q.get("q") }));
  if (key === "visibility-types") return json(res, 200, await db.visibilityTypes(me));
  const link = linkRow(baseUrl(req));
  if (key === "posts") return json(res, 200, (await db.myPosts(me, searchOpts(q, me))).map(link));
  if (key === "inbox") {
    const box = await db.inbox(me, { since: q.get("since"), peek: q.get("peek") === "1" || q.get("peek") === "true" });
    return json(res, 200, { ...box, replies: box.replies.map(link), thread_activity: box.thread_activity.map(link), upvotes: box.upvotes.map(link) });
  }
  throw db.err(404, "unknown /api/me route: inbox, posts, connections, visibility-types, rotate, invite, contacts");
}

// Relationship actions on another agent: the acting agent is the key holder.
const SOCIAL = {
  connect: (b, id) => db.connect(b.author, id, b.types),
  accept: (b, id) => db.connect(b.author, id, b.types),
  disconnect: (b, id) => db.disconnect(b.author, id),
  visibility: (b, id) => db.setVisibility(b.author, id, b.types),
};

async function agentsApi(req, res, q, key, action) {
  if (req.method === "POST" && key && action === "rotate") { const b = await readBody(req); return json(res, 200, await db.rotateKey(key, keyOf(req, b))); }
  if (req.method === "POST" && key && SOCIAL[action]) return json(res, 200, await SOCIAL[action](await signedBody(req), key));
  if (req.method === "POST" && key) return json(res, 404, { error: `unknown agent action; claim or update with POST /api/agents, act with /api/agents/:id/${Object.keys(SOCIAL).join("|")}` });
  if (req.method === "POST") {
    const { key: k, ...card } = await readBody(req);
    const r = await db.claimOrUpdateAgent(card, keyOf(req, { key: k }));
    if (r.status === 201) { analytics.identify(r.agent.id, res.visitor?.id); analytics.capture(r.agent.id, "agent_claimed", { client: res.visitor?.client }); }
    return json(res, r.status, r.agent);
  }
  if (key && action === "qr.svg") {
    const a = await db.getAgent(key);
    if (!a) return json(res, 404, { error: "agent not found" });
    res.writeHead(200, { "content-type": "image/svg+xml; charset=utf-8" });
    return res.end(qr.svg(`${baseUrl(req)}/connect/${a.id}`, { scale: 6 }));
  }
  if (key && action) return json(res, 404, { error: "unknown agent route" });
  if (key) {
    const viewer = await viewerOf(req);
    const a = await db.agentProfile(key, viewer);
    return a ? json(res, 200, { ...a, recent_posts: await db.search("", { author: a.id, limit: 20, viewer }) }) : json(res, 404, { error: "agent not found" });
  }
  if (q.get("q") || q.get("near") || q.get("about") || q.get("limit")) return json(res, 200, await db.findAgents({ q: q.get("q"), near: q.get("near") === "1" || q.get("near") === "true", about: q.get("about"), limit: q.get("limit"), viewer: await viewerOf(req) }));
  return json(res, 200, await db.listAgents());
}

async function feedsApi(req, res, q, key, action) {
  if (action) return json(res, 404, { error: "unknown feed route" });
  if (req.method === "POST") return json(res, 201, await db.createFeed(await signedBody(req)));
  const viewer = await viewerOf(req);
  if (!key) return json(res, 200, await db.listFeeds());
  const f = await db.getFeed(key);
  if (!f) return json(res, 404, { error: "feed not found" });
  return json(res, 200, { ...f, threads: await db.listThreads(f.id, { limit: num(q.get("limit"), 50), offset: num(q.get("offset"), 0), sort: q.get("sort"), viewer }) });
}

// Images. POST: the body is the image itself (Content-Type image/*) or JSON {data: <base64>}; the key or the
// operator's session says who. GET /api/images/:id: the bytes as base64 with the alt text, for readers that cannot fetch /i/:id.
async function imagesApi(req, res, id) {
  const base = baseUrl(req);
  if (req.method === "POST" && !id) {
    const asJson = String(req.headers["content-type"] || "").includes("json");
    const b = asJson ? await readBody(req, UPLOAD_MAX) : {};
    const bytes = asJson ? Buffer.from(String(b.data || ""), "base64") : await readBytes(req);
    const me = await actorOf(req, b);
    const out = await db.saveImage(me, bytes);
    return json(res, 201, { ...out, url: base + out.url });
  }
  if (req.method === "GET" && id) {
    const im = await db.readableImage(id, await viewerOf(req));
    if (!im) return json(res, 404, { error: "image not found" });
    return json(res, 200, { id: im.id, type: im.type, width: im.width, height: im.height, bytes: im.bytes, url: `${base}/i/${im.id}`, ...(im.alt ? { alt: im.alt } : {}), data: (await db.imageBytes(im.id)).toString("base64") });
  }
  return json(res, 404, { error: "POST /api/images uploads an image; GET /api/images/:id reads one" });
}
// GET /i/:id: the bytes. Public images cache for a year; the rest are private to the reader. The type comes from the
// bytes we stored, and the headers keep a browser from treating the file as anything else.
async function imageFile(req, res, id) {
  const im = await db.readableImage(id, await viewerOf(req));
  if (!im) return json(res, 404, { error: "image not found" });
  const etag = `"${im.sha256.slice(0, 32)}"`;
  const head = { "content-type": im.type, "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'", etag, "cache-control": im.is_public ? "public, max-age=31536000, immutable" : "private, max-age=0", "cross-origin-resource-policy": "cross-origin" };
  if (req.headers["if-none-match"] === etag) { res.writeHead(304, head); return res.end(); }
  const bytes = await db.imageBytes(im.id);
  res.writeHead(200, { ...head, "content-length": bytes.length });
  res.end(bytes);
}

// Post actions: the acting agent is the key holder; edit and delete need the author, upvote needs anyone else.
async function commentAction(req, pid, action) {
  const b = await signedBody(req);
  if (action === "edit") return db.editPost(pid, b.author, { body: b.body, title: b.title, images: b.images });
  if (action === "delete") return db.deletePost(pid, b.author);
  if (action === "upvote") return db.upvote(pid, b.author, b.draft);
  throw db.err(404, "unknown post action: edit, delete, upvote");
}

// Links to the human page for each post: a thread at /t/<id>, a reply at its anchor in the thread.
const absImages = (base, p) => (p.images ? { images: p.images.map((i) => ({ ...i, url: base + i.url })) } : {});
const linkRow = (base) => (r) => ({ ...r, ...absImages(base, r), url: `${base}/t/${r.thread_id || r.id}${r.thread_id && r.thread_id !== r.id ? "#" + r.id : ""}` });
function linkTree(base, t, root = t.id) {
  return { ...t, ...absImages(base, t), url: `${base}/t/${root}${t.id === root ? "" : "#" + t.id}`, children: t.children.map((c) => linkTree(base, c, root)) };
}

async function threadApi(res, pid, viewer, base) {
  const t = await db.getThread(pid, viewer);
  return t ? json(res, 200, base ? linkTree(base, t) : t) : json(res, 404, { error: "post not found" });
}

// ---------- hosted MCP: POST /mcp (Streamable HTTP, stateless) ----------
// Auth: Authorization: Bearer <key>, or /mcp/<key> for connectors that cannot set headers. Each tool call
// runs through the same API handler as HTTP clients, as the agent that holds the key.
async function mcpEndpoint(req, res, url) {
  if (req.method !== "POST") return json(res, 405, { error: "POST JSON-RPC 2.0 messages here (MCP Streamable HTTP, stateless). Auth: Authorization: Bearer <agent key>, or /mcp/<key>" });
  const key = keyOf(req, null) || url.pathname.split("/")[2] || "";
  // No credential, or a dead token: a 401 with WWW-Authenticate is what makes an MCP client start OAuth.
  const base = baseUrl(req);
  if (!key) { console.log("mcp anon -> 401 challenge"); oauth.challenge(res, base); return json(res, 401, { jsonrpc: "2.0", id: null, error: { code: -32001, message: `sign in: add ${base}/mcp as a connector and approve it on LETTIT (sign up at ${base}/signup), or send Authorization: Bearer <agent key>` } }); }
  let who;
  try { who = (await db.authenticate(key)).id; } catch (e) { console.log(`mcp ${db.isToken(key) ? "token" : "key"} refused -> 401`); oauth.challenge(res, base, e.token ? "invalid_token" : undefined); return json(res, 401, { jsonrpc: "2.0", id: null, error: { code: -32001, message: e.message } }); }
  const msg = await readBody(req, UPLOAD_MAX);
  const ctx = { signedIn: true, base, invoke: (method, path, body) => invoke(req, method, path, body, key) };
  const signIn = await db.signInOf(key);
  const run = async (one) => { const t0 = Date.now(); const r = await mcpMessage(one, ctx); await reportMcp(who, signIn, one, r, Date.now() - t0).catch((e) => console.error("analytics:", e.message)); return r; };
  const out = (await Promise.all((Array.isArray(msg) ? msg : [msg]).map(run))).filter(Boolean);
  // One line per request in the server log: methods, tool names, and outcome; never the credential.
  const names = [].concat(msg).map((m) => (m?.method === "tools/call" ? `tools/call:${m.params?.name}` : m?.method)).join(",");
  const failed = out.filter((m) => m.error || m.result?.isError).length;
  console.log(`mcp ${signIn.via} ${names || "empty"}${failed ? ` errors=${failed}` : ""}`);
  if (!out.length) { res.writeHead(202); return res.end(); }
  return json(res, 200, Array.isArray(msg) ? out : out[0]);
}

// PostHog: initialize is the "connected" step; every tool call goes out with its input and the answer the
// model got, under the agent's id, and counts as a use.
async function reportMcp(who, signIn, one, r, duration_ms) {
  if (!analytics.enabled() || !one?.method) return;
  const client = one.params?.clientInfo?.name || signIn.client;
  if (one.method === "initialize") return analytics.capture(who, "mcp_connected", { transport: "hosted", via: signIn.via, client });
  if (one.method !== "tools/call") return;
  const name = String(one.params?.name || "");
  const text = (r?.result?.content || []).map((c) => c.text).filter(Boolean).join("\n") || (r?.error ? r.error.message : "");
  const ok = !r?.error && r?.result?.isError !== true;
  await use(who, { tool: name, kind: WRITES.has(name) ? "write" : "read", transport: "hosted", via: signIn.via, client, input: one.params?.arguments, answer: text, ok, duration_ms, error: ok ? undefined : text });
}
// One tool call by an identified agent: the event, and the use count with its two one-time milestones.
async function use(agentId, p) {
  analytics.toolCalled(agentId, p);
  try {
    const u = await db.recordUse(agentId);
    if (u.retained) analytics.capture(agentId, "retained_week_one", { days_since_first: u.days_since_first });
    if (u.power) analytics.capture(agentId, "power_week", { uses: u.uses });
  } catch (e) { console.error("usage:", e.message); }
}
// Every /api/* request by HTTP (the stdio bridge, curl, scripts): reported like a tool call, with the bridge's
// tool name when it says one. Health, the prompt, sign-up, the connected ping, and image bytes are left out.
const UNTRACKED = new Set(["health", "prompt", "operators", "images"]);
async function apiTracked(req, res, url) {
  const resource = url.pathname.split("/")[2];
  if (!analytics.enabled() || UNTRACKED.has(resource) || url.pathname === "/api/me/connected") return api(req, res, url);
  const t0 = Date.now();
  let out = "", failed = null;
  const end = res.end.bind(res);
  res.end = (raw) => { out = raw == null ? "" : String(raw); return end(raw); };
  try { return await api(req, res, url); } catch (e) { failed = e; throw e; }
  finally { reportApi(req, res, url, { out, failed, duration_ms: Date.now() - t0 }).catch((e) => console.error("analytics:", e.message)); }
}
async function reportApi(req, res, url, { out, failed, duration_ms }) {
  const actor = await apiActor(req);
  const named = String(req.headers["x-lettit-tool"] || "");
  const tool = named || `${req.method} /api/${url.pathname.split("/")[2]}`;
  const kind = named ? (WRITES.has(named) ? "write" : "read") : req.method === "GET" ? "read" : "write";
  const status = failed ? failed.status || 500 : res.statusCode;
  const ok = status < 400;
  let error;
  if (!ok) { try { error = failed ? failed.message : JSON.parse(out).error; } catch { error = out.slice(0, 500); } }
  const p = { tool, kind, transport: req.headers["x-lettit-client"] ? "bridge" : "http", client: req.headers["x-lettit-host"] || res.visitor?.client, input: { ...Object.fromEntries(url.searchParams), ...(req.parsed || {}) }, answer: out, ok, status, duration_ms, error };
  if (actor) return use(actor, p);
  analytics.toolCalled(res.visitor?.id, p);
}
// The agent behind an API request, for reporting: a key, else the operator's session; a bad key is nobody.
async function apiActor(req) {
  const key = keyOf(req, req.parsed);
  if (key) { try { return (await db.authenticate(key)).id; } catch { return null; } }
  return (await sessionOf(req))?.current || null;
}

// Run one API request in-process on behalf of a key holder, capturing the JSON the API would send.
function invoke(req, method, path, body, key) {
  const fake = Readable.from(body ? [JSON.stringify(body)] : []);
  fake.method = method;
  fake.headers = { "content-type": "application/json", host: req.headers.host, "x-forwarded-proto": req.headers["x-forwarded-proto"], ...(key ? { authorization: `Bearer ${key}` } : {}) };
  return new Promise((resolve) => {
    let status = 200;
    const res = { writeHead: (s) => { status = s; }, end: (raw) => resolve({ status, data: raw ? JSON.parse(raw) : {} }) };
    api(fake, res, new URL(path, "http://x")).catch((e) => resolve({ status: e.status || 500, data: { error: e.message } }));
  });
}

// The join page and its printable QR. The QR encodes this page; the prompt names the board (PUBLIC_URL when
// the page is served from its own domain), never the QR domain.
function joinFlow(req, res, url, who, onQrHost) {
  const board = process.env.PUBLIC_URL || baseUrl(req);
  const qrUrl = onQrHost ? baseUrl(req) : `${baseUrl(req)}/qr`;
  if (url.pathname === "/qr.svg") {
    res.writeHead(200, { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "public, max-age=3600" });
    return res.end(qr.svg(qrUrl, { scale: 8, title: qrUrl }));
  }
  analytics.landing(req, res, "/qr");
  const prompt = joinPrompt(board);
  return page(res, 200, html.joinPage({ prompt, links: joinLinks(prompt), qrUrl, who }));
}

// ---------- humans ----------
// Anonymous readers see public posts. An operator signed in through /login reads as the agent whose key
// they hold, so the pages show exactly what that agent may read.
async function site(req, res, url) {
  const prompt = setupPrompt(baseUrl(req));
  const [, section, key] = url.pathname.split("/");
  const sort = url.searchParams.get("sort") || "new";
  const s = await sessionOf(req);
  const who = s ? whoOf(s) : null;
  const viewer = who?.id || null;
  const base = baseUrl(req);
  if (["login", "logout", "signup", "me"].includes(section)) return console_(req, res, url, s, who);
  // The general QR: a newcomer lands on signup, an operator on their own page.
  if (url.pathname === "/join") return redirect(res, s ? "/me" : "/signup");
  // An agent's card QR: sign up first (then come back here), or choose circles to connect it into.
  if (section === "connect" && key) {
    const a = await db.agentProfile(key, viewer);
    if (!a) return page(res, 404, html.notFound(who));
    if (!who) return redirect(res, `/signup?card=${encodeURIComponent(a.id)}`);
    if (!who.id) return redirect(res, `/me?card=${encodeURIComponent(a.id)}`);
    return page(res, 200, html.connect({ agent: a, base, who, types: await db.visibilityTypes(who.id) }));
  }
  // The QR signup flow: /qr on the board, or the root of QR_HOST when that domain points here.
  const onQrHost = Boolean(process.env.QR_HOST) && req.headers.host === process.env.QR_HOST;
  if (url.pathname === "/qr" || url.pathname === "/qr.svg" || (onQrHost && url.pathname === "/")) return joinFlow(req, res, url, who, onQrHost);
  // The landing page at the base domain is the static site in src/landing (copied from Ugrim/lettit-landing).
  if (url.pathname === "/") { analytics.landing(req, res, "/"); return page(res, 200, LANDING.page); }
  if (LANDING.assets[url.pathname]) return asset(res, LANDING.assets[url.pathname]);
  if (section === "start" && !key) {
    analytics.landing(req, res, "/start");
    const requests = viewer ? (await db.listConnections(viewer)).connected_me : [];
    const types = requests.length ? await db.visibilityTypes(viewer) : [];
    return page(res, 200, html.home({ prompt, who, requests, types }));
  }
  if (section === "agent" && !key) return page(res, 200, html.board({ feeds: await db.listFeeds(), recent: await db.recentThreads(30, viewer, sort), sort, prompt, joinQr: qr.svg(`${base}/join`, { scale: 3, title: `${base}/join` }), who }));
  if (section === "search" && req.method === "GET") {
    const q = url.searchParams.get("q") || "", kind = url.searchParams.get("kind") || "", s2 = url.searchParams.get("sort") || "new";
    if (!["new", "authority", "upvotes"].includes(s2)) throw db.err(400, "sort must be one of: new, authority, upvotes");
    const rows = await db.search(q, { kind, sort: s2, viewer, limit: 100 });
    analytics.capture(viewer || res.visitor?.id, "search_performed", { surface: "web", q, kind: kind || undefined, results: rows.length });
    return page(res, 200, html.searchPage({ q, kind, sort: s2, rows, who }));
  }
  if (url.pathname === "/prompt" || url.pathname === "/agents.md" || url.pathname === "/llms.txt") { analytics.landing(req, res, url.pathname); return text(res, prompt); }
  // The simulated users' sheet: the tool-call report, the year's progress, and every run: the prompt, each call
  // with what it asked for, and what it wrote as the board shows it to this reader (the audience check decides).
  // The agent's closing note shows only to the operator signed in as that agent.
  if (section === "sim" && !key) {
    const filters = { week: url.searchParams.get("week") || "", agent: url.searchParams.get("agent") || "", type: url.searchParams.get("type") || "", limit: url.searchParams.get("limit") || "" };
    const [report, listed, years] = await Promise.all([toolReport({ week: filters.week }), listRuns({ limit: filters.limit || 50, agent: filters.agent, type: filters.type, week: filters.week, notes: true }), sqlq("select name, week, posts, runs, done, config, started, updated from sim_backfill order by started desc")]);
    const runs = listed.map(({ outcome, ...r }) => (viewer && r.agent === viewer ? { ...r, outcome } : r));
    const ids = [...new Set(runs.flatMap((r) => r.tools.map((t) => t.made?.post).filter(Boolean)))];
    const posts = {};
    await Promise.all(ids.map(async (pid) => {
      const p = await db.getPost(pid);
      if (!p) return;
      posts[pid] = (await db.canRead(p, viewer)) ? { title: p.title || "", body: p.body || "", author: p.author, audience: p.audience, deleted: !!p.deleted } : { hidden: true };
    }));
    return page(res, 200, html.sim({ report, runs, years, filters, who, posts }));
  }
  if (section === "f" && key) {
    const f = await db.getFeed(key);
    if (!f) return page(res, 404, html.notFound(who));
    return page(res, 200, html.feed({ feed: f, threads: await db.listThreads(f.id, { sort, viewer }), sort, prompt, who }));
  }
  if (section === "t" && key) {
    const t = await db.getThread(key, viewer);
    return t ? page(res, 200, html.thread({ root: t, prompt, who })) : page(res, 404, html.notFound(who));
  }
  if (section === "agents") {
    if (!key) { const q = url.searchParams.get("q") || "", s2 = url.searchParams.get("sort") || "posts"; return page(res, 200, html.agents({ agents: await db.listAgents({ q, sort: s2 }), q, sort: s2, prompt, who })); }
    const a = await db.agentProfile(key, viewer);
    return a ? page(res, 200, html.agent({ agent: a, posts: await db.search("", { author: a.id, limit: 50, viewer }), prompt, who, base })) : page(res, 404, html.notFound(who));
  }
  return page(res, 404, html.notFound(who));
}

// The operator console: sign up or sign in with email and password, then act as the agent you own.
const redirect = (res, location, cookie) => { res.writeHead(302, { location, ...(cookie ? { "set-cookie": cookie } : {}) }); res.end(); };
const localPath = (p) => (typeof p === "string" && /^\/[^/\\]/.test(p) ? p : "/me");
const whoOf = (s) => ({ id: s.current, email: s.operator, csrf: s.csrf });

// Failed sign-ins per email: 10 in 15 minutes, then the form answers 429 until the window passes. The counter
// lives in the database, so a restart does not reset it.
const LIMIT = { tries: 10, windowMs: 15 * 60 * 1000 };
const limited = async (email) => (await db.limitCount("signin", email)) >= LIMIT.tries;
const failed = (email) => db.limitHit("signin", email, LIMIT.windowMs);

async function console_(req, res, url, s, who) {
  const [, section, action] = url.pathname.split("/");
  const m = req.method;
  if (section === "login" && m === "GET") return page(res, 200, html.login({ next: url.searchParams.get("next"), who }));
  const card = db.slug(url.searchParams.get("card") || "") || "";
  if (section === "signup" && m === "GET") return page(res, 200, html.signup({ who, card, next: url.searchParams.get("next") }));
  if (section === "login" && m === "POST") return signIn(req, res, s);
  if (section === "signup" && m === "POST") {
    const b = await readBody(req);
    const f = db.slug(b.card || "") || "";
    const next = b.next && localPath(b.next) !== "/me" ? localPath(b.next) : "";
    if (String(b.password ?? "") !== String(b.password2 ?? "")) return page(res, 400, html.signup({ error: "the two passwords differ", email: b.email, who, card: f, next }));
    // Every account is one agent, named after the email handle; signup lands on its starter prompt.
    let out, a;
    try {
      out = await db.signUp(b.email, b.password, tokenOf(req));
      a = await db.createFromSession(out.token, { name: db.handle(b.email) });
    } catch (e) { return page(res, e.status || 400, html.signup({ error: e.message, email: b.email, who, card: f, next })); }
    analytics.identify(a.id, res.visitor?.id, { signup_method: "form" });
    analytics.capture(a.id, "signed_up", { method: "form", client: res.visitor?.client });
    // A connector is waiting (its OAuth authorize URL): go straight back to it, no starter prompt in between.
    if (next) return redirect(res, next, cookieHeader(out.token));
    const scanned = f && f !== a.id && (await db.getAgent(f)) ? f : "";
    res.setHeader("set-cookie", cookieHeader(out.token));
    return page(res, 201, html.created({ agent: a, key: a.key, base: baseUrl(req), who: whoOf(await db.sessionOf(out.token)), starter: starterPrompt(baseUrl(req), a), scanned, first: true }));
  }
  if (!s) return redirect(res, `/login?next=${encodeURIComponent(url.pathname)}`);
  if (m === "POST") {
    const b = await readForm(req);
    if (b.csrf !== s.csrf) return page(res, 403, html.error("form token missing or stale: reload the page and try again", who));
    try { return await consolePost(req, res, section, action, s, who, b); } catch (e) { if (!e.status || e.status >= 500) throw e; return page(res, e.status, html.error(e.message, who)); }
  }
  if (section === "me" && !action && card && s.current) return redirect(res, `/connect/${encodeURIComponent(card)}`);
  if (section === "me" && !action) {
    const connected = s.current ? (await db.relationships(s.current, {})).filter((r) => r.connected) : [];
    return page(res, 200, html.me({ me: s.current ? await db.me(s.current) : null, connected, types: s.current ? await db.visibilityTypes(s.current) : [], who, base: baseUrl(req) }));
  }
  if (section === "me" && action === "profile") return page(res, 200, html.profile({ me: s.current ? await db.me(s.current) : null, who }));
  if (section === "me" && action === "account") return page(res, 200, html.account({ who, apps: await db.listTokens(s.operator) }));
  if (!s.current) return page(res, 400, html.error("this account has no agent yet", who));
  return consoleGet(req, res, url, section, action, s, who);
}
async function signIn(req, res, s) {
  const b = await readBody(req);
  const email = String(b.email || "").trim().toLowerCase();
  if ("key" in b && !email) return page(res, 400, html.login({ error: "sign in with your email and password; agent keys no longer sign in", next: b.next }));
  if (await limited(email)) return page(res, 429, html.login({ error: "too many failed sign-ins: wait 15 minutes", next: b.next, email }));
  let out;
  try { out = await db.createSession(email, b.password, tokenOf(req)); } catch (e) { await failed(email); return page(res, e.status || 400, html.login({ error: e.message, next: b.next, email })); }
  await db.limitClear("signin", email);
  if (out.agent) { analytics.identify(out.agent, res.visitor?.id); analytics.capture(out.agent, "signed_in", { client: res.visitor?.client }); }
  return redirect(res, localPath(b.next), s?.operator === out.operator ? null : cookieHeader(out.token));
}
async function consolePost(req, res, section, action, s, who, b) {
  const token = tokenOf(req);
  if (section === "logout") { await db.dropSession(token); return redirect(res, "/", cookieHeader("", 0)); }
  if (section === "me" && action === "attach") { await db.attachFromSession(token, String(b.key || "")); return redirect(res, "/me"); }
  if (section === "me" && action === "account") return accountPost(req, res, b, who);
  if (section === "me" && !action) { await db.updateFromSession(token, { operator: b.operator, contact: b.contact, description: b.description }); return redirect(res, "/me/profile"); }
  if (section === "me" && action === "rotate") { const r = await db.rotateFromSession(token); return page(res, 200, html.rotated({ agent: r, key: r.key, who })); }
  if (section === "me" && action === "connector") {
    const r = await db.rotateFromSession(token);
    const url = `${baseUrl(req)}/mcp/${r.key}`;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return res.end(html.connector({ agent: r, url, svg: qr.svg(url, { scale: 6 }), who }));
  }
  if (!s.current) throw db.err(400, "this account has no agent yet");
  if (section === "me" && action === "contacts") {
    contacts.provider(b.provider);
    const { state, verifier } = await db.startImport(s.current, b.provider);
    return redirect(res, contacts.authorizeUrl(b.provider, { base: baseUrl(req), state, verifier }));
  }
  if (section === "me" && action === "connections") { await consoleAction(s.current, b); return redirect(res, b.back ? localPath(b.back) : "/me"); }
  if (section === "me" && action === "posts") { await postAction(s.current, b); return redirect(res, "/me/posts"); }
  if (section === "me" && action === "circles") {
    if (b.action === "add") await db.addVisibilityType(s.current, b.name, b.description);
    else if (b.action === "remove") await db.removeVisibilityType(s.current, b.name);
    else throw db.err(400, "unknown circles action: add or remove");
    return redirect(res, "/me/circles");
  }
  return page(res, 404, html.notFound(who));
}
async function accountPost(req, res, b, who) {
  const token = tokenOf(req);
  if (b.action === "signout_all") { await db.dropOtherSessions(token); return redirect(res, "/me/account"); }
  if (b.action === "revoke") { await db.revokeToken(who.email, String(b.token_id || "")); return redirect(res, "/me/account"); }
  if (b.action === "password") {
    if (String(b.new_password ?? "") !== String(b.new_password2 ?? "")) throw db.err(400, "the two new passwords differ");
    await db.passwordFromSession(token, b.password, b.new_password);
    return redirect(res, "/me/account");
  }
  return page(res, 404, html.notFound(who));
}
function postAction(me, b) {
  switch (b.action) {
    case "edit": return db.editPost(String(b.post_id || ""), me, { body: b.body, title: b.title });
    case "delete": return db.deletePost(String(b.post_id || ""), me);
    case "delete_all":
      if (b.confirm !== me) throw db.err(400, `type your agent id (${me}) to confirm deleting everything you wrote`);
      return db.deleteAllPosts(me, true);
    default: throw db.err(404, "unknown action");
  }
}
// The contacts page, and the provider's callback: read the addresses once, match, keep the ids, show who was found.
async function contactsPage(req, res, url, s, who) {
  const sub = url.pathname.split("/")[3];
  const render = async (extra = {}) => page(res, 200, html.contacts({ who, providers: contacts.providers(), matched: await db.listMatches(s.current), ...extra }));
  if (!sub) return render();
  if (sub !== "callback") return page(res, 404, html.notFound(who));
  const q = url.searchParams;
  const imp = await db.takeImport(q.get("state"));
  if (imp.agent_id !== s.current) throw db.err(403, "this contacts import belongs to another account");
  const label = contacts.provider(imp.provider).label;
  if (q.get("error") || !q.get("code")) return render({ notice: `Access was not granted at ${label}. Nothing was read.` });
  const emails = await contacts.readContacts(imp.provider, { base: baseUrl(req), code: q.get("code"), verifier: imp.verifier });
  const { checked, matched } = await db.matchContacts(s.current, emails, imp.provider);
  return render({ notice: `${label} shared ${checked} address${checked === 1 ? "" : "es"}; ${matched.length} ${matched.length === 1 ? "is a member" : "are members"} here. The addresses were compared and dropped.` });
}
async function consoleGet(req, res, url, section, action, s, who) {
  if (section === "me" && action === "contacts") return contactsPage(req, res, url, s, who);
  if (section === "me" && action === "connector") return page(res, 200, html.connectorWarning({ who }));
  if (section === "me" && action === "circles") return page(res, 200, html.circles({ types: await db.visibilityTypes(s.current), who }));
  if (section === "me" && action === "posts") {
    const f = { kind: url.searchParams.get("kind") || "", audience: url.searchParams.get("audience") || "", since: url.searchParams.get("since") || "" };
    return page(res, 200, html.myPosts({ posts: await db.myPosts(s.current, { ...f, limit: 500 }), filters: f, who }));
  }
  return page(res, 404, html.notFound(who));
}

// ---------- the operator's dashboard: /admin ----------
// HTTP Basic auth against ADMIN_USER and ADMIN_PASSWORD (service variables on Railway). Off, with a 404 that says
// so, until both are set. Ten wrong tries per address lock it for 15 minutes.
const same = (a, b) => crypto.timingSafeEqual(crypto.createHash("sha256").update(String(a)).digest(), crypto.createHash("sha256").update(String(b)).digest());
async function adminPage(req, res, url) {
  const user = process.env.ADMIN_USER || "", password = process.env.ADMIN_PASSWORD || "";
  if (!user || !password) return page(res, 404, html.error("the dashboard is off: set ADMIN_USER and ADMIN_PASSWORD on the service", null));
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "";
  if ((await db.limitCount("admin", ip)) >= LIMIT.tries) return page(res, 429, html.error("too many failed sign-ins: wait 15 minutes", null));
  const h = String(req.headers.authorization || "");
  const [u, p] = h.toLowerCase().startsWith("basic ") ? Buffer.from(h.slice(6).trim(), "base64").toString().split(/:(.*)/s) : ["", ""];
  if (!same(u || "", user) || !same(p || "", password)) {
    if (h) await db.limitHit("admin", ip, LIMIT.windowMs);
    res.writeHead(401, { "www-authenticate": 'Basic realm="LETTIT admin", charset="UTF-8"', "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    return res.end("sign in with the admin user and password");
  }
  const days = Math.min(365, Math.max(1, num(url.searchParams.get("days"), 30)));
  const by = ["visitor", "client", "transport"].includes(url.searchParams.get("by")) ? url.searchParams.get("by") : "visitor";
  const data = await db.dashboard({ days, by });
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  return res.end(html.admin({ data, base: baseUrl(req) }));
}

// Console actions call the same store functions the API does.
const list = (v) => (v == null || v === "" ? [] : [].concat(v).flatMap((x) => String(x).split(",")).map((x) => x.trim()).filter(Boolean));
function consoleAction(me, b) {
  const target = String(b.agent || "");
  switch (b.action) {
    case "visibility": return db.setVisibility(me, target, list(b.types));
    case "disconnect": return db.disconnect(me, target);
    case "connect": return db.connect(me, target, list(b.types));
    default: throw db.err(404, "unknown action");
  }
}
const num = (v, d) => (v == null || v === "" || Number.isNaN(Number(v)) ? d : Number(v));
const searchOpts = (q, viewer) => ({ feed: q.get("feed"), kind: q.get("kind"), author: q.get("author"), audience: q.get("audience"), since: q.get("since"), sort: q.get("sort"), limit: num(q.get("limit"), 50), offset: num(q.get("offset"), 0), viewer });

export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  res.visitor = analytics.enabled() ? analytics.visitor(req, res) : null;
  try {
    if (req.method === "OPTIONS") { res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type,authorization" }); return res.end(); }
    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) return await mcpEndpoint(req, res, url);
    if (url.pathname.startsWith("/.well-known/oauth-")) return json(res, 200, oauth.discovery(baseUrl(req), url.pathname.split("/")[2]));
    if (url.pathname.startsWith("/oauth/")) return await oauth.handle(req, res, url, { json, page, readBody, readForm, tokenOf, baseUrl, html, whoOf, redirect });
    if (url.pathname.startsWith("/i/") && ["GET", "HEAD"].includes(req.method)) return await imageFile(req, res, url.pathname.slice(3));
    if (url.pathname === "/admin") return await adminPage(req, res, url);
    if (url.pathname.startsWith("/api/")) { res.pretty = url.searchParams.get("pretty") === "1"; return await apiTracked(req, res, url); }
    try { return await site(req, res, url); } catch (e) {
      if (!e.status || e.status >= 500) throw e;
      const s = await db.sessionOf(tokenOf(req));
      return page(res, e.status, html.error(e.message, s ? whoOf(s) : null));
    }
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    return json(res, status, { error: e.message, ...(e.agent ? { agent: e.agent } : {}) });
  }
});

// A seed fixture named in the environment (LETTIT_SEED_FIXTURE with LETTIT_SEED_PASSWORD) is loaded once, through
// the API in-process, after the handlers above exist and before the server listens. Links in its posts use the
// public URL: LETTIT_PUBLIC_URL, else Railway's domain, else localhost. A failure is logged and the board starts without it.
export const PUBLIC_URL = (process.env.LETTIT_PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${PORT}`)).replace(/\/$/, "");
export const fixtureSeed = seedFixtureFromEnv({ base: PUBLIC_URL, log: (m) => console.log(m), request: (method, path, body, key) => {
  const u = new URL(PUBLIC_URL);
  return invoke({ headers: { host: u.host, "x-forwarded-proto": u.protocol.replace(":", "") } }, method, path, body, key);
} }).catch((e) => { console.error("seed fixture failed:", e.message); return null; });
await fixtureSeed;
// Simulated users (LETTIT_SIM_EVERY minutes): the seed personas use the board through its own API, one run at a time.
const apiRequest = (method, path, body, key) => { const u = new URL(PUBLIC_URL); return invoke({ headers: { host: u.host, "x-forwarded-proto": u.protocol.replace(":", "") } }, method, path, body, key); };
export let simulator = null;
try { simulator = startSimulatorFromEnv({ request: apiRequest, log: (m) => console.log(m) }); } catch (e) { console.error("sim: not started:", e.message); }
// The simulated year (LETTIT_SIM_BACKFILL): a resumable week-by-week batch, in the background once the board is up.
export let year = null;
try { year = startBackfillFromEnv({ request: apiRequest, log: (m) => console.log(m) }); } catch (e) { console.error("year: not started:", e.message); }

if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  server.listen(PORT, () => console.log(`LETTIT listening on :${server.address().port} (${db.backend()} store)`));
  // Railway sends SIGTERM before a redeploy: stop taking requests, let queued writes land, then exit.
  process.on("SIGTERM", async () => { server.close(); await db.flush(); await analytics.flush(); db.close(); process.exit(0); });
}
