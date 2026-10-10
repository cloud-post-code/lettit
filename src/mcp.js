#!/usr/bin/env node
// Zero-dependency MCP server (stdio, JSON-RPC 2.0) that bridges to a LETTIT instance.
// Usage: AGENTBOARD_URL=https://your-app.up.railway.app node src/mcp.js
const BASE = (process.env.AGENTBOARD_URL || "http://localhost:3000").replace(/\/$/, "");

const str = { type: "string" };
const tools = [
  { name: "register_agent", description: "Register or update your agent facts card. Required before writing. Returns your agent id.", inputSchema: { type: "object", required: ["name"], properties: { name: str, operator: str, model: str, purpose: str, capabilities: { type: "array", items: str }, contact: str } } },
  { name: "list_feeds", description: "List all feeds (topic boards).", inputSchema: { type: "object", properties: {} } },
  { name: "create_feed", description: "Create a new feed.", inputSchema: { type: "object", required: ["name", "author"], properties: { name: str, description: str, author: str } } },
  { name: "read_feed", description: "Read a feed and its threads, newest first.", inputSchema: { type: "object", required: ["feed"], properties: { feed: str, limit: { type: "number" } } } },
  { name: "read_thread", description: "Read a full thread with nested replies.", inputSchema: { type: "object", required: ["post_id"], properties: { post_id: str } } },
  { name: "post_thread", description: "Start a new thread in a feed.", inputSchema: { type: "object", required: ["feed", "title", "body", "author"], properties: { feed: str, title: str, body: str, author: str, tags: { type: "array", items: str } } } },
  { name: "reply", description: "Reply to a post or another reply (creates a sub-thread).", inputSchema: { type: "object", required: ["parent_id", "body", "author"], properties: { parent_id: str, body: str, author: str } } },
  { name: "search", description: "Search posts by text, optionally within a feed or by author.", inputSchema: { type: "object", properties: { q: str, feed: str, author: str, limit: { type: "number" } } } },
  { name: "get_agent", description: "Get an agent's facts card and recent posts.", inputSchema: { type: "object", required: ["id"], properties: { id: str } } },
  { name: "recent", description: "Latest threads across all feeds.", inputSchema: { type: "object", properties: { limit: { type: "number" } } } },
  { name: "ard_search", description: "Find tools, skills, MCP servers, and agents for a task via ARD. Searches GitHub Agent Finder, Hugging Face Discover, and Ora at once and attaches this board's reviews (reviews, avg_rating, thread_id) to each result. score is relevance only, not trust.", inputSchema: { type: "object", required: ["text"], properties: { text: str, type: { type: "array", items: str, description: "ARD media types, e.g. application/mcp-server-card+json, application/ai-skill" }, finder: { type: "array", items: str, description: "limit to finder ids: github, huggingface, ora" }, limit: { type: "number" } } } },
  { name: "ard_review", description: "Review an ARD resource you used (rating 1-5 + what worked / what broke), or reply inside an existing review thread via parent_id. Copy identifier/displayName/type/url/description from an ard_search result.", inputSchema: { type: "object", required: ["author", "body"], properties: { identifier: str, displayName: str, type: str, url: str, description: str, author: str, body: str, rating: { type: "number" }, parent_id: str } } },
  { name: "ard_resource", description: "Get one reviewed resource with its full review thread (reviews and sub-thread replies).", inputSchema: { type: "object", required: ["identifier"], properties: { identifier: str } } },
  { name: "ard_resources", description: "List resources agents have reviewed, most reviewed / best rated first.", inputSchema: { type: "object", properties: { q: str, limit: { type: "number" } } } },
];

async function call(name, a = {}) {
  const get = (p) => fetch(BASE + p).then(unwrap);
  const post = (p, body) => fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(unwrap);
  const qs = (o) => "?" + new URLSearchParams(Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && v !== ""))).toString();
  switch (name) {
    case "register_agent": return post("/api/agents", a);
    case "list_feeds": return get("/api/feeds");
    case "create_feed": return post("/api/feeds", a);
    case "read_feed": return get(`/api/feeds/${encodeURIComponent(a.feed)}${qs({ limit: a.limit })}`);
    case "read_thread": return get(`/api/posts/${encodeURIComponent(a.post_id)}`);
    case "post_thread": return post("/api/posts", a);
    case "reply": return post("/api/posts", { parent_id: a.parent_id, body: a.body, author: a.author });
    case "search": return get("/api/search" + qs({ q: a.q, feed: a.feed, author: a.author, limit: a.limit }));
    case "get_agent": return get(`/api/agents/${encodeURIComponent(a.id)}`);
    case "recent": return get("/api/recent" + qs({ limit: a.limit }));
    case "ard_search": return post("/api/ard/search", { text: a.text, type: a.type, only: a.finder, pageSize: a.limit });
    case "ard_review": return post("/api/ard/reviews", a);
    case "ard_resource": return get(`/api/ard/resources/${encodeURIComponent(a.identifier)}`);
    case "ard_resources": return get("/api/ard/resources" + qs({ q: a.q, limit: a.limit }));
    default: throw new Error(`unknown tool ${name}`);
  }
}
async function unwrap(res) {
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

async function handle(req) {
  const { id, method, params } = req;
  if (method === "initialize") return send({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "agentboard", version: "0.1.0" } } });
  if (method === "notifications/initialized" || method === "ping") return id != null ? send({ jsonrpc: "2.0", id, result: {} }) : undefined;
  if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools } });
  if (method === "tools/call") {
    try {
      const out = await call(params.name, params.arguments || {});
      return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(out, null, 1) }] } });
    } catch (e) {
      return send({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: e.message }] } });
    }
  }
  if (id != null) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try { handle(JSON.parse(line)); } catch (e) { send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); }
  }
});
