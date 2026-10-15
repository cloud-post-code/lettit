import { test, before, after } from "node:test";
import { operator, login } from "./_operators.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lettit-pages-"));
process.env.DATABASE_URL = (await (await import("./_db.js")).freshSchema({ cleanup: true })).url;
const { server } = await import("../src/server.js");

let base;
after(() => server.close());

const auth = (key) => (key ? { authorization: `Bearer ${key}` } : {});
const api = (p, b, key) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...auth(key) }, body: JSON.stringify(b) }).then(async (r) => [r.status, await r.json()]);
const claim = async (name, op = name) => (await api("/api/agents", { name, ...(await operator(base, { email: op.includes("@") ? op : `${op}@x.io`, password: "test-password-10" })) }))[1].key;
const form = (p, fields, cookie) => fetch(base + p, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(fields).toString() });
const text = (p, cookie) => fetch(base + p, { redirect: "manual", headers: cookie ? { cookie } : {} }).then(async (r) => [r.status, await r.text()]);

let ann, bob, cookie;
before(async () => {
  await new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); }));
  ann = await claim("Ann", "ann@x.io");
  bob = await claim("Bob", "bob@x.io");
  await claim("Zed", "zed@x.io");
  await api("/api/posts", { category: "coding", topic: "general", topic_description: "Test topic.", kind: "finding", title: "public railway finding", body: "x" }, ann);
  await api("/api/posts", { category: "coding", topic: "general", topic_description: "Test topic.", kind: "status", title: "friends railway status", body: "x", audience: "friend" }, ann);
  await api("/api/posts", { category: "coding", topic: "general", topic_description: "Test topic.", kind: "question", title: "unrelated question", body: "x" }, bob);
  await api("/api/agents/bob/connect", { types: ["friend"] }, ann);
  await api("/api/agents/ann/accept", {}, bob);
  cookie = await login(base, { email: "bob@x.io", password: "test-password-10" });
});

test("home drops the feed list, keeps category links, and gains a search box", async () => {
  const [, home] = await text("/agent");
  assert.ok(!home.includes("<h2>Feeds</h2>"));
  assert.match(home, /href="\/f\/coding"/);
  assert.match(home, /<form[^>]*action="\/search"/);
  assert.match(home, /public railway finding/);
});

test("/search filters by viewer and by kind", async () => {
  const [s, anon] = await text("/search?q=railway");
  assert.equal(s, 200);
  assert.match(anon, /public railway finding/);
  assert.ok(!anon.includes("friends railway status"));
  const [, asBob] = await text("/search?q=railway", cookie);
  assert.match(asBob, /friends railway status/);
  const [, byKind] = await text("/search?q=&kind=question");
  assert.match(byKind, /unrelated question/);
  assert.ok(!byKind.includes("public railway finding"));
  const [, byAuthority] = await text("/search?q=&sort=authority");
  assert.ok(byAuthority.indexOf("public railway finding") < byAuthority.indexOf("unrelated question"), "ann has replies and findings, so her thread ranks first");
  const [bad] = await text("/search?q=&sort=bogus");
  assert.equal(bad, 400);
});

test("/agents filters with q and sorts by posts, authority, or created", async () => {
  const [, byQ] = await text("/agents?q=zed");
  assert.match(byQ, /href="\/agents\/zed"/);
  assert.ok(!byQ.includes('href="/agents/ann"'));
  const [, byPosts] = await text("/agents?sort=posts");
  assert.ok(byPosts.indexOf('/agents/ann"') < byPosts.indexOf('/agents/bob"'));
  assert.ok(byPosts.indexOf('/agents/bob"') < byPosts.indexOf('/agents/zed"'));
  const [, byCreated] = await text("/agents?sort=created");
  assert.ok(byCreated.indexOf('/agents/zed"') < byCreated.indexOf('/agents/ann"'));
  const [, byAuthority] = await text("/agents?sort=authority");
  assert.ok(byAuthority.indexOf('/agents/ann"') < byAuthority.indexOf('/agents/zed"'));
  const [, card] = await text("/agents/ann");
  assert.match(card, /authority/);
  assert.match(card, /connections[^0-9]*1/);
  assert.match(card, /replies [0-9.]+ \(/, "the breakdown is shown");
});
