import { test, before, after } from "node:test";
import { claimCard, login, T, credsOf } from "./_operators.js";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lettit-oauth-"));
process.env.DATABASE_URL = (await (await import("./_db.js")).freshSchema({ cleanup: true })).url;
const { server } = await import("../src/server.js");

let base;
after(() => server.close());

const jsonPost = (p, b, headers = {}) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(b) }).then(async (r) => [r.status, await r.json(), r]);
const form = (p, fields, cookie) => fetch(base + p, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(fields).toString() });
let n = 0;
const rpc = (method, params, token) => fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method, params }) });
const call = async (name, args, token) => {
  const r = await rpc("tools/call", { name, arguments: args }, token);
  const msg = await r.json();
  const c = msg.result.content[0].text;
  return [msg.result.isError === true, msg.result.isError ? c : JSON.parse(c)];
};
const s256 = (v) => crypto.createHash("sha256").update(v).digest("base64url");
const REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";

let client, cookie, remyCookie, remy, pat;
before(async () => {
  await new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); }));
  [, remy] = await claimCard(base, { name: "Remy" });
  [, pat] = await claimCard(base, { name: "Pat" });
  cookie = await login(base, credsOf("Pat"));
  remyCookie = await login(base, credsOf("Remy"));
});

test("discovery documents point at LETTIT's own authorization server, and anonymous /mcp is challenged", async () => {
  const as = await fetch(base + "/.well-known/oauth-authorization-server").then((r) => r.json());
  assert.equal(as.issuer, base);
  assert.equal(as.authorization_endpoint, base + "/oauth/authorize");
  assert.equal(as.token_endpoint, base + "/oauth/token");
  assert.equal(as.registration_endpoint, base + "/oauth/register");
  assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
  assert.ok(as.grant_types_supported.includes("refresh_token"));
  const pr = await fetch(base + "/.well-known/oauth-protected-resource/mcp").then((r) => r.json());
  assert.equal(pr.resource, base + "/mcp");
  assert.deepEqual(pr.authorization_servers, [base]);
  const anon = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } });
  assert.equal(anon.status, 401);
  assert.match(anon.headers.get("www-authenticate"), /^Bearer resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource"/);
  const body = await anon.json();
  assert.ok(body.error, "a JSON-RPC error body explains the challenge");
  const bad = await rpc("tools/list", {}, "lettit_tok_" + "0".repeat(40));
  assert.equal(bad.status, 401);
  assert.match(bad.headers.get("www-authenticate"), /error="invalid_token"/);
});

test("a client registers itself; authorize validates the redirect URI and sends a signed-out browser to sign in", async () => {
  const [s, c] = await jsonPost("/oauth/register", { client_name: "ChatGPT", redirect_uris: [REDIRECT] });
  assert.equal(s, 201);
  assert.match(c.client_id, /^[0-9a-f]{32}$/);
  assert.deepEqual(c.redirect_uris, [REDIRECT]);
  assert.equal(c.client_secret, undefined, "public clients get no secret");
  assert.equal(c.token_endpoint_auth_method, "none");
  client = c;
  const [bad, e] = await jsonPost("/oauth/register", { client_name: "x", redirect_uris: ["http://evil.example/cb"] });
  assert.equal(bad, 400);
  assert.equal(e.error, "invalid_redirect_uri");

  const q = new URLSearchParams({ response_type: "code", client_id: c.client_id, redirect_uri: REDIRECT, code_challenge: s256("v"), code_challenge_method: "S256", state: "xyz" });
  const out = await fetch(`${base}/oauth/authorize?${q}`, { redirect: "manual" });
  assert.equal(out.status, 302);
  const loc = out.headers.get("location");
  assert.ok(loc.startsWith("/login?next=%2Foauth%2Fauthorize%3F"), loc);
  assert.equal(new URL(loc, base).searchParams.get("next"), `/oauth/authorize?${q}`);

  const wrong = await fetch(`${base}/oauth/authorize?${new URLSearchParams({ ...Object.fromEntries(q), redirect_uri: "https://chatgpt.com/other" })}`, { redirect: "manual", headers: { cookie } });
  assert.equal(wrong.status, 400, "a redirect URI that was not registered is refused on the page, never redirected to");
  const noPkce = await fetch(`${base}/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: c.client_id, redirect_uri: REDIRECT, state: "s" })}`, { redirect: "manual", headers: { cookie } });
  assert.equal(noPkce.status, 302);
  assert.match(noPkce.headers.get("location"), /^https:\/\/chatgpt\.com\/connector_platform_oauth_redirect\?error=invalid_request&/);
});

