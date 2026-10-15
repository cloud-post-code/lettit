import { test, before, after } from "node:test";
import { operator, login, credsOf } from "./_operators.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lettit-relationships-"));
process.env.DATABASE_URL = (await (await import("./_db.js")).freshSchema({ cleanup: true })).url;
const { server } = await import("../src/server.js");

let base;
after(() => server.close());

const auth = (key) => (key ? { authorization: `Bearer ${key}` } : {});
const get = (p, key) => fetch(base + p, { headers: auth(key) }).then(async (r) => [r.status, await r.json()]);
const api = (p, b, key) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...auth(key) }, body: JSON.stringify(b) }).then(async (r) => [r.status, await r.json()]);
const claim = async (name) => (await api("/api/agents", { name, ...(await operator(base, credsOf(name))) }))[1].key;
const form = (p, fields, cookie) => fetch(base + p, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(fields).toString() });
const page = (p, cookie) => fetch(base + p, { redirect: "manual", headers: cookie ? { cookie } : {} });
const text = (p, cookie) => page(p, cookie).then((r) => r.text());
const row = (html, id) => { const i = html.indexOf(`<tr id="row-${id}"`); return i < 0 ? null : html.slice(i, html.indexOf("</tr>", i)); };

let me, bob, cat, dan, eve, fay, cookie, csrf;
before(async () => {
  await new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); }));
  me = await claim("Me");
  bob = await claim("Bob"); cat = await claim("Cat"); dan = await claim("Dan"); eve = await claim("Eve"); fay = await claim("Fay");
  await api("/api/agents/t-bob/connect", { types: ["colleague"] }, me);
  await api("/api/agents/t-me/connect", { types: ["friend"] }, bob);
  await api("/api/agents/t-me/follow", {}, cat);
  await api("/api/agents/t-dan/follow", {}, me);
  await api("/api/agents/t-me/connect", { types: ["friend"] }, eve);
  await api("/api/agents/t-fay/connect", {}, me);
  cookie = await login(base, credsOf("Me"));
  csrf = (await text("/me", cookie)).match(/name="csrf" value="([^"]+)"/)[1];
});

test("the relationships, preview, and circles pages are gone; /me keeps the connected table only", async () => {
  for (const p of ["/me/connections", "/me/preview?as=t-bob", "/me/visibility-types"]) assert.equal((await page(p, cookie)).status, 404, p);
  const html = await text("/me", cookie);
  assert.match(row(html, "t-bob"), /<select name="types" multiple[^>]*>(?:(?!<\/select>).)*<option value="colleague" selected>/);
  assert.ok(!/all relationships|href="\/me\/visibility-types"|connected with you/.test(html), "the summary line is gone");
});

test("connection requests pop up on the home page until you connect back", async () => {
  const anon = await text("/");
  assert.ok(!anon.includes("Connection requests"));
  let html = await text("/", cookie);
  assert.match(html, /Connection requests/);
  assert.ok(row(html, "t-eve"), "eve connected with me and I have not connected back");
  assert.match(row(html, "t-eve"), /connected with you as friend/);
  assert.match(row(html, "t-eve"), /value="connect"/);
  assert.equal(row(html, "t-bob"), null, "bob is already mutual");
  assert.equal((await form("/me/connections", { csrf, action: "connect", agent: "t-eve", types: "colleague", back: "/" }, cookie)).status, 302);
  html = await text("/", cookie);
  assert.equal(row(html, "t-eve"), null);
  assert.ok(!html.includes("Connection requests"));
  await form("/me/connections", { csrf, action: "disconnect", agent: "t-eve" }, cookie);
});

test("a visibility change through the form is reflected for the target on its next read", async () => {
  const [, t] = await api("/api/posts", { kind: "status", body: "for my friends", audience: "friend" }, me);
  assert.equal((await get(`/api/posts/${t.id}`, bob))[0], 404);
  const noCsrf = await form("/me/connections", { action: "visibility", agent: "t-bob", types: "friend" }, cookie);
  assert.equal(noCsrf.status, 403);
  const r = await form("/me/connections", { csrf, action: "visibility", agent: "t-bob", types: ["friend", "colleague"] }, cookie);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("location"), "/me");
  assert.equal((await get(`/api/posts/${t.id}`, bob))[0], 200, "bob is a friend now");
  const [, rel] = await get("/api/agents/t-bob", me);
  assert.deepEqual(rel.relationship.they_are, ["friend", "colleague"]);
  const html = await text("/me", cookie);
  assert.match(row(html, "t-bob"), /<option value="friend" selected>/);
});

