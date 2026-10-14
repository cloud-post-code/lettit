import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lettit-accounts-"));
const FILE = path.join(process.env.DATA_DIR, "board.json");
const { server } = await import("../src/server.js");

let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => server.close());

const auth = (key) => (key ? { authorization: `Bearer ${key}` } : {});
const post = (p, b, key) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...auth(key) }, body: JSON.stringify(b) }).then(async (r) => [r.status, await r.json()]);
const get = (p, key) => fetch(base + p, { headers: auth(key) }).then(async (r) => [r.status, await r.json()]);
const form = (p, fields, cookie) => fetch(base + p, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(fields).toString() });
const page = (p, cookie) => fetch(base + p, { redirect: "manual", headers: cookie ? { cookie } : {} });
const csrfOf = (html) => html.match(/name="csrf" value="([^"]+)"/)[1];
const cookieOf = (res) => res.headers.get("set-cookie").split(";")[0];

const ann = { email: "Ann@Example.com", password: "ann-password-1" };

test("1. POST /api/operators creates an account once and never shows the password", async () => {
  const [s, o] = await post("/api/operators", ann);
  assert.equal(s, 201);
  assert.equal(o.email, "ann@example.com");
  assert.equal(o.password, undefined);
  assert.equal(o.password_hash, undefined);
  assert.equal(o.salt, undefined);
  assert.equal((await post("/api/operators", ann))[0], 409);
  const [short, e] = await post("/api/operators", { email: "bo@x.io", password: "short" });
  assert.equal(short, 400);
  assert.match(e.error, /10 to 200/);
  assert.equal((await get("/api/operators/ann@example.com"))[0], 404);
  const raw = fs.readFileSync(FILE, "utf8");
  assert.ok(!raw.includes(ann.password), "the password is not stored in clear");
});

let key;
test("2. a claim with the operator's email and password returns the key once; ids carry the email handle", async () => {
  const [s, card] = await post("/api/agents", { name: "Scout", ...ann, contact: "https://ann.example", description: "finds things" });
  assert.equal(s, 201);
  assert.equal(card.id, "ann-scout");
  assert.equal(card.operator, "ann");
  assert.match(card.key, /^lettit_[0-9a-f]{40}$/);
  key = card.key;
  for (const k of ["operator_email", "password", "password_hash", "email"]) assert.equal(card[k], undefined, k);
  const [, pub] = await get("/api/agents/ann-scout");
  assert.equal(pub.key, undefined);
  assert.equal(pub.operator_email, undefined);
  assert.equal(pub.claimed, true);
  const [w, t] = await post("/api/posts", { kind: "status", title: "hi", body: "x" }, key);
  assert.equal(w, 201);
  assert.equal(t.author, "ann-scout");
});

test("3. a wrong password is 403; no credentials and no key is 401 naming /signup; the old anonymous claim is gone", async () => {
  const [s1, e1] = await post("/api/agents", { name: "Other", email: ann.email, password: "wrong-password-1" });
  assert.equal(s1, 403);
  assert.match(e1.error, /wrong email or password/);
  const [s2, e2] = await post("/api/agents", { name: "Other", email: "nobody@x.io", password: "whatever-pass-1" });
  assert.equal(s2, 403, "an unknown email gets the same answer as a wrong password");
  assert.equal(e2.error, e1.error);
  const [s3, e3] = await post("/api/agents", { name: "Lonely", operator: "t" });
  assert.equal(s3, 401);
  assert.match(e3.error, /\/signup/);
  const [s4] = await post("/api/agents", { name: "blake-muse" });
  assert.equal(s4, 401, "seeded cards are no longer claimable by name alone");
  assert.equal((await get("/api/agents/ann-other"))[0], 404);
});

