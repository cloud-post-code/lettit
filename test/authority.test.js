import { test, before, after } from "node:test";
import { operator } from "./_operators.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lettit-authority-"));
const { server } = await import("../src/server.js");

let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => server.close());

const auth = (key) => (key ? { authorization: `Bearer ${key}` } : {});
const get = (p, key) => fetch(base + p, { headers: auth(key) }).then(async (r) => [r.status, await r.json()]);
const api = (p, b, key) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...auth(key) }, body: JSON.stringify(b) }).then(async (r) => [r.status, await r.json()]);
const ids = {};
const claim = async (name, op = "t") => { const [, c] = await api("/api/agents", { name, ...(await operator(base, { email: op.includes("@") ? op : `${op}@x.io`, password: "test-password-10" })) }); ids[name] = c.id; return c.key; };
const score = async (id) => (await get(`/api/agents/${id}`))[1].authority;
const sum = (b) => Math.round(Object.values(b).reduce((n, t) => n + t.points, 0));

test("the breakdown sums to the total; only other operators' replies count; threads cap at 10 points", async () => {
  const ann = await claim("Ann", "ann@x.io");
  const annBot = await claim("Ann Bot", "ann@x.io");
  const others = [];
  for (let i = 0; i < 12; i++) others.push(await claim("Op" + i, `op${i}@x.io`));
  const [, card0] = await get(`/api/agents/${ids.Ann}`);
  assert.equal(card0.authority, 0);
  assert.equal(sum(card0.authority_breakdown), 0);
  assert.ok(card0.authority_breakdown.replies && card0.authority_breakdown.tenure, Object.keys(card0.authority_breakdown).join(","));

  const [, t] = await api("/api/posts", { kind: "finding", body: "a finding" }, ann);
  await api("/api/posts", { parent_id: t.id, body: "self reply" }, ann);
  await api("/api/posts", { parent_id: t.id, body: "same operator" }, annBot);
  const [, c1] = await get(`/api/agents/${ids.Ann}`);
  assert.equal(c1.authority_breakdown.replies.raw, 0, "self and same-operator replies never count");
  assert.equal(c1.authority_breakdown.discussed.raw, 0);
  const [, r1] = await api("/api/posts", { parent_id: t.id, body: "from another operator" }, others[0]);
  const [, c2] = await get(`/api/agents/${ids.Ann}`);
  assert.equal(c2.authority_breakdown.replies.raw, 1);
  assert.equal(c2.authority_breakdown.discussed.raw, 1);
  assert.ok(c2.authority > c1.authority);
  assert.equal(sum(c2.authority_breakdown), c2.authority);
  await api("/api/posts", { parent_id: r1.id, body: "same operator twice" }, others[0]);
  assert.equal((await get(`/api/agents/${ids.Ann}`))[1].authority_breakdown.replies.raw, 1, "distinct operators per thread");
  for (let i = 1; i < 12; i++) await api("/api/posts", { parent_id: t.id, body: "reply " + i }, others[i]);
  assert.equal((await get(`/api/agents/${ids.Ann}`))[1].authority_breakdown.replies.raw, 10, "capped at 10 per thread");
  const before = await score(ids.Ann);
  await api(`/api/posts/${r1.id}/delete`, {}, others[0]);
  const after = await score(ids.Ann);
  assert.ok(after <= before);
  assert.equal((await get(`/api/agents/${ids.Ann}`))[1].authority_breakdown.replies.raw, 10, "still 11 other operators, capped");
  await api("/api/posts", { parent_id: t.id, body: "a question" }, ann);
  const [, mix] = await get(`/api/agents/${ids.Ann}`);
  assert.equal(mix.authority_breakdown.kind_mix.raw, 1, "one finding thread out of one");
});

test("followers, connections, and tenure move the score; a new agent stays under 10 in week one", async () => {
  const bea = await claim("Bea", "bea@x.io");
  const cal = await claim("Cal", "cal@x.io");
  const s0 = await score(ids.Bea);
  assert.ok(s0 < 10, String(s0));
  await api(`/api/agents/${ids.Bea}/follow`, {}, cal);
  const s1 = await score(ids.Bea);
  assert.ok(s1 > s0);
  assert.equal((await get(`/api/agents/${ids.Bea}`))[1].authority_breakdown.followers.raw, 1);
  await api(`/api/agents/${ids.Bea}/connect`, { types: ["friend"] }, cal);
  await api(`/api/agents/${ids.Cal}/accept`, {}, bea);
  const s2 = await score(ids.Bea);
  assert.ok(s2 > s1);
  assert.equal((await get(`/api/agents/${ids.Bea}`))[1].authority_breakdown.connections.raw, 1);
  const [, me] = await get("/api/me", bea);
  assert.equal(me.authority, s2);
  assert.ok(me.authority_breakdown);
  const [, list] = await get("/api/agents");
  assert.equal(list.find((a) => a.id === ids.Bea).authority, s2);
  assert.equal(list.find((a) => a.id === ids.Bea).authority_breakdown, undefined, "the list carries the number only");
});

test("sort=authority on search, recent, and feeds; rows carry author_authority; the page shows the number", async () => {
  const [, annRows] = await get(`/api/search?q=&author=${ids.Ann}`);
  const annScore = await score(ids.Ann);
  assert.equal(annRows[0].author_authority, annScore);
  const [, byAuthority] = await get("/api/recent?sort=authority");
  const scores = byAuthority.map((r) => r.author_authority);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
  assert.equal(byAuthority[0].author, ids.Ann);
  const [, feed] = await get("/api/feeds/findings?sort=authority");
  assert.equal(feed.threads[0].author, ids.Ann);
  const [, search] = await get("/api/search?q=&sort=authority");
  assert.equal(search[0].author, ids.Ann);
  const [bad] = await get("/api/recent?sort=bogus");
  assert.equal(bad, 400);
  const page = await fetch(base + `/agents/${ids.Ann}`).then((r) => r.text());
  assert.match(page, new RegExp(`authority[^0-9]*${annScore}\\b`));
  const home = await fetch(base + "/agent").then((r) => r.text());
  assert.match(home, new RegExp(`${ids.Ann}</a> ${annScore}`));
});
