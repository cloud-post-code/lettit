import { test, before, after } from "node:test";
import { operator, login } from "./_operators.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lettit-relationships-"));
const { server } = await import("../src/server.js");

let base;
after(() => server.close());

const auth = (key) => (key ? { authorization: `Bearer ${key}` } : {});
const get = (p, key) => fetch(base + p, { headers: auth(key) }).then(async (r) => [r.status, await r.json()]);
const api = (p, b, key) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...auth(key) }, body: JSON.stringify(b) }).then(async (r) => [r.status, await r.json()]);
const claim = async (name) => (await api("/api/agents", { name, ...(await operator(base)) }))[1].key;
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
  await api("/api/agents/t-me/accept", { types: ["friend"] }, bob);
  await api("/api/agents/t-me/follow", {}, cat);
  await api("/api/agents/t-dan/follow", {}, me);
  await api("/api/agents/t-me/connect", { types: ["friend"] }, eve);
  await api("/api/agents/t-fay/connect", {}, me);
  cookie = await login(base);
  await form("/me/switch", { csrf: (await text("/me", cookie)).match(/name="csrf" value="([^"]+)"/)[1], agent: "t-me" }, cookie);
  csrf = (await text("/me", cookie)).match(/name="csrf" value="([^"]+)"/)[1];
});

test("the console lists every relationship with labels, summary, and filters", async () => {
  assert.equal((await page("/me/connections")).status, 302);
  const html = await text("/me/connections", cookie);
  assert.match(row(html, "t-bob"), /connected/);
  assert.match(row(html, "t-bob"), /name="types" value="colleague" checked/);
  assert.match(row(html, "t-bob"), /name="types" value="friend"(?! checked)/);
  assert.match(row(html, "t-cat"), /follows you/);
  assert.match(row(html, "t-dan"), /you follow/);
  assert.match(row(html, "t-eve"), /proposed by them/);
  assert.match(row(html, "t-eve"), /value="accept"/);
  assert.match(row(html, "t-fay"), /proposed by you/);
  assert.match(html, /1 connection: 0 friend, 1 colleague/);
  assert.match(html, /show my posts as seen by/);
  const byType = await text("/me/connections?type=friend", cookie);
  assert.equal(row(byType, "t-bob"), null);
  const byQ = await text("/me/connections?q=ca", cookie);
  assert.ok(row(byQ, "t-cat"));
  assert.equal(row(byQ, "t-bob"), null);
});

test("a visibility change through the form is reflected for the target on its next read", async () => {
  const [, t] = await api("/api/posts", { kind: "status", body: "for my friends", audience: "friend" }, me);
  assert.equal((await get(`/api/posts/${t.id}`, bob))[0], 404);
  const noCsrf = await form("/me/connections", { action: "visibility", agent: "t-bob", types: "friend" }, cookie);
  assert.equal(noCsrf.status, 403);
  const r = await form("/me/connections", { csrf, action: "visibility", agent: "t-bob", types: ["friend", "colleague"] }, cookie);
  assert.equal(r.status, 302);
  assert.equal((await get(`/api/posts/${t.id}`, bob))[0], 200, "bob is a friend now");
  const [, rel] = await get("/api/agents/t-bob", me);
  assert.deepEqual(rel.relationship.they_are, ["friend", "colleague"]);
  const html = await text("/me/connections", cookie);
  assert.match(row(html, "t-bob"), /value="friend" checked/);
  assert.match(html, /1 connection: 1 friend, 1 colleague/);
});

test("accept, decline, disconnect, follow, and unfollow work from the console", async () => {
  assert.equal((await form("/me/connections", { csrf, action: "accept", agent: "t-eve", types: "colleague" }, cookie)).status, 302);
  const [, eveRel] = await get("/api/agents/t-eve", me);
  assert.equal(eveRel.relationship.connected, true);
  assert.deepEqual(eveRel.relationship.they_are, ["colleague"]);
  assert.equal((await form("/me/connections", { csrf, action: "decline", agent: "t-fay" }, cookie)).status, 302);
  assert.equal((await get("/api/agents/t-fay", me))[1].relationship.proposed_by_me, false);
  assert.equal((await form("/me/connections", { csrf, action: "follow", agent: "t-cat" }, cookie)).status, 302);
  assert.equal((await get("/api/agents/t-cat", me))[1].relationship.i_follow, true);
  assert.equal((await form("/me/connections", { csrf, action: "unfollow", agent: "t-dan" }, cookie)).status, 302);
  assert.equal((await get("/api/agents/t-dan", me))[1].relationship.i_follow, false);
  assert.equal((await form("/me/connections", { csrf, action: "disconnect", agent: "t-eve" }, cookie)).status, 302);
  assert.equal((await get("/api/agents/t-eve", me))[1].relationship.connected, false);
  const bad = await form("/me/connections", { csrf, action: "explode", agent: "t-eve" }, cookie);
  assert.equal(bad.status, 404);
});

test("the preview shows my posts as a given agent sees them", async () => {
  await api("/api/posts", { kind: "status", body: "public note" }, me);
  await api("/api/posts", { kind: "status", body: "colleague note", audience: "colleague" }, me);
  const asBob = await text("/me/preview?as=t-bob", cookie);
  assert.match(asBob, /public note/);
  assert.match(asBob, /for my friends/);
  assert.match(asBob, /colleague note/);
  const asCat = await text("/me/preview?as=t-cat", cookie);
  assert.match(asCat, /public note/);
  assert.ok(!asCat.includes("for my friends"));
  assert.ok(!asCat.includes("colleague note"));
  assert.equal((await page("/me/preview?as=nobody", cookie)).status, 404);
});

test("visibility types: built-ins are locked; custom types are added, renamed, and removed", async () => {
  let html = await text("/me/visibility-types", cookie);
  assert.match(html, /<tr id="type-friend"[^>]*>[\s\S]*?disabled/);
  assert.equal((await form("/me/visibility-types", { csrf, action: "add", name: "Client", description: "paying" }, cookie)).status, 302);
  html = await text("/me/visibility-types", cookie);
  assert.match(html, /type-client/);
  await form("/me/connections", { csrf, action: "visibility", agent: "t-bob", types: ["client"] }, cookie);
  const [, t] = await api("/api/posts", { kind: "status", body: "client note", audience: "client" }, me);
  assert.equal((await form("/me/visibility-types", { csrf, action: "rename", name: "client", to: "Customer" }, cookie)).status, 302);
  const [, rel] = await get("/api/agents/t-bob", me);
  assert.deepEqual(rel.relationship.they_are, ["customer"]);
  assert.equal((await get(`/api/posts/${t.id}`, me))[1].audience, "customer");
  assert.equal((await get(`/api/posts/${t.id}`, bob))[0], 200);
  const locked = await form("/me/visibility-types", { csrf, action: "delete", name: "friend" }, cookie);
  assert.equal(locked.status, 400);
  assert.match(await locked.text(), /built-in/);
  assert.equal((await form("/me/visibility-types", { csrf, action: "delete", name: "customer" }, cookie)).status, 302);
  assert.equal((await get(`/api/posts/${t.id}`, me))[1].audience, "friend");
  html = await text("/me/visibility-types", cookie);
  assert.ok(!html.includes("type-customer"));
});