let token, refresh;
test("a signed-in operator approves, and the code exchanges for tokens that act as the account's agent", async () => {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const q = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: s256(verifier), code_challenge_method: "S256", state: "st-1", scope: "mcp" });
  const pageRes = await fetch(`${base}/oauth/authorize?${q}`, { headers: { cookie } });
  assert.equal(pageRes.status, 200);
  const html = await pageRes.text();
  assert.match(html, /ChatGPT/, "names the client");
  assert.match(html, /act as <b>t-pat<\/b>/, "the account's one agent, no picker");
  assert.ok(!html.includes('type="radio"'));
  const csrf = html.match(/name="csrf" value="([^"]+)"/)[1];
  const fields = Object.fromEntries([...html.matchAll(/name="(client_id|redirect_uri|code_challenge|code_challenge_method|state|scope)" value="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  assert.equal(fields.client_id, client.client_id);

  const denied = await form("/oauth/authorize", { csrf, ...fields, decision: "cancel" }, cookie);
  assert.equal(denied.status, 302);
  assert.equal(denied.headers.get("location"), `${REDIRECT}?error=access_denied&state=st-1`);

  const foreign = await form("/oauth/authorize", { csrf, ...fields, agent: "nobody-else", decision: "approve" }, cookie);
  assert.equal(foreign.status, 302, "a stray agent field changes nothing: the token is the account's agent");

  const approve = async () => {
    const ok = await form("/oauth/authorize", { csrf, ...fields, decision: "approve" }, cookie);
    assert.equal(ok.status, 302);
    const dest = new URL(ok.headers.get("location"));
    assert.equal(dest.origin + dest.pathname, REDIRECT);
    assert.equal(dest.searchParams.get("state"), "st-1");
    const code = dest.searchParams.get("code");
    assert.ok(code && code.length >= 32);
    return code;
  };
  const burnt = await approve();
  const [sBad, eBad] = await jsonPost("/oauth/token", { grant_type: "authorization_code", code: burnt, client_id: client.client_id, redirect_uri: REDIRECT, code_verifier: "wrong" });
  assert.equal(sBad, 400);
  assert.equal(eBad.error, "invalid_grant");
  const [sBurnt] = await jsonPost("/oauth/token", { grant_type: "authorization_code", code: burnt, client_id: client.client_id, redirect_uri: REDIRECT, code_verifier: verifier });
  assert.equal(sBurnt, 400, "a wrong verifier burns the code");
  const code = await approve();
  const tok = await fetch(base + "/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: client.client_id, redirect_uri: REDIRECT, code_verifier: verifier }) });
  const t = await tok.json();
  assert.equal(tok.status, 200, t.error);
  assert.match(t.access_token, /^lettit_tok_[0-9a-f]{40}$/);
  assert.equal(t.token_type, "bearer");
  assert.ok(t.expires_in > 0);
  assert.ok(t.refresh_token);
  token = t.access_token;
  refresh = t.refresh_token;
  const [sTwice, eTwice] = await jsonPost("/oauth/token", { grant_type: "authorization_code", code, client_id: client.client_id, redirect_uri: REDIRECT, code_verifier: verifier });
  assert.equal(sTwice, 400, "a code is one-use");
  assert.equal(eTwice.error, "invalid_grant");

  const [e1, me] = await call("whoami", {}, token);
  assert.equal(e1, false, me);
  assert.deepEqual(Object.keys(me).sort(), ["description", "expertise", "name", "onboarding"], "the token signs in as the account's agent; onboarding while it has no connections of its own");
  assert.equal(me.key, undefined);
  const [e2, p] = await call("post", { category: "coding", topic: "general", topic_description: "Test topic.", kind: "status", body: "signed in through oauth" }, token);
  assert.equal(e2, false, p);
  assert.equal(p.author, "t-pat");
  const api = await fetch(base + "/api/me", { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json());
  assert.equal(api.id, "t-pat", "the HTTP API takes the same token");
  const [e3, rot] = await call("rotate_key", {}, token);
  assert.equal(e3, true);
  assert.match(rot, /token cannot rotate/);
  const list = await rpc("tools/list", {}, token).then((r) => r.json());
  assert.ok(!list.result.tools.find((x) => x.name === "post").inputSchema.required.includes("author"), "signed in: no author argument");
});

test("refresh rotates the pair, the old access token stops, and the operator can revoke from the account page", async () => {
  const [s, t] = await jsonPost("/oauth/token", { grant_type: "refresh_token", refresh_token: refresh, client_id: client.client_id });
  assert.equal(s, 200, t.error);
  assert.notEqual(t.access_token, token);
  assert.notEqual(t.refresh_token, refresh);
  const old = await rpc("tools/list", {}, token);
  assert.equal(old.status, 401, "the replaced access token is dead");
  const [sOld] = await jsonPost("/oauth/token", { grant_type: "refresh_token", refresh_token: refresh, client_id: client.client_id });
  assert.equal(sOld, 400, "the old refresh token is dead too");
  token = t.access_token;
  const [e, me] = await call("whoami", {}, token);
  assert.equal(e, false, me);
  assert.ok(me.name, "the refreshed token still signs in");

  const acct = await fetch(base + "/me/account", { headers: { cookie } }).then((r) => r.text());
  assert.match(acct, /Connected apps/);
  assert.match(acct, /ChatGPT/);
  assert.match(acct, /t-pat/);
  const csrf = acct.match(/name="csrf" value="([^"]+)"/)[1];
  const id = acct.match(/name="token_id" value="([^"]+)"/)[1];
  const gone = await form("/me/account", { csrf, action: "revoke", token_id: id }, cookie);
  assert.equal(gone.status, 302);
  const dead = await rpc("tools/list", {}, token);
  assert.equal(dead.status, 401);
  const after = await fetch(base + "/me/account", { headers: { cookie } }).then((r) => r.text());
  assert.ok(!after.includes('name="token_id"'), "nothing left to revoke");
});

test("a newcomer who signs up from the sign-in page keeps the connector's return URL", async () => {
  const q = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: s256("v".repeat(43)), code_challenge_method: "S256", state: "new" });
  const next = `/oauth/authorize?${q}`;
  const loginPage = await fetch(`${base}/login?next=${encodeURIComponent(next)}`).then((r) => r.text());
  assert.ok(loginPage.includes(`<form method="post" action="/signup">`) && loginPage.includes(`name="next" value="${next.replace(/&/g, "&amp;")}"`), "the signup form carries next");
  const up = await form("/signup", { email: "newcomer@x.io", password: "newcomer-pw-1", password2: "newcomer-pw-1", next });
  assert.equal(up.status, 302, "no starter prompt in between: signup goes straight back to the connector");
  assert.equal(up.headers.get("location"), next);
  assert.match(up.headers.get("set-cookie") || "", /^[^=]+=[^;]+/, "and the new session comes with it");
  const bad = await form("/signup", { email: "other@x.io", password: "other-pw-12345", password2: "different-pw-1", next });
  assert.equal(bad.status, 400);
  const badHtml = await bad.text();
  assert.ok(badHtml.includes(`name="next" value="${next.replace(/&/g, "&amp;")}"`), "a failed signup keeps the return URL");
  assert.ok(badHtml.includes(`href="/login?next=${encodeURIComponent(next).replace(/&/g, "&amp;")}"`), "and so does the sign-in link");
});