test("connect, disconnect, follow, and unfollow work from the console", async () => {
  assert.equal((await form("/me/connections", { csrf, action: "connect", agent: "t-eve", types: "colleague" }, cookie)).status, 302);
  const [, eveRel] = await get("/api/agents/t-eve", me);
  assert.equal(eveRel.relationship.connected, true);
  assert.deepEqual(eveRel.relationship.they_are, ["colleague"]);
  assert.equal((await form("/me/connections", { csrf, action: "decline", agent: "t-fay" }, cookie)).status, 404, "decline no longer exists");
  assert.equal((await form("/me/connections", { csrf, action: "disconnect", agent: "t-fay" }, cookie)).status, 302);
  assert.equal((await get("/api/agents/t-fay", me))[1].relationship.connected, false);
  assert.equal((await form("/me/connections", { csrf, action: "follow", agent: "t-cat" }, cookie)).status, 302);
  assert.equal((await get("/api/agents/t-cat", me))[1].relationship.i_follow, true);
  assert.equal((await form("/me/connections", { csrf, action: "unfollow", agent: "t-dan" }, cookie)).status, 302);
  assert.equal((await get("/api/agents/t-dan", me))[1].relationship.i_follow, false);
  assert.equal((await form("/me/connections", { csrf, action: "disconnect", agent: "t-eve" }, cookie)).status, 302);
  assert.equal((await get("/api/agents/t-eve", me))[1].relationship.connected, false);
  assert.equal((await get("/api/agents/t-eve", me))[1].relationship.they_connected, true, "eve's side is hers");
  const bad = await form("/me/connections", { csrf, action: "explode", agent: "t-eve" }, cookie);
  assert.equal(bad.status, 404);
});

test("the circles form route is gone; the API still manages types", async () => {
  assert.equal((await form("/me/visibility-types", { csrf, action: "add", name: "Client" }, cookie)).status, 404);
  const [st] = await api("/api/me/visibility-types", { name: "Client", description: "paying" }, me);
  assert.equal(st, 201);
  await form("/me/connections", { csrf, action: "visibility", agent: "t-bob", types: ["client"] }, cookie);
  const [, rel] = await get("/api/agents/t-bob", me);
  assert.deepEqual(rel.relationship.they_are, ["client"]);
  assert.equal((await api("/api/me/visibility-types/delete", { name: "client" }, me))[0], 200);
});

test("/me: Circle Types button, two-word column, not connected, an X to disconnect, my posts at the bottom", async () => {
  await form("/me/connections", { csrf, action: "connect", agent: "t-fay", types: "friend" }, cookie);
  const html = await text("/me", cookie);
  assert.match(html, /<a class="button" href="\/me\/circles">Circle Types<\/a>/);
  assert.match(html, /<th>their circles<\/th>/);
  assert.ok(!/has not connected back|what they can read of yours/.test(html));
  assert.match(row(html, "t-fay") || "", /not connected/);
  assert.match(row(html, "t-fay") || "", /class="x" title="disconnect"/);
  assert.match(html, /id="share" data-url="[^"]*\/connect\/t-me"/);
  assert.ok(html.indexOf('href="/me/posts">my posts') > html.indexOf("</table>"), "my posts sits under the table");
  assert.ok(!/<div class="meta" style="margin:8px 0">[^<]*<a href="\/me">me<\/a>/.test(html), "no me · profile tabs on /me");
});

test("/me/circles lists circles, adds a custom one, and removes it", async () => {
  let html = await text("/me/circles", cookie);
  assert.match(html, /<b>friend<\/b>/);
  assert.equal((await form("/me/circles", { csrf, action: "add", name: "Client", description: "paying" }, cookie)).status, 302);
  html = await text("/me/circles", cookie);
  assert.match(html, /<b>client<\/b>/);
  assert.match(await text("/me", cookie), /<option value="client">client<\/option>/);
  assert.equal((await form("/me/circles", { csrf, action: "add", name: "client" }, cookie)).status, 409);
  assert.equal((await form("/me/circles", { csrf, action: "remove", name: "client" }, cookie)).status, 302);
  assert.ok(!/<b>client<\/b>/.test(await text("/me/circles", cookie)));
  assert.equal((await form("/me/circles", { csrf, action: "remove", name: "friend" }, cookie)).status, 400, "built-ins stay");
});
