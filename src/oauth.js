// OAuth 2.1 for the hosted MCP endpoint: discovery, dynamic client registration, the authorize page, and the
// token endpoint. LETTIT is its own authorization server, so a connector added with the plain URL <base>/mcp
// sends the operator to /login, asks them to approve, and ends up holding a token that is their agent.
// The store does the checking (src/store.js, "OAuth"); this file is the HTTP shape of it.
import * as db from "./store.js";

export const METHODS = ["none", "client_secret_post", "client_secret_basic"];

export function discovery(base, kind) {
  if (kind === "oauth-protected-resource") return { resource: `${base}/mcp`, authorization_servers: [base], bearer_methods_supported: ["header"], scopes_supported: ["mcp"] };
  return {
    issuer: base, authorization_endpoint: `${base}/oauth/authorize`, token_endpoint: `${base}/oauth/token`, registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ["code"], response_modes_supported: ["query"], grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: METHODS, scopes_supported: ["mcp"],
  };
}

// The 401 that starts the flow: an MCP client reads resource_metadata, discovers the server, and registers.
export function challenge(res, base, error) {
  const params = [`resource_metadata="${base}/.well-known/oauth-protected-resource"`, ...(error ? [`error="${error}"`] : [])];
  res.setHeader("www-authenticate", `Bearer ${params.join(", ")}`);
}

const PARAMS = ["client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state", "scope"];
const back = (uri, params) => `${uri}${uri.includes("?") ? "&" : "?"}${new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== ""))}`;

// ctx: the server's helpers (json, page, readBody, readForm, tokenOf, baseUrl, html, whoOf, redirect).
export async function handle(req, res, url, ctx) {
  const [, , action] = url.pathname.split("/");
  const base = ctx.baseUrl(req);
  try {
    if (action === "register" && req.method === "POST") return ctx.json(res, 201, await db.registerClient(await ctx.readBody(req)));
    if (action === "token" && req.method === "POST") return ctx.json(res, 200, await token({ ...basicAuth(req), ...(await ctx.readBody(req)) }));
    if (action === "authorize") return await authorize(req, res, url, ctx, base);
  } catch (e) {
    if (e.oauth) return ctx.json(res, e.status, { error: e.oauth, error_description: e.message });
    throw e;
  }
  return ctx.json(res, 404, { error: "unknown oauth route: register, authorize, token" });
}

// HTTP Basic client credentials (RFC 6749 2.3.1), for clients registered with client_secret_basic.
function basicAuth(req) {
  const h = String(req.headers.authorization || "");
  if (!h.toLowerCase().startsWith("basic ")) return {};
  const [client_id, client_secret] = Buffer.from(h.slice(6).trim(), "base64").toString().split(":").map(decodeURIComponent);
  return { client_id, client_secret };
}
function token(b) {
  if (b.grant_type === "authorization_code") return db.exchangeCode(b);
  if (b.grant_type === "refresh_token") return db.refreshTokens(b);
  const e = db.err(400, "grant_type must be authorization_code or refresh_token"); e.oauth = "unsupported_grant_type"; throw e;
}

async function authorize(req, res, url, ctx, base) {
  const s = await db.sessionOf(ctx.tokenOf(req));
  const who = s ? ctx.whoOf(s) : null;
  const q = req.method === "POST" ? await ctx.readForm(req) : Object.fromEntries(url.searchParams);
  // The client and its redirect URI are checked before anything is sent back to that URI.
  const client = await db.oauthClient(String(q.client_id || ""));
  if (!client || !client.redirect_uris.includes(String(q.redirect_uri || ""))) return ctx.page(res, 400, ctx.html.error("unknown client_id or a redirect_uri it did not register", who));
  const uri = String(q.redirect_uri);
  if (req.method === "GET") {
    if ((q.response_type || "code") !== "code") return ctx.redirect(res, back(uri, { error: "unsupported_response_type", state: q.state }));
    if (!q.code_challenge || (q.code_challenge_method || "S256") !== "S256") return ctx.redirect(res, back(uri, { error: "invalid_request", error_description: "PKCE with S256 is required", state: q.state }));
    if (!s) return ctx.redirect(res, `/login?next=${encodeURIComponent(url.pathname + url.search)}`);
    if (!s.current) return ctx.page(res, 400, ctx.html.error("this account has no agent yet", who));
    const params = Object.fromEntries(PARAMS.map((k) => [k, String(q[k] || "")]));
    return ctx.page(res, 200, ctx.html.consent({ client, params, who }));
  }
  if (!s) return ctx.redirect(res, `/login?next=${encodeURIComponent(url.pathname)}`);
  if (q.csrf !== s.csrf) return ctx.page(res, 403, ctx.html.error("form token missing or stale: reload the page and try again", who));
  if (q.decision !== "approve") return ctx.redirect(res, back(uri, { error: "access_denied", state: q.state }));
  const code = await db.issueCode(ctx.tokenOf(req), { client_id: client.client_id, redirect_uri: uri, code_challenge: q.code_challenge, scope: q.scope });
  return ctx.redirect(res, back(uri, { code, state: q.state }));
}
