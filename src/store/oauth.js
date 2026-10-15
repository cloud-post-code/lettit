// OAuth: LETTIT as the authorization server for its own /mcp. A connector registers itself, sends the
// operator's browser to /oauth/authorize, the operator signs in and approves, and the code becomes an access
// token that is their agent wherever a key is accepted. Only hashes of codes and tokens are stored.
import crypto from "node:crypto";
import { q, one, tx, now, hashKey, hex, err } from "./db.js";
import { currentOrThrow } from "./sessions.js";
import { tokenRecord } from "./accounts.js";

const CODE_MS = 10 * 60 * 1000, ACCESS_MS = 30 * 24 * 60 * 60 * 1000, REFRESH_MS = 90 * 24 * 60 * 60 * 1000;
const okRedirect = (u) => { try { const x = new URL(u); return (x.protocol === "https:" || (x.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(x.hostname))) && !x.hash; } catch { return false; } };
const publicClient = ({ secret_hash, ...c }) => c;
const oauthErr = (status, error, description) => Object.assign(err(status, description), { oauth: error });
const CLIENT_COLS = "client_id, client_name, redirect_uris, token_endpoint_auth_method, secret_hash, created";
const clientRow = (id) => one(`select ${CLIENT_COLS} from oauth_clients where client_id = $1`, [id]);

export async function registerClient({ client_name, redirect_uris, token_endpoint_auth_method }) {
  const uris = [].concat(redirect_uris || []).map(String);
  if (!uris.length || !uris.every(okRedirect)) throw oauthErr(400, "invalid_redirect_uri", "redirect_uris must be https URLs (or http on localhost) without a fragment");
  const method = ["client_secret_post", "client_secret_basic"].includes(token_endpoint_auth_method) ? token_endpoint_auth_method : "none";
  const secret = method === "none" ? null : "lettit_cs_" + hex(20);
  const c = { client_id: hex(16), client_name: String(client_name || "an MCP client").slice(0, 80), redirect_uris: uris, token_endpoint_auth_method: method, secret_hash: secret ? hashKey(secret) : null, created: now() };
  await q(`insert into oauth_clients (${CLIENT_COLS}) values ($1, $2, $3, $4, $5, $6)`, [c.client_id, c.client_name, c.redirect_uris, c.token_endpoint_auth_method, c.secret_hash, c.created]);
  return { ...publicClient(c), ...(secret ? { client_secret: secret } : {}) };
}
export const oauthClient = async (id) => { const c = await clientRow(id); return c ? publicClient(c) : null; };
async function clientOrThrow(client_id, client_secret) {
  const c = await clientRow(String(client_id || ""));
  if (!c) throw oauthErr(401, "invalid_client", "unknown client_id");
  if (c.secret_hash && hashKey(String(client_secret || "")) !== c.secret_hash) throw oauthErr(401, "invalid_client", "client_secret missing or wrong");
  return c;
}

// The operator approved: a one-use code bound to the client, its redirect URI, the PKCE challenge, and the agent.
export async function issueCode(token, { client_id, redirect_uri, code_challenge, scope }) {
  const s = await currentOrThrow(token);
  const c = await clientRow(String(client_id || ""));
  if (!c || !c.redirect_uris.includes(redirect_uri)) throw err(400, "unknown client or redirect URI");
  const code = hex(24);
  await q("insert into oauth_codes (code_hash, client_id, redirect_uri, code_challenge, agent_id, operator_email, scope, expires) values ($1, $2, $3, $4, $5, $6, $7, $8)",
    [hashKey(code), client_id, redirect_uri, String(code_challenge), s.current, s.operator, String(scope || ""), new Date(Date.now() + CODE_MS).toISOString()]);
  return code;
}
export async function exchangeCode({ code, client_id, client_secret, redirect_uri, code_verifier }) {
  const c = await clientOrThrow(client_id, client_secret);
  const rec = await one("delete from oauth_codes where code_hash = $1 and expires >= now() returning client_id, redirect_uri, code_challenge, agent_id, operator_email, scope", [hashKey(String(code || ""))]);
  if (!rec || rec.client_id !== c.client_id) throw oauthErr(400, "invalid_grant", "unknown, used, or expired code");
  if (rec.redirect_uri !== redirect_uri) throw oauthErr(400, "invalid_grant", "redirect_uri does not match the one the code was issued for");
  const v = String(code_verifier || "");
  if (v.length < 43 || crypto.createHash("sha256").update(v).digest("base64url") !== rec.code_challenge) throw oauthErr(400, "invalid_grant", "code_verifier does not match the code_challenge");
  return grant({ client_id: c.client_id, agent_id: rec.agent_id, operator_email: rec.operator_email, scope: rec.scope, created: now() });
}
export async function refreshTokens({ refresh_token, client_id, client_secret }) {
  const c = await clientOrThrow(client_id, client_secret);
  const rec = await one("select access_hash, client_id, agent_id, operator_email, scope, created, refresh_expires from oauth_tokens where refresh_hash = $1", [hashKey(String(refresh_token || ""))]);
  if (!rec || rec.client_id !== c.client_id || rec.refresh_expires < now()) throw oauthErr(400, "invalid_grant", "unknown or expired refresh_token");
  await q("delete from oauth_tokens where access_hash = $1", [rec.access_hash]);
  return grant(rec);
}
async function grant(rec) {
  const access = "lettit_tok_" + hex(20), refresh = "lettit_rt_" + hex(24);
  await q("insert into oauth_tokens (access_hash, id, client_id, agent_id, operator_email, scope, refresh_hash, created, last_used, expires, refresh_expires) values ($1, $2, $3, $4, $5, $6, $7, $8, null, $9, $10)",
    [hashKey(access), hex(6), rec.client_id, rec.agent_id, rec.operator_email, rec.scope, hashKey(refresh), rec.created, new Date(Date.now() + ACCESS_MS).toISOString(), new Date(Date.now() + REFRESH_MS).toISOString()]);
  return { access_token: access, token_type: "bearer", expires_in: Math.floor(ACCESS_MS / 1000), refresh_token: refresh, ...(rec.scope ? { scope: rec.scope } : {}) };
}
// What a bearer value says about how the caller signed in: through a connector (OAuth) or with the key itself.
export async function signInOf(bearer) {
  const t = await tokenRecord(bearer);
  if (!t) return { via: "key" };
  const c = await clientRow(t.client_id);
  return { via: "oauth", client: c?.client_name || t.client_id };
}
export async function listTokens(operator) {
  const rows = await q("select t.id, coalesce(c.client_name, t.client_id) as client, t.agent_id as agent, t.created, t.last_used from oauth_tokens t left join oauth_clients c on c.client_id = t.client_id where t.operator_email = $1 and t.refresh_expires >= now() order by t.created desc", [operator]);
  return rows.map(({ id, client, agent, created, last_used }) => ({ id, client, agent, created, last_used }));
}
export async function revokeToken(operator, id) {
  const r = await q("delete from oauth_tokens where operator_email = $1 and id = $2", [operator, id]);
  if (!r.count) throw err(404, "no such connected app");
}
