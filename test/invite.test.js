import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { operator, credsOf } from "./_operators.js";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lettit-invite-"));
const { server } = await import("../src/server.js");
const { toolRequest } = await import("../src/tools.js");

let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => server.close());

const auth = (key) => (key ? { authorization: `Bearer ${key}` } : {});
const post = (p, b, key) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...auth(key) }, body: JSON.stringify(b) }).then(async (r) => [r.status, await r.json()]);
const claim = async (name) => (await post("/api/agents", { name, operator: "Blake", ...(await operator(base, credsOf(name))) }))[1];

test("without mail configuration the invite is composed, not sent: prompt, signup link, connect and post lines, mailto", async () => {
  delete process.env.MAIL_API_KEY; delete process.env.MAIL_FROM;
  const me = await claim("Scout");
  const [s, r] = await post("/api/me/invite", { to: "Friend@Example.org", name: "Sam", note: "come try this" }, me.key);
  assert.equal(s, 200);
  assert.equal(r.sent, false);
  assert.match(r.reason, /MAIL_API_KEY/);
  assert.equal(r.to, "friend@example.org");
  assert.equal(r.subject, "t-scout invited you to LETTIT");
  assert.ok(r.mailto.startsWith("mailto:friend@example.org?subject=" + encodeURIComponent(r.subject)), r.mailto);
  assert.ok(r.mailto.includes(encodeURIComponent("/signup?follow=t-scout")), "the mailto body is the email");
  assert.match(r.text, /^Hi Sam,/);
  assert.ok(r.text.includes("come try this"), "the note is in the email");
  assert.ok(r.text.includes(`${base}/signup?follow=t-scout`), "signup link follows the inviter");
  assert.ok(r.text.includes(`${base}/mcp`), "connector URL");
  assert.match(r.text, /connect \{id: "t-scout", types: \["friend"\]\}/, "the prompt tells the newcomer to connect with the inviter");
  assert.match(r.text, /follow_agent \{id: "t-scout"\}/);
  assert.match(r.text, /post \{kind: "status", body: "Joined LETTIT on t-scout's invitation\.\n  I <what you do/, "one ready post to make");
  assert.match(r.text, /Call whoami/);
  assert.match(r.text, /[Ss]earch before you post/);
  assert.ok(!r.text.includes("lettit_"), "no key");
  assert.ok(!/password/i.test(r.text), "no password");
  assert.ok(!r.text.includes("t@x.io"), "never the operator's email");
  assert.ok(r.text.split("\n").every((l) => l.length <= 110), "no line runs past 110 characters");
});

test("to must look like an email, name and note are capped, anonymous is 401", async () => {
  const me = await claim("Helper");
  for (const to of ["", "nope", "a@", "@b"]) {
    const [s, e] = await post("/api/me/invite", { to }, me.key);
    assert.equal(s, 400, to);
    assert.match(e.error, /name@host/);
  }
  const [long, e2] = await post("/api/me/invite", { to: "a@b.io", note: "n".repeat(501) }, me.key);
  assert.equal(long, 400);
  assert.match(e2.error, /500/);
  const [ok, r] = await post("/api/me/invite", { to: "a@b.io", name: "Line\nBreak" }, me.key);
  assert.equal(ok, 200);
  assert.match(r.text, /^Hi Line Break,/);
  const [anon] = await post("/api/me/invite", { to: "a@b.io" });
  assert.equal(anon, 401);
});

test("with a mail API configured the server sends it and reports sent: true; a failing API is 502; 20 per day", async () => {
  const got = [];
  const stub = http.createServer((req, res) => {
    let raw = ""; req.on("data", (c) => (raw += c)); req.on("end", () => {
      got.push({ auth: req.headers.authorization, body: JSON.parse(raw) });
      if (got.length === 2) { res.writeHead(500); return res.end("{}"); }
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ id: "m-1" }));
    });
  });
  await new Promise((r) => stub.listen(0, r));
  process.env.MAIL_API_URL = `http://localhost:${stub.address().port}/emails`;
  process.env.MAIL_API_KEY = "re_test";
  process.env.MAIL_FROM = "LETTIT <invites@lettit.test>";
  try {
    const me = await claim("Runner");
    const [s, r] = await post("/api/me/invite", { to: "pat@example.org" }, me.key);
    assert.equal(s, 200, JSON.stringify(r));
    assert.equal(r.sent, true);
    assert.equal(r.reason, undefined);
    assert.equal(got[0].auth, "Bearer re_test");
    assert.deepEqual([got[0].body.from, got[0].body.to, got[0].body.subject], ["LETTIT <invites@lettit.test>", "pat@example.org", "t-runner invited you to LETTIT"]);
    assert.equal(got[0].body.text, r.text);
    const [bad, e] = await post("/api/me/invite", { to: "pat@example.org" }, me.key);
    assert.equal(bad, 502);
    assert.match(e.error, /500/);
    for (let i = 2; i < 20; i++) assert.equal((await post("/api/me/invite", { to: `p${i}@example.org` }, me.key))[0], 200, `invite ${i + 1}`);
    const [over, e3] = await post("/api/me/invite", { to: "late@example.org" }, me.key);
    assert.equal(over, 429);
    assert.match(e3.error, /20/);
  } finally {
    delete process.env.MAIL_API_URL; delete process.env.MAIL_API_KEY; delete process.env.MAIL_FROM;
    stub.close();
  }
});

test("the hosted MCP endpoint lists and runs the invite tool", async () => {
  const me = await claim("Writer");
  const rpc = (method, params) => fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json", ...auth(me.key) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((r) => r.json());
  const list = await rpc("tools/list", {});
  const t = list.result.tools.find((x) => x.name === "invite");
  assert.ok(t, "invite tool listed");
  assert.deepEqual(t.inputSchema.required, ["to"]);
  assert.match(t.description, /ChatGPT/);
  assert.match(t.description, /connect/);
  assert.match(t.description, /mailto/);
  const call = await rpc("tools/call", { name: "invite", arguments: { to: "kim@example.org", note: "see you there" } });
  assert.notEqual(call.result.isError, true, JSON.stringify(call.result));
  const r = JSON.parse(call.result.content[0].text);
  assert.equal(r.sent, false);
  assert.match(r.text, /connect \{id: "t-writer"/);
  assert.deepEqual(toolRequest("invite", { to: "x@y.z", name: "X", note: "n" }), { method: "POST", path: "/api/me/invite", body: { to: "x@y.z", name: "X", note: "n", author: undefined } });
});
