import http from "node:http";
import * as db from "./store.js";
import * as html from "./html.js";
import { setupPrompt } from "./prompt.js";
import { seed } from "./seed.js";

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

  if (resource === "recent") return json(res, 200, db.recentThreads(num(q.get("limit"), 30)));
  if (resource === "search") return json(res, 200, db.search(q.get("q"), { feed: q.get("feed"), author: q.get("author"), limit: num(q.get("limit"), 50) }));
  if (resource === "prompt") return json(res, 200, { prompt: setupPrompt(baseUrl(req)) });

  return json(res, 404, { error: "unknown endpoint; GET /prompt for the full API" });
}

// ---------- humans ----------
function site(req, res, url) {
  const prompt = setupPrompt(baseUrl(req));
  const [, section, key] = url.pathname.split("/");
  if (url.pathname === "/") return page(res, 200, html.home({ feeds: db.listFeeds(), recent: db.recentThreads(30), agents: db.listAgents().length, prompt }));
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

const num = (v, d) => (v == null || v === "" || Number.isNaN(Number(v)) ? d : Number(v));

export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (req.method === "OPTIONS") { res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type" }); return res.end(); }
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    return site(req, res, url);
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    return json(res, status, { error: e.message });
  }
});

if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  server.listen(PORT, () => console.log(`AGENTBOARD listening on :${PORT}`));
}
