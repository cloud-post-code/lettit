import { test, before, after } from "node:test";
import { operator, login, T } from "./_operators.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lettit-console-"));
const FILE = path.join(process.env.DATA_DIR, "board.json");
const { server } = await import("../src/server.js");

let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => server.close());

const auth = (key) => (key ? { authorization: `Bearer ${key}` } : {});
const api = (p, b, key) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...auth(key) }, body: JSON.stringify(b) }).then(async (r) => [r.status, await r.json()]);
const claim = async (name) => (await api("/api/agents", { name, ...(await operator(base)) }))[1].key;
const form = (p, fields, cookie) => fetch(base + p, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(fields).toString() });
const page = (p, cookie) => fetch(base + p, { redirect: "manual", headers: cookie ? { cookie } : {} });
const csrfOf = (html) => html.match(/name="csrf" value="([^"]+)"/)[1];

let ann, bob, cookie, csrf;
test("login sets a hardened cookie, refuses bad passwords, and gates /me", async () => {
  ann = await claim("Ann");
  bob = await claim("Bob");
  const bad = await form("/login", { email: T.email, password: "not-the-password" });
  assert.equal(bad.status, 403);
  assert.equal(bad.headers.get("set-cookie"), null);
  assert.match(await bad.text(), /wrong email or password/);
  const gated = await page("/me");
  assert.equal(gated.status, 302);
  assert.equal(gated.headers.get("location"), "/login?next=%2Fme");
  const ok = await form("/login", T);
  assert.equal(ok.status, 302);
  assert.equal(ok.headers.get("location"), "/me");
  const set = ok.headers.get("set-cookie");
  assert.match(set, /^lettit_session=[A-Za-z0-9_-]+; /);
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Strict/);
  assert.match(set, /Max-Age=2592000/);
  cookie = set.split(";")[0];
  const me = await page("/me", cookie);
  assert.equal(me.status, 200);
  const html = await me.text();
  assert.match(html, /t-ann/);
  assert.match(await page("/me/profile", cookie).then((r) => r.text()), /you: t@x\.io · t-ann/);
  assert.match(html, /name="csrf"/);
  assert.match(html, /my posts/);
  csrf = csrfOf(html);
  assert.ok(!html.includes(ann), "the key never appears on the page");
});

test("the card form needs the CSRF token; every owned agent is in the session; switch changes the viewer", async () => {
  const noToken = await form("/me", { description: "sneaky" }, cookie);
  assert.equal(noToken.status, 403);
  const ok = await form("/me", { csrf, operator: "ann@x.io", contact: "https://ann.x", description: "updated from the console" }, cookie);
  assert.equal(ok.status, 302);
  const card = await fetch(base + "/api/agents/t-ann").then((r) => r.json());
  assert.equal(card.description, "updated from the console");
  assert.equal(card.operator, "ann@x.io");
  const add = await form("/login", T, cookie);
  assert.equal(add.status, 302);
  assert.equal(add.headers.get("set-cookie"), null, "same session, no new cookie");
  let html = await page("/me/profile", cookie).then((r) => r.text());
  assert.match(html, /also yours: .*t-bob/, "the switcher lists the other owned agent");
  const sw = await form("/me/switch", { csrf, agent: "t-bob" }, cookie);
  assert.equal(sw.status, 302);
  html = await page("/me/profile", cookie).then((r) => r.text());
  assert.match(html, /you: t@x\.io · t-bob/);
  const [, stranger] = await (await import("./_operators.js")).claimCard(base, { name: "Zed" }, { email: "zed@x.io", password: "zed-password-10" });
  assert.equal((await form("/me/switch", { csrf, agent: stranger.id }, cookie)).status, 403, "only owned agents");
  await form("/me/switch", { csrf, agent: "t-ann" }, cookie);
});

test("signed-in humans read and write as their agent; API writes with the cookie need the CSRF header", async () => {
  await api("/api/agents/t-ann/connect", { types: ["friend"] }, bob);
  await api("/api/agents/t-bob/accept", { types: ["friend"] }, ann);
  const [, t] = await api("/api/posts", { kind: "status", body: "bobs friends only", audience: "friend" }, bob);
  assert.equal((await page(`/t/${t.id}`)).status, 404, "anonymous cannot see it");
  const asAnn = await page(`/t/${t.id}`, cookie);
  assert.equal(asAnn.status, 200);
  assert.match(await asAnn.text(), /bobs friends only/);
  const viaApi = await fetch(base + `/api/posts/${t.id}`, { headers: { cookie } });
  assert.equal(viaApi.status, 200, "GET /api with the cookie reads as the agent");
  const noCsrf = await fetch(base + "/api/posts", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ kind: "status", body: "from the console" }) });
  assert.equal(noCsrf.status, 401);
  const withCsrf = await fetch(base + "/api/posts", { method: "POST", headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf }, body: JSON.stringify({ kind: "status", body: "from the console" }) });
  assert.equal(withCsrf.status, 201);
  assert.equal((await withCsrf.json()).author, "t-ann");
  const home = await page("/", cookie).then((r) => r.text());
  assert.match(home, /from the console/);
});

test("sessions survive a store reload; rotate shows the key once and keeps the operator signed in; logout clears", async () => {
  const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
  assert.ok(Object.keys(raw.sessions).length >= 1);
  assert.ok(!JSON.stringify(raw.sessions).includes(cookie.split("=")[1]), "only the hash is stored");
  const rot = await form("/me/rotate", { csrf }, cookie);
  assert.equal(rot.status, 200);
  const html = await rot.text();
  const fresh = html.match(/lettit_[0-9a-f]{40}/)[0];
  assert.notEqual(fresh, ann);
  assert.equal((await api("/api/posts", { kind: "status", body: "old key" }, ann))[0], 403);
  assert.equal((await api("/api/posts", { kind: "status", body: "new key" }, fresh))[0], 201);
  assert.equal((await page("/me", cookie)).status, 200, "the operator's session is untouched by a key rotation");
  const c2 = await login(base);
  const out = await form("/logout", { csrf: csrfOf(await page("/me", c2).then((r) => r.text())) }, c2);
  assert.equal(out.status, 302);
  assert.match(out.headers.get("set-cookie"), /Max-Age=0/);
  assert.equal((await page("/me", c2)).status, 302);
});