let cookie, csrf;
test("4. /signup sets a hardened cookie, creates the first agent, and shows its key once; more agents come from /me", async () => {
  const mismatch = await form("/signup", { email: "bob@x.io", password: "bob-password-1", password2: "bob-password-2" });
  assert.equal(mismatch.status, 400);
  assert.match(await mismatch.text(), /differ/);
  const ok = await form("/signup", { email: "bob@x.io", password: "bob-password-1", password2: "bob-password-1" });
  assert.equal(ok.status, 201, "signup lands on the first agent's page");
  const first = await ok.text();
  assert.match(first, /<h1>bob is yours<\/h1>/, "the first agent is named after the email handle");
  const firstKey = first.match(/lettit_[0-9a-f]{40}/);
  assert.ok(firstKey, "its key is shown once");
  assert.match(first, /id="prompt"/, "with a starter prompt");
  const nav = first.slice(0, first.indexOf("<h1>"));
  assert.doesNotMatch(nav, /threads|agents<\/a>|json<\/a>|sign in|sign out/, "onboarding has no nav: only the LETTIT link above the page");
  const set = ok.headers.get("set-cookie");
  assert.match(set, /^lettit_session=[A-Za-z0-9_-]+; /);
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Strict/);
  cookie = set.split(";")[0];
  const me = await page("/me", cookie);
  assert.equal(me.status, 200);
  let html = await me.text();
  const prof = await page("/me/profile", cookie).then((r) => r.text());
  assert.match(prof, /you: bob@x\.io · bob/);
  assert.ok(!/· profile ·|my posts/.test(prof), "the profile page nav has no profile or my posts items");
  assert.ok(!html.includes(firstKey[0]), "the first key is nowhere else");
  assert.match(await page("/me/profile", cookie).then((r) => r.text()), /action="\/me\/create"/);
  csrf = csrfOf(html);
  const noToken = await form("/me/create", { name: "Helper" }, cookie);
  assert.equal(noToken.status, 403);
  const made = await form("/me/create", { csrf, name: "Helper", description: "helps" }, cookie);
  assert.equal(made.status, 201);
  html = await made.text();
  const shown = html.match(/lettit_[0-9a-f]{40}/);
  assert.ok(shown, "the key is on the page");
  assert.ok(!(await page("/me", cookie).then((r) => r.text())).includes(shown[0]), "and nowhere else");
  const [, card] = await get("/api/agents/bob-helper");
  assert.equal(card.claimed, true);
  const now = await page("/me/profile", cookie).then((r) => r.text());
  assert.match(now, /you: bob@x\.io · bob-helper/);
  const [w, t] = await post("/api/posts", { kind: "status", title: "by cookie", body: "x" }, null).catch(() => [0]);
  assert.notEqual(w, 201, "the cookie alone never writes through the API");
  const viaCookie = await fetch(base + "/api/posts", { method: "POST", headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf }, body: JSON.stringify({ kind: "status", title: "by cookie", body: "x" }) });
  assert.equal(viaCookie.status, 201);
  assert.equal((await viaCookie.json()).author, "bob-helper");
  void t;
});

test("5. /login takes email and password; the key field is refused; 10 failures lock the email for a while", async () => {
  const old = await form("/login", { key: "lettit_" + "0".repeat(40) });
  assert.equal(old.status, 400);
  assert.match(await old.text(), /email and password/);
  const bad = await form("/login", { email: ann.email, password: "nope-nope-nope" });
  assert.equal(bad.status, 403);
  assert.equal(bad.headers.get("set-cookie"), null);
  const ok = await form("/login", { email: ann.email, password: ann.password, next: "/me/account" });
  assert.equal(ok.status, 302);
  assert.equal(ok.headers.get("location"), "/me/account");
  const annCookie = cookieOf(ok);
  const acct = await page("/me/account", annCookie);
  assert.equal(acct.status, 200);
  assert.match(await acct.text(), /ann-scout/);
  const victim = { email: "carl@x.io", password: "carl-password-1" };
  await post("/api/operators", victim);
  for (let i = 0; i < 10; i++) assert.equal((await form("/login", { email: victim.email, password: "wrong-wrong-1" })).status, 403);
  const locked = await form("/login", { email: victim.email, password: victim.password });
  assert.equal(locked.status, 429);
  assert.equal(locked.headers.get("set-cookie"), null);
  assert.equal((await form("/login", { email: ann.email, password: ann.password })).status, 302, "other emails are unaffected");
});

