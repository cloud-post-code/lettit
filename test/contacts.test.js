// import_contacts: members found among an operator's email contacts, with permission. Emails passed by the
// model are matched and dropped; a provider import runs through LETTIT's consent page and the provider's
// OAuth, with the provider stubbed by a local server.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { login } from "./_operators.js";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lettit-contacts-"));
const { freshSchema, sql } = await import("./_db.js");
process.env.DATABASE_URL = (await freshSchema({ cleanup: true })).url;
const dbq = await sql(process.env.DATABASE_URL);
const { server } = await import("../src/server.js");

// The provider stub: token endpoint and Google's two people listings, the first one paged.
const hits = [];
const stub = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  let body = "";
  for await (const c of req) body += c;
  hits.push({ path: u.pathname, query: Object.fromEntries(u.searchParams), body: Object.fromEntries(new URLSearchParams(body)), auth: req.headers.authorization });
  const json = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  if (u.pathname === "/token") return json({ access_token: "tok-1", token_type: "Bearer", expires_in: 3600 });
  if (u.pathname === "/v1/people/me/connections") {
    if (u.searchParams.get("pageToken") === "p2") return json({ connections: [{ emailAddresses: [{ value: "Dan@Acme.dev" }] }] });
    return json({ connections: [{ emailAddresses: [{ value: "stranger@x.io" }] }, { names: [{ displayName: "no email" }] }], nextPageToken: "p2" });
  }
  if (u.pathname === "/v1/otherContacts") return json({ otherContacts: [{ emailAddresses: [{ value: "cara@acme.dev" }, { value: "other@y.io" }] }] });
  res.writeHead(404); res.end("{}");
});

let base, stubBase;
before(async () => {
  await new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); }));
  await new Promise((r) => stub.listen(0, () => { stubBase = `http://localhost:${stub.address().port}`; r(); }));
});
after(() => { server.close(); stub.close(); });

const PW = "test-password-10";
const auth = (key) => (key ? { authorization: `Bearer ${key}` } : {});
const get = (p, key) => fetch(base + p, { headers: auth(key) }).then(async (r) => [r.status, await r.json()]);
const post = (p, b, key) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...auth(key) }, body: JSON.stringify(b) }).then(async (r) => [r.status, await r.json()]);
const page = (p, cookie) => fetch(base + p, { redirect: "manual", headers: cookie ? { cookie } : {} });
const form = (p, fields, cookie) => fetch(base + p, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(fields).toString() });
async function member(email, card = {}) {
  await post("/api/operators", { email, password: PW });
  const [s, a] = await post("/api/agents", { email, password: PW, ...card });
  assert.equal(s, 201, a.error);
  return a;
}
let n = 0;
const rpc = (method, params, key) => fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json", ...auth(key) }, body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method, params }) }).then((r) => r.json());
const call = async (name, args, key) => {
  const { result } = await rpc("tools/call", { name, arguments: args }, key);
  return { error: result.isError === true, text: result.content[0].text, ui: result.structuredContent };
};
const b64 = (buf) => buf.toString("base64url");

let cara, dan, cookie;

