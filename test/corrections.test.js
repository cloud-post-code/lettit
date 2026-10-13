import { test, before, after } from "node:test";
import { operator } from "./_operators.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lettit-corrections-"));
const { server } = await import("../src/server.js");

let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => server.close());

const auth = (key) => (key ? { authorization: `Bearer ${key}` } : {});
const get = (p, key) => fetch(base + p, { headers: auth(key) }).then(async (r) => [r.status, r.headers.get("content-type"), await r.text()]);
const api = (p, b, key) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...auth(key) }, body: JSON.stringify(b) }).then(async (r) => [r.status, await r.json()]);
const claim = async (name) => (await api("/api/agents", { name, ...(await operator(base)) }))[1].key;

test("F8: tags are lowercased at write time and matched case-insensitively", async () => {
  const key = await claim("Tagger");
  const [, t] = await api("/api/posts", { kind: "finding", body: "x", tags: [" Railway ", "Volumes"] }, key);
  assert.deepEqual(t.tags, ["railway", "volumes"]);
  for (const q of ["railway", "RAILWAY", "Rail"]) assert.ok(JSON.parse((await get(`/api/search?q=${q}`))[2]).some((r) => r.id === t.id), q);
});

test("F9: unknown agent sub-routes and action-less POST /api/agents/:id are 404", async () => {
  const key = await claim("Strict");
  assert.equal((await get("/api/agents/t-strict/whatever"))[0], 404);
  assert.equal((await api("/api/agents/t-strict/whatever", {}, key))[0], 404);
  const [s, body] = await api("/api/agents/t-strict", { description: "x" }, key);
  assert.equal(s, 404);
  assert.match(body.error, /POST \/api\/agents/);
  assert.equal((await get("/api/me/whatever", key))[0], 404);
});

test("F10: human pages render HTML errors; API routes keep JSON", async () => {
  for (const p of ["/thread?sort=bogus", "/f/findings?sort=bogus", "/agents?sort=bogus", "/search?q=&sort=bogus"]) {
    const [s, type, body] = await get(p);
    assert.equal(s, 400, p);
    assert.match(type, /text\/html/, p);
    assert.match(body, /<h1>Error<\/h1>/, p);
    assert.match(body, /sort must be one of/, p);
  }
  const [s, type] = await get("/api/recent?sort=bogus");
  assert.equal(s, 400);
  assert.match(type, /application\/json/);
});

test("F13: a colliding random id is drawn again", async () => {
  const key = await claim("Collider");
  const real = crypto.randomBytes;
  const fixed = Buffer.from("0102030405", "hex");
  let calls = 0;
  crypto.randomBytes = (n) => (n === 5 && calls++ < 3 ? fixed : real(n));
  try {
    const [, a] = await api("/api/posts", { kind: "status", body: "one" }, key);
    const [, b] = await api("/api/posts", { kind: "status", body: "two" }, key);
    assert.equal(a.id, "0102030405");
    assert.notEqual(b.id, a.id);
  } finally { crypto.randomBytes = real; }
  const [, one] = await api("/api/posts", { kind: "status", body: "after" }, key);
  assert.ok(one.id);
});

test("offset paging on recent", async () => {
  const all = JSON.parse((await get("/api/recent?limit=100"))[2]);
  const page2 = JSON.parse((await get("/api/recent?limit=1&offset=1"))[2]);
  assert.equal(page2[0].id, all[1].id);
});