test("a client registered with client_secret_basic sends its credentials in the Authorization header", async () => {
  const [, c] = await jsonPost("/oauth/register", { client_name: "Basic", redirect_uris: ["http://localhost:4444/cb"], token_endpoint_auth_method: "client_secret_basic" });
  assert.equal(c.token_endpoint_auth_method, "client_secret_basic");
  assert.ok(c.client_secret);
  const verifier = "b".repeat(43);
  const q = new URLSearchParams({ response_type: "code", client_id: c.client_id, redirect_uri: "http://localhost:4444/cb", code_challenge: s256(verifier), code_challenge_method: "S256", state: "s3" });
  const html = await fetch(`${base}/oauth/authorize?${q}`, { headers: { cookie: remyCookie } }).then((r) => r.text());
  const csrf = html.match(/name="csrf" value="([^"]+)"/)[1];
  const fields = Object.fromEntries([...html.matchAll(/name="(client_id|redirect_uri|code_challenge|code_challenge_method|state|scope)" value="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  const ok = await form("/oauth/authorize", { csrf, ...fields, decision: "approve" }, remyCookie);
  const code = new URL(ok.headers.get("location")).searchParams.get("code");
  const basic = "Basic " + Buffer.from(`${c.client_id}:${c.client_secret}`).toString("base64");
  const [s, t] = await jsonPost("/oauth/token", { grant_type: "authorization_code", code, redirect_uri: "http://localhost:4444/cb", code_verifier: verifier }, { authorization: basic });
  assert.equal(s, 200, t.error_description);
  const [e, me] = await call("whoami", {}, t.access_token);
  assert.equal(e, false, me);
  assert.ok(me.name, "a Basic-auth client signs in");
});

test("rotating the agent's key revokes its tokens; a confidential client must present its secret", async () => {
  const [, c] = await jsonPost("/oauth/register", { client_name: "Claude", redirect_uris: ["http://localhost:3333/cb"], token_endpoint_auth_method: "client_secret_post" });
  assert.ok(c.client_secret);
  const verifier = "v".repeat(43);
  const q = new URLSearchParams({ response_type: "code", client_id: c.client_id, redirect_uri: "http://localhost:3333/cb", code_challenge: s256(verifier), code_challenge_method: "S256", state: "s2" });
  const html = await fetch(`${base}/oauth/authorize?${q}`, { headers: { cookie: remyCookie } }).then((r) => r.text());
  const csrf = html.match(/name="csrf" value="([^"]+)"/)[1];
  const fields = Object.fromEntries([...html.matchAll(/name="(client_id|redirect_uri|code_challenge|code_challenge_method|state|scope)" value="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  const ok = await form("/oauth/authorize", { csrf, ...fields, decision: "approve" }, remyCookie);
  const code = new URL(ok.headers.get("location")).searchParams.get("code");
  const [sNo, eNo] = await jsonPost("/oauth/token", { grant_type: "authorization_code", code, client_id: c.client_id, redirect_uri: "http://localhost:3333/cb", code_verifier: verifier });
  assert.equal(sNo, 401);
  assert.equal(eNo.error, "invalid_client");
  const [sOk, t] = await jsonPost("/oauth/token", { grant_type: "authorization_code", code, client_id: c.client_id, client_secret: c.client_secret, redirect_uri: "http://localhost:3333/cb", code_verifier: verifier });
  assert.equal(sOk, 200, t.error);
  const [e, me] = await call("whoami", {}, t.access_token);
  assert.equal(e, false, me);
  assert.ok(me.name, "a confidential client signs in");
  const rotated = await fetch(base + "/api/me/rotate", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${remy.key}` }, body: "{}" });
  assert.equal(rotated.status, 200);
  const dead = await rpc("tools/list", {}, t.access_token);
  assert.equal(dead.status, 401, "rotating the key revokes the agent's tokens");
  assert.ok(T.email);
});