test("emails passed in are matched against members and dropped; only the matched ids are kept", async () => {
  cara = await member("cara@acme.dev", { description: "Design." });
  dan = await member("dan@acme.dev", { description: "Ops." });
  await member("eve@gmail.com", { description: "Eve." });
  assert.equal((await post("/api/me/contacts", { emails: ["dan@acme.dev"] }))[0], 401, "anonymous");
  const [s, r] = await post("/api/me/contacts", { emails: ["Dan@Acme.dev ", "nobody@x.io", "cara@acme.dev"] }, cara.key);
  assert.equal(s, 200, r.error);
  assert.equal(r.checked, 3);
  assert.deepEqual(r.matched.map((a) => [a.id, a.why, a.circle]), [["dan", ["in your email contacts"], "colleague"]], "case-insensitive, the caller left out");
  assert.ok(r.matched[0].name && "authority" in r.matched[0]);
  const rows = await dbq("select * from contact_matches");
  assert.deepEqual(rows.map((x) => [x.agent_id, x.match_id, x.source]), [["cara", "dan", "list"]]);
  assert.deepEqual(Object.keys(rows[0]).sort(), ["agent_id", "created", "match_id", "source"], "nothing from the list itself");
  assert.equal((await post("/api/me/contacts", { emails: "dan@acme.dev" }, cara.key))[0], 400, "a list, not a string");
  const [cap, e] = await post("/api/me/contacts", { emails: Array.from({ length: 501 }, (_, i) => `p${i}@x.io`) }, cara.key);
  assert.equal(cap, 400);
  assert.match(e.error, /500/);
  const [, near] = await get("/api/agents?near=1", cara.key);
  assert.equal(near[0].id, "dan");
  assert.ok(near[0].why.includes("in your email contacts"), near[0].why);
  assert.ok(near[0].why.includes("same email domain"));
});

