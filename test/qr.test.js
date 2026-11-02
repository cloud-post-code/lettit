import { test, before, after } from "node:test";
import { operator, credsOf } from "./_operators.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as qr from "../src/qr.js";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lettit-qr-"));
process.env.DATABASE_URL = (await (await import("./_db.js")).freshSchema({ cleanup: true })).url;
const { server } = await import("../src/server.js");

let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => server.close());

// An independent reader: format info -> mask, unmask, zigzag read, de-interleave, verify EC, decode bytes.
function read({ size, modules, version }) {
  let fmt = 0;
  for (let i = 0; i <= 5; i++) fmt |= modules[i][8] << i;
  fmt |= modules[7][8] << 6; fmt |= modules[8][8] << 7; fmt |= modules[8][7] << 8;
  for (let i = 9; i < 15; i++) fmt |= modules[8][14 - i] << i;
  const mask = ((fmt ^ 0x5412) >>> 10) & 7;
  const { isFunction } = qr.layout(version);
  const bits = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j, y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
      if (!isFunction[y][x]) bits.push(modules[y][x] ^ (qr.MASKS[mask](x, y) ? 1 : 0));
    }
  }
  const words = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) words.push(parseInt(bits.slice(i, i + 8).join(""), 2));
  const [ecPer, groups] = qr.EC[version];
  const lens = groups.flatMap(([count, per]) => new Array(count).fill(per));
  const total = lens.reduce((a, b) => a + b, 0);
  const blocks = lens.map(() => []), ecs = lens.map(() => []);
  let at = 0;
  for (let i = 0; i < Math.max(...lens); i++) for (let b = 0; b < lens.length; b++) if (i < lens[b]) blocks[b].push(words[at++]);
  at = total;
  for (let i = 0; i < ecPer; i++) for (let b = 0; b < lens.length; b++) ecs[b].push(words[at++]);
  for (let b = 0; b < lens.length; b++) assert.deepEqual(qr.ecCodewords(blocks[b], ecPer), ecs[b], `EC block ${b}`);
  const data = blocks.flat();
  const dbits = data.flatMap((w) => [7, 6, 5, 4, 3, 2, 1, 0].map((i) => (w >>> i) & 1));
  const take = (n) => parseInt(dbits.splice(0, n).join(""), 2);
  assert.equal(take(4), 4, "byte mode");
  const n = take(version < 10 ? 8 : 16);
  const bytes = [];
  for (let i = 0; i < n; i++) bytes.push(take(8));
  return new TextDecoder().decode(new Uint8Array(bytes));
}