test("6. an agent claimed by key alone can be attached by its key; one owned by someone else cannot", async () => {
  // A pre-account agent: written straight into the store as the old claim path left it.
  server.close();
  const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
  const orphanKey = "lettit_" + crypto.randomBytes(20).toString("hex");
  raw.agents["old-orphan"] = { id: "old-orphan", name: "orphan", operator: "old", contact: "", description: "", created: "2026-01-01T00:00:00.000Z", updated: "2026-01-01T00:00:00.000Z", posts: 0, key_hash: crypto.createHash("sha256").update(orphanKey).digest("hex") };
  fs.writeFileSync(FILE, JSON.stringify(raw));
  const { load } = await import("../src/store.js");
  load();
  await new Promise((r) => server.listen(server.address()?.port || 0, r));
  base = `http://localhost:${server.address().port}`;
  const html = await page("/me", cookie).then((r) => r.text());
  csrf = csrfOf(html);
  const wrong = await form("/me/attach", { csrf, key: "lettit_" + "1".repeat(40) }, cookie);
  assert.equal(wrong.status, 403);
  const ok = await form("/me/attach", { csrf, key: orphanKey }, cookie);
  assert.equal(ok.status, 302);
  assert.match(await page("/me/profile", cookie).then((r) => r.text()), /you: bob@x\.io · old-orphan/);
  const annCookie = cookieOf(await form("/login", { email: ann.email, password: ann.password }));
  const annCsrf = csrfOf(await page("/me", annCookie).then((r) => r.text()));
  const taken = await form("/me/attach", { csrf: annCsrf, key: orphanKey }, annCookie);
  assert.equal(taken.status, 403);
  assert.match(await taken.text(), /another operator/);
});

test("7. changing the password signs other sessions out, keeps this one, and retires the old password", async () => {
  const other = cookieOf(await form("/login", { email: "bob@x.io", password: "bob-password-1" }));
  assert.equal((await page("/me", other)).status, 200);
  const html = await page("/me/account", cookie).then((r) => r.text());
  csrf = csrfOf(html);
  const bad = await form("/me/account", { csrf, action: "password", password: "wrong-wrong-1", new_password: "bob-password-2", new_password2: "bob-password-2" }, cookie);
  assert.equal(bad.status, 403);
  const ok = await form("/me/account", { csrf, action: "password", password: "bob-password-1", new_password: "bob-password-2", new_password2: "bob-password-2" }, cookie);
  assert.equal(ok.status, 302);
  assert.equal((await page("/me", cookie)).status, 200, "this session stays");
  assert.equal((await page("/me", other)).status, 302, "the other is gone");
  assert.equal((await form("/login", { email: "bob@x.io", password: "bob-password-1" })).status, 403);
  assert.equal((await form("/login", { email: "bob@x.io", password: "bob-password-2" })).status, 302);
});

test("8. rotating a key from /me keeps the operator signed in", async () => {
  await form("/me/switch", { csrf, agent: "bob-helper" }, cookie);
  const rot = await form("/me/rotate", { csrf }, cookie);
  assert.equal(rot.status, 200);
  assert.match(await rot.text(), /lettit_[0-9a-f]{40}/);
  assert.equal((await page("/me", cookie)).status, 200);
});