test("without provider credentials the tool and the page say so and point at the emails path", async () => {
  for (const k of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET"]) delete process.env[k];
  const [s, r] = await get("/api/me/contacts", cara.key);
  assert.equal(s, 200, r.error);
  assert.deepEqual(r.providers, []);
  assert.equal(r.url, `${base}/me/contacts`);
  assert.match(r.how, /emails/);
  assert.deepEqual(r.matched.map((a) => a.id), ["dan"], "matches found so far");
  const tool = await call("import_contacts", {}, cara.key);
  assert.equal(tool.error, false, tool.text);
  assert.equal(tool.ui.view, "people");
  assert.deepEqual(tool.ui.agents.map((a) => a.id), ["dan"]);
  assert.equal(tool.ui.url, `${base}/me/contacts`);
  assert.equal((await page("/me/contacts")).status, 302, "signed out: sign in first");
  cookie = await login(base, { email: "cara@acme.dev", password: PW }, "/me/contacts");
  const html = await (await page("/me/contacts", cookie)).text();
  assert.match(html, /no contacts provider/i);
  assert.doesNotMatch(html, /Continue with Google/);
});

test("a provider import: consent page, PKCE authorize redirect, callback that matches and keeps nothing else", async () => {
  process.env.GOOGLE_CLIENT_ID = "gid";
  process.env.GOOGLE_CLIENT_SECRET = "gsecret";
  process.env.CONTACTS_STUB_URL = stubBase;
  const html = await (await page("/me/contacts", cookie)).text();
  assert.match(html, /Continue with Google/);
  for (const phrase of ["email addresses", "compared", "not kept", "ids of the members"]) assert.ok(html.toLowerCase().includes(phrase), phrase);
  const csrf = html.match(/name="csrf" value="([^"]+)"/)[1];
  assert.equal((await form("/me/contacts", { csrf, provider: "yahoo" }, cookie)).status, 400, "unknown provider");

  const go = await form("/me/contacts", { csrf, provider: "google" }, cookie);
  assert.equal(go.status, 302);
  const to = new URL(go.headers.get("location"));
  assert.equal(to.origin + to.pathname, `${stubBase}/o/oauth2/v2/auth`, "Google's authorize URL, on the stub origin");
  const p = Object.fromEntries(to.searchParams);
  assert.equal(p.client_id, "gid");
  assert.equal(p.redirect_uri, `${base}/me/contacts/callback`);
  assert.equal(p.response_type, "code");
  assert.equal(p.code_challenge_method, "S256");
  assert.equal(p.access_type, "online");
  assert.ok(p.state.length >= 32 && p.code_challenge.length >= 40);
  assert.deepEqual(p.scope.split(" ").sort(), ["https://www.googleapis.com/auth/contacts.other.readonly", "https://www.googleapis.com/auth/contacts.readonly"]);
  assert.equal((await dbq("select count(*)::int as n from contact_imports"))[0].n, 1);
  assert.ok(!(await dbq("select * from contact_imports"))[0].state.includes(p.state), "the state is stored hashed");

  assert.equal((await page(`/me/contacts/callback?state=wrong&code=x`, cookie)).status, 400, "unknown state");
  const done = await page(`/me/contacts/callback?state=${p.state}&code=abc`, cookie);
  const out = await done.text();
  assert.equal(done.status, 200, out);
  assert.match(out, /href="\/connect\/dan"/, "the one member among the contacts, with a connect link");
  assert.doesNotMatch(out, /stranger|other@|cara@|acme\.dev/, "no address is shown");
  const token = hits.find((h) => h.path === "/token");
  assert.equal(token.body.code, "abc");
  assert.equal(token.body.client_secret, "gsecret");
  assert.equal(token.body.grant_type, "authorization_code");
  assert.equal(token.body.redirect_uri, `${base}/me/contacts/callback`);
  assert.equal(b64(crypto.createHash("sha256").update(token.body.code_verifier).digest()), p.code_challenge, "PKCE verifier matches the challenge");
  const lists = hits.filter((h) => h.path.startsWith("/v1/"));
  assert.deepEqual(lists.map((h) => [h.path, h.query.pageToken || ""]), [["/v1/people/me/connections", ""], ["/v1/people/me/connections", "p2"], ["/v1/otherContacts", ""]]);
  assert.ok(lists.every((h) => h.auth === "Bearer tok-1"));
  assert.equal((await dbq("select count(*)::int as n from contact_imports"))[0].n, 0, "the import row is gone");
  assert.deepEqual((await dbq("select agent_id, match_id, source from contact_matches order by source")).map((x) => [x.agent_id, x.match_id, x.source]), [["cara", "dan", "google"]], "google replaces the list source for the same match");
  assert.equal((await page(`/me/contacts/callback?state=${p.state}&code=abc`, cookie)).status, 400, "one use");

  const [, r] = await get("/api/me/contacts", cara.key);
  assert.deepEqual(r.providers, ["google"]);
  assert.deepEqual(r.matched.map((a) => [a.id, a.why]), [["dan", ["in your email contacts"]]]);
  const html2 = await (await page("/me/contacts", cookie)).text();
  assert.match(html2, /href="\/connect\/dan"/, "the consent page lists what was found so far");

  // Access refused at the provider: the import row is consumed and the page says so.
  const again = await form("/me/contacts", { csrf, provider: "google" }, cookie);
  const state2 = new URL(again.headers.get("location")).searchParams.get("state");
  const no = await page(`/me/contacts/callback?state=${state2}&error=access_denied`, cookie);
  assert.equal(no.status, 200);
  assert.match(await no.text(), /not granted/i);
  assert.equal((await dbq("select count(*)::int as n from contact_imports"))[0].n, 0);

  // An expired import is refused and swept; a callback with another operator's session is refused.
  await dbq("insert into contact_imports (state, agent_id, provider, verifier, created, expires) values ($1, 'cara', 'google', 'v', now(), now() - interval '1 minute')", [crypto.createHash("sha256").update("old").digest("hex")]);
  assert.equal((await page("/me/contacts/callback?state=old&code=x", cookie)).status, 400, "expired");
  assert.equal((await dbq("select count(*)::int as n from contact_imports"))[0].n, 0, "and gone");
  const third = await form("/me/contacts", { csrf, provider: "google" }, cookie);
  const state3 = new URL(third.headers.get("location")).searchParams.get("state");
  const dansCookie = await login(base, { email: "dan@acme.dev", password: PW }, "/me");
  assert.equal((await page(`/me/contacts/callback?state=${state3}&code=abc`, dansCookie)).status, 403, "someone else's import");
  assert.equal(hits.filter((h) => h.path === "/token").length, 1, "no second exchange");
  delete process.env.CONTACTS_STUB_URL;
});
