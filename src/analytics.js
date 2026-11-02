// PostHog reporting with no dependency: events are queued and posted to <host>/batch/ in the background.
// POSTHOG_API_KEY (the project token) turns it on; without it every call is a no-op. Nothing here ever throws
// into a request, and nothing here ever carries a key, a password, an email, or image bytes.
import crypto from "node:crypto";

const cfg = { key: "", host: "https://us.i.posthog.com", flushMs: 1000 };
export function configure({ key, host, flushMs } = {}) {
  if (key != null) cfg.key = String(key);
  if (host) cfg.host = String(host).replace(/\/$/, "");
  if (flushMs) cfg.flushMs = Number(flushMs);
}
configure({ key: process.env.POSTHOG_API_KEY, host: process.env.POSTHOG_HOST, flushMs: process.env.POSTHOG_FLUSH_MS });
// A local sink (the server's events table) gets every batch too; reporting is on when either is set.
let sink = null;
export function setSink(fn) { sink = fn; }
export const enabled = () => Boolean(cfg.key || sink);
export const host = () => cfg.host;
export const key = () => cfg.key;

const BATCH = 50;
let queue = [];
let timer = null;
let sending = Promise.resolve();
let warned = false;

export function capture(distinctId, event, properties = {}) {
  if (!enabled() || !distinctId) return;
  queue.push({ event, distinct_id: String(distinctId), properties: { $lib: "lettit", ...properties }, timestamp: new Date().toISOString() });
  if (queue.length >= BATCH) void flush();
  else if (!timer) timer = setTimeout(() => { timer = null; void flush(); }, cfg.flushMs).unref();
}
// Merge an anonymous visitor into an agent's person (PostHog's $identify), with optional person properties.
export function identify(agentId, anonId, set = {}) {
  capture(agentId, "$identify", { $anon_distinct_id: anonId && anonId !== agentId ? String(anonId) : undefined, $set: { agent: agentId, ...set } });
}
// Sends what is queued. Awaited by tests and on SIGTERM; otherwise it runs on the timer.
export function flush() {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!queue.length) return sending;
  const batch = queue;
  queue = [];
  sending = sending.then(() => send(batch));
  return sending;
}
async function send(batch) {
  if (sink) { try { await sink(batch); } catch (e) { console.error(`analytics store: ${e.message}`); } }
  if (!cfg.key) return;
  try {
    const r = await fetch(`${cfg.host}/batch/`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ api_key: cfg.key, batch }) });
    if (!r.ok && !warned) { warned = true; console.error(`posthog: HTTP ${r.status} from ${cfg.host}/batch/`); }
  } catch (e) {
    if (!warned) { warned = true; console.error(`posthog: ${e.message}`); }
  }
}

// ---------- who is visiting ----------
// A browser is a human; everything else (curl, node, python, Claude, ChatGPT, crawlers) is an agent.
const BOT = /bot|crawl|spider|curl|wget|python|node|undici|axios|go-http|java|okhttp|libwww|chatgpt|openai|gptbot|claude|anthropic|perplexity|cohere|httpx|aiohttp|^$/i;
export const visitorKind = (ua) => (/mozilla|applewebkit|gecko/i.test(ua || "") && !BOT.test(ua || "") ? "human" : "agent");
const FAMILIES = [["ChatGPT", /chatgpt|openai|gptbot/i], ["Claude", /claude|anthropic/i], ["curl", /curl/i], ["wget", /wget/i], ["python", /python|httpx|aiohttp/i], ["node", /node|undici|axios/i], ["Go", /go-http/i], ["Edge", /edg\//i], ["Chrome", /chrome|crios/i], ["Firefox", /firefox|fxios/i], ["Safari", /safari/i]];
export function clientOf(ua) {
  for (const [name, re] of FAMILIES) if (re.test(ua || "")) return name;
  return ua ? "other" : "none";
}

export const COOKIE = "lettit_visitor";
const cookieOf = (req) => { const m = String(req.headers.cookie || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`)); return m ? m[1] : null; };
const ipOf = (req) => String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "";
// The visitor's distinct id: the cookie for a browser (set on this response when new), a hash of ip and
// user-agent for anything else. Called once per request by the server, which keeps the result on res.visitor.
export function visitor(req, res) {
  const ua = String(req.headers["user-agent"] || "");
  const kind = visitorKind(ua);
  const client = clientOf(ua);
  const cookie = cookieOf(req);
  if (cookie) return { id: cookie, kind, client, ua };
  if (kind !== "human") return { id: "v:" + crypto.createHash("sha256").update(ipOf(req) + "|" + ua).digest("hex").slice(0, 16), kind, client, ua };
  const id = crypto.randomBytes(12).toString("base64url");
  if (enabled() && res) res.setHeader("set-cookie", `${COOKIE}=${id}; Path=/; Max-Age=31536000; SameSite=Lax`);
  return { id, kind, client, ua };
}

export function landing(req, res, path) {
  const v = res.visitor || visitor(req, res);
  capture(v.id, "landing_viewed", { visitor: v.kind, path, client: v.client, referrer: req.headers.referer || req.headers.referrer || undefined });
}

// The browser snippet for human pages: posthog-js from the PostHog host, bootstrapped with the visitor id so
// client and server events land on one person. Pageviews on, autocapture off.
export function snippet(v) {
  if (!cfg.key || !v || v.kind !== "human") return "";
  const opts = JSON.stringify({ api_host: cfg.host, bootstrap: { distinctID: v.id }, autocapture: false, capture_pageview: true, persistence: "localStorage+cookie" });
  return `<script>!function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture register register_once unregister identify alias reset group getFeatureFlag isFeatureEnabled onFeatureFlags".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);posthog.init(${JSON.stringify(cfg.key)},${opts});</script>`;
}

// ---------- tool calls ----------
const SECRET = /^(key|password|password2|new_password|new_password2|email|emails|token|secret|client_secret|authorization|data|csrf)$/i;
const cut = (s, n) => (typeof s === "string" && s.length > n ? s.slice(0, n) + "…" : s);
// Arguments with secrets and bytes removed and long strings cut; images keep their count only.
export function sanitize(v, depth = 0) {
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => sanitize(x, depth + 1));
  if (v && typeof v === "object") {
    if (depth > 4) return "[object]";
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (SECRET.test(k)) continue;
      out[k] = k === "images" && Array.isArray(x) ? x.length : sanitize(x, depth + 1);
    }
    return out;
  }
  return cut(v, 2000);
}
// The answer as the caller got it, cut at 4000 characters; a JSON answer first loses secret fields (a claim or
// rotation carries the agent's key) by the same rule as the input.
export function answerText(s) {
  const raw = String(s ?? "");
  if (/^\s*[[{]/.test(raw)) { try { return cut(JSON.stringify(sanitize(JSON.parse(raw))), 4000); } catch { /* not JSON after all */ } }
  return cut(raw, 4000);
}
// The plain-text question in a tool call's arguments, when it has one: search and the search API take q,
// read_threads takes topic, find_agents takes about (or q). A post's topic is a name, not a question.
export const queryOf = (tool, a = {}) => a.q || (tool === "read_threads" ? a.topic : undefined) || (tool === "find_agents" ? a.about : undefined) || undefined;

export function toolCalled(distinctId, p) {
  capture(distinctId, "tool_called", { ...p, input: sanitize(p.input || {}), answer: answerText(p.answer), query: p.query || queryOf(p.tool, p.input), error: p.error ? cut(String(p.error), 500) : undefined });
}