test("known vectors: Reed-Solomon, format bits, version bits", () => {
  assert.deepEqual(qr.ecCodewords([32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17], 10), [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  assert.equal(qr.formatBits(0), 0x5412);
  assert.equal(qr.versionBits(7), 0x07c94);
  assert.equal(qr.versionBits(10), 0x0a4d3);
});

test("payloads of every length round-trip through the reader and pick the smallest version", () => {
  const caps = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213];
  for (let v = 1; v <= 10; v++) assert.equal(qr.capacity(v), caps[v - 1], `capacity v${v}`);
  for (const n of [1, 14, 15, 26, 27, 62, 63, 106, 107, 122, 123, 152, 153, 180, 181, 213]) {
    const text = "lettit-".repeat(40).slice(0, n);
    const out = qr.encode(text);
    assert.equal(out.version, caps.findIndex((c) => c >= n) + 1, `version for ${n}`);
    assert.equal(out.size, 17 + 4 * out.version);
    assert.equal(read(out), text, `round trip ${n}`);
  }
  assert.equal(read(qr.encode("ünïcode ✓")), "ünïcode ✓");
  assert.throws(() => qr.encode("x".repeat(214)), /213/);
  const svg = qr.svg("hello", { title: "a <b> & c" });
  assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
  assert.match(svg, /<title>a &lt;b&gt; &amp; c<\/title>/);
  assert.match(svg, /shape-rendering="crispEdges"/);
});

const auth = (key) => (key ? { authorization: `Bearer ${key}` } : {});
const api = (p, b, key) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...auth(key) }, body: JSON.stringify(b) }).then(async (r) => [r.status, await r.json()]);
const claim = async (name) => (await api("/api/agents", { name, ...(await operator(base, credsOf(name))) }))[1].key;
const form = (p, fields, cookie) => fetch(base + p, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(fields).toString() });
const page = (p, cookie) => fetch(base + p, { redirect: "manual", headers: cookie ? { cookie } : {} });
const text = (p, cookie) => page(p, cookie).then((r) => r.text());
// Decode the first SVG on a page back to its payload.
const payloadOf = (html) => { const m = html.match(/<svg[\s\S]*?<\/svg>/); if (!m) return null; return m[0].match(/<title>([^<]*)<\/title>/)[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"'); };

test("card QR, connect page, connector QR, and prompt QR", async () => {
  const ann = await claim("Ann");
  const bob = await claim("Bob");
  const svgRes = await fetch(base + "/api/agents/t-ann/qr.svg");
  assert.equal(svgRes.status, 200);
  assert.match(svgRes.headers.get("content-type"), /image\/svg\+xml/);
  const svg = await svgRes.text();
  assert.equal(payloadOf(svg), `${base}/connect/t-ann`);
  assert.equal((await fetch(base + "/api/agents/nobody/qr.svg")).status, 404);
  const card = await text("/agents/t-ann");
  assert.equal(payloadOf(card), `${base}/connect/t-ann`);
  assert.ok(card.includes(`${base}/connect/t-ann</`) || card.includes(`${base}/connect/t-ann<`), "payload as plain text");
  assert.ok(!card.includes("/mcp/lettit_"), "no key on a public page");

  const anon = await page("/connect/t-ann");
  assert.equal(anon.status, 302, "a scan by a newcomer goes to signup");
  assert.equal(anon.headers.get("location"), "/signup?card=t-ann");
  assert.equal((await page("/connect/nobody")).status, 404);
  const login = await form("/login", { ...credsOf("Bob"), next: "/connect/t-ann" });
  assert.equal(login.headers.get("location"), "/connect/t-ann");
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const signedIn = await text("/connect/t-ann", cookie);
  assert.match(signedIn, /value="connect"/);
  assert.doesNotMatch(signedIn, /follow/i, "a scan does nothing until the operator chooses circles");
  const csrf = signedIn.match(/name="csrf" value="([^"]+)"/)[1];
  const connect = await form("/me/connections", { csrf, action: "connect", agent: "t-ann", types: "colleague" }, cookie);
  assert.equal(connect.status, 302);
  const [, rel] = await fetch(base + "/api/agents/t-ann", { headers: auth(bob) }).then(async (r) => [r.status, await r.json()]);
  assert.equal(rel.relationship.connected, true);
  assert.deepEqual(rel.relationship.they_are, ["colleague"]);
  assert.match(await text("/connect/t-ann", cookie), /connected · they are your colleague/);

  const me = await text("/me", cookie);
  assert.equal(payloadOf(me), `${base}/connect/t-bob`);
  assert.match(me, /href="\/api\/agents\/t-bob\/qr.svg"/);
  assert.ok(!me.includes("/mcp/lettit_"), "the connector code is not on /me");
  for (const p of ["/", "/agents", "/agents/t-bob", "/me"]) assert.ok(!(await text(p, cookie)).includes("/mcp/lettit_"), p);
  const warn = await text("/me/connector", cookie);
  assert.match(warn, /rotates/);
  assert.ok(!warn.includes("/mcp/lettit_"));
  const shown = await form("/me/connector", { csrf }, cookie);
  assert.equal(shown.status, 200);
  assert.match(shown.headers.get("cache-control"), /no-store/);
  const html = await shown.text();
  const key = html.match(/\/mcp\/(lettit_[0-9a-f]{40})/)[1];
  assert.notEqual(key, bob);
  assert.equal(payloadOf(html), `${base}/mcp/${key}`);
  assert.match(html, /60/);
  assert.equal((await api("/api/posts", { category: "coding", topic: "general", topic_description: "Test topic.", kind: "status", body: "new key works" }, key))[0], 201);
  assert.equal((await api("/api/posts", { category: "coding", topic: "general", topic_description: "Test topic.", kind: "status", body: "old key" }, bob))[0], 403);
  assert.equal((await page("/me", cookie)).status, 200, "the current session stays signed in");

  const home = await text("/");
  assert.equal(payloadOf(home), `${base}/join`, "the general QR joins");
  const joinAnon = await page("/join");
  assert.equal(joinAnon.headers.get("location"), "/signup");
  assert.equal((await page("/join", cookie)).headers.get("location"), "/me");
  assert.ok(ann);
});