// Spawn src/mcp.js the way Claude Code would.
function bridge(env) {
  const child = spawn(process.execPath, ["src/mcp.js"], { env: { ...process.env, LETTIT_URL: base, LETTIT_KEY: "", ...env }, stdio: ["pipe", "pipe", "pipe"] });
  let buf = "", next = 1, err = "";
  const waiting = new Map();
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c) => { err += c; });
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) { const msg = JSON.parse(line); waiting.get(msg.id)?.(msg); waiting.delete(msg.id); } }
  });
  const rpc = (method, params) => new Promise((resolve) => { const id = next++; waiting.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  const call = async (name, args) => { const { result } = await rpc("tools/call", { name, arguments: args }); return [result.isError === true, result.isError ? result.content[0].text : JSON.parse(result.content[0].text)]; };
  return { call, stderr: () => err, close: () => child.kill() };
}

test("9. the bridge claims with the operator's credentials on first write, saves only the key, and names the variables when they are missing", async () => {
  const keyFile = path.join(process.env.DATA_DIR, "keys.json");
  const bare = bridge({ LETTIT_AGENT: "ann-bridge", LETTIT_KEY_FILE: keyFile });
  try {
    const [e, msg] = await bare.call("post", { kind: "status", title: "t", body: "b" });
    assert.equal(e, true);
    assert.match(msg, /LETTIT_OPERATOR_EMAIL and LETTIT_OPERATOR_PASSWORD/);
  } finally { bare.close(); }
  const b = bridge({ LETTIT_AGENT: "ann-bridge", LETTIT_KEY_FILE: keyFile, LETTIT_OPERATOR_EMAIL: ann.email, LETTIT_OPERATOR_PASSWORD: ann.password });
  try {
    const [e, t] = await b.call("post", { kind: "status", title: "from the bridge", body: "b" });
    assert.equal(e, false, t);
    assert.equal(t.author, "ann-bridge");
    const saved = fs.readFileSync(keyFile, "utf8");
    assert.match(JSON.parse(saved)[base]["ann-bridge"], /^lettit_/);
    assert.ok(!saved.includes(ann.password), "the password never lands in the key file");
    assert.ok(!b.stderr().includes(ann.password));
  } finally { b.close(); }
  const again = bridge({ LETTIT_AGENT: "ann-bridge", LETTIT_KEY_FILE: keyFile });
  try {
    const [e, t] = await again.call("post", { kind: "status", title: "second run", body: "no credentials needed" });
    assert.equal(e, false, t);
  } finally { again.close(); }
});

test("10. the setup prompt sends agents to /signup and /api/operators, not to an anonymous claim", async () => {
  const prompt = await fetch(base + "/prompt").then((r) => r.text());
  assert.match(prompt, /\/signup/);
  assert.match(prompt, /api\/operators/);
  assert.match(prompt, /"email":"<their email>","password":"<their password>"/);
  assert.ok(!prompt.includes('"operator":"<who runs you'), "the operator-only claim is gone");
  assert.match(prompt, /never keep or post the\npassword/);
  for (const p of ["/login", "/connect/ann-scout"]) assert.match(await fetch(base + p).then((r) => r.text()), /\/signup|#signup/, p);
  assert.match(await fetch(base + "/agent").then((r) => r.text()), /href="\/join"/, "the board page reaches signup through the join QR");
});

test("12. a scanned card carries a newcomer through signup and onboarding, and the first agent follows it", async () => {
  const landing = await page("/connect/ann-scout");
  assert.equal(landing.status, 302);
  assert.equal(landing.headers.get("location"), "/signup?follow=ann-scout");
  const signup = await page("/signup?follow=ann-scout").then((r) => r.text());
  assert.match(signup, /will follow it/);
  assert.match(signup, /name="follow" value="ann-scout"/);
  assert.match(signup, /href="\/login\?next=%2Fconnect%2Fann-scout"/);
  const made = await form("/signup", { email: "dee@x.io", password: "dee-password-10", password2: "dee-password-10", follow: "ann-scout" });
  assert.equal(made.status, 201);
  assert.match(await made.text(), /It now follows <a href="\/agents\/ann-scout">/, "the automatic first agent follows the scanned one");
  const dee = cookieOf(made);
  const [, prof] = await get("/api/agents/ann-scout", key);
  assert.ok(prof.followers >= 1);
  const [, following] = await fetch(base + "/api/me/following", { headers: { cookie: dee } }).then(async (r) => [r.status, await r.json()]);
  assert.ok(following.some((x) => x.id === "ann-scout"), JSON.stringify(following));
  const me = await page("/me", dee).then((r) => r.text());
  const created = await form("/me/create", { csrf: csrfOf(me), name: "Buddy" }, dee);
  assert.equal(created.status, 201, "more agents can be added later");
  // Signed in with an agent: a scan just follows.
  const scan = await page("/connect/bob-helper", dee);
  assert.equal(scan.status, 200);
  assert.match(await scan.text(), /You now follow bob-helper as dee-buddy/);
  // A fresh account already has an agent, so a scan just follows.
  const eve = cookieOf(await form("/signup", { email: "eve@x.io", password: "eve-password-10", password2: "eve-password-10" }));
  const scanEve = await page("/connect/ann-scout", eve);
  assert.equal(scanEve.status, 200);
  assert.match(await scanEve.text(), /You now follow ann-scout as eve/);
  // A bogus follow target on signup is ignored.
  const bogus = await form("/signup", { email: "fay@x.io", password: "fay-password-10", password2: "fay-password-10", follow: "nobody-here" });
  assert.equal(bogus.status, 201);
  assert.ok(!(await bogus.text()).includes("It now follows"));
});

test("11. a data file with an old key-based session loads with that session dropped; keys still work", async () => {
  server.close();
  const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
  raw.sessions.deadbeef = { agents: ["ann-scout"], current: "ann-scout", csrf: "x", created: "2026-01-01T00:00:00.000Z", expires: "2999-01-01T00:00:00.000Z" };
  fs.writeFileSync(FILE, JSON.stringify(raw));
  const { load } = await import("../src/store.js");
  load();
  await new Promise((r) => server.listen(server.address()?.port || 0, r));
  base = `http://localhost:${server.address().port}`;
  assert.equal(JSON.parse(fs.readFileSync(FILE, "utf8")).sessions.deadbeef, undefined);
  assert.equal((await page("/me", cookie)).status, 200, "operator sessions survive a reload");
  const [w] = await post("/api/posts", { kind: "status", title: "still keyed", body: "x" }, key);
  assert.equal(w, 201);
});
