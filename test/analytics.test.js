// PostHog reporting: the journey funnel (landing, MCP connect, first use, week one, 50 a week) and every tool
// call with its answer, attached to the agent. A fake PostHog on a local port receives the batches.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claimCard, operator } from "./_operators.js";
import { bridge } from "./_bridge.js";
import { freshSchema, sql } from "./_db.js";

const sink = [];
const posthog = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => { if (req.url.startsWith("/batch")) sink.push(...JSON.parse(raw).batch); res.writeHead(200, { "content-type": "application/json" }); res.end('{"status":1}'); });
});
await new Promise((r) => posthog.listen(0, r));
process.env.POSTHOG_API_KEY = "phc_test";
process.env.POSTHOG_HOST = `http://localhost:${posthog.address().port}`;
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lettit-analytics-"));
const schema = await freshSchema({ cleanup: true });
process.env.DATABASE_URL = schema.url;
const { server } = await import("../src/server.js");
const analytics = await import("../src/analytics.js");

const db = await sql(schema.url);
let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => { server.close(); posthog.close(); });

// Everything captured since the last call, after a flush.
async function events() { await analytics.flush(); return sink.splice(0); }
const named = (evs, name) => evs.filter((e) => e.event === name);
const BROWSER = "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const get = (p, headers = {}) => fetch(base + p, { headers, redirect: "manual" });
let n = 0;
const rpc = (key, method, params) => fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method, params }) }).then((r) => r.json());
const call = (key, name, args) => rpc(key, "tools/call", { name, arguments: args });
const claim = (name) => claimCard(base, { name }).then(([, c]) => c);

test("landing page: humans and agents are told apart, humans get a visitor cookie and the snippet", async () => {
  const r = await get("/agent", { "user-agent": BROWSER, referer: "https://news.ycombinator.com/" });
  const cookie = r.headers.get("set-cookie");
  assert.match(cookie, /^lettit_visitor=[A-Za-z0-9_-]+;.*SameSite=Lax/);
  const visitor = cookie.match(/lettit_visitor=([^;]+)/)[1];
  const html = await r.text();
  assert.ok(html.includes("posthog") && html.includes(visitor), "the snippet is bootstrapped with the visitor id");
  assert.ok(html.includes("phc_test"));
  await get("/prompt", { "user-agent": "curl/8.4.0" });
  await get("/api/prompt", { "user-agent": "node" });
  const again = await get("/agent", { "user-agent": BROWSER, cookie: `lettit_visitor=${visitor}` });
  assert.equal(again.headers.get("set-cookie"), null, "a returning visitor keeps its cookie");
  const evs = named(await events(), "landing_viewed");
  const human = evs.find((e) => e.properties.visitor === "human");
  assert.equal(human.distinct_id, visitor);
  assert.equal(human.properties.path, "/agent");
  assert.equal(human.properties.referrer, "https://news.ycombinator.com/");
  assert.equal(human.properties.client, "Chrome");
  const agents = evs.filter((e) => e.properties.visitor === "agent");
  assert.deepEqual(agents.map((e) => e.properties.path).sort(), ["/api/prompt", "/prompt"]);
  for (const a of agents) assert.match(a.distinct_id, /^v:[0-9a-f]{16}$/);
  assert.equal(agents[0].properties.client, "curl");
  assert.equal(evs.length, 4);
});

test("sign-up merges the visitor into the agent; an API claim identifies too", async () => {
  const visitor = "abc123visitor";
  const form = new URLSearchParams({ email: "t-newbie@x.io", password: "test-password-10", password2: "test-password-10" }).toString();
  const r = await fetch(base + "/signup", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie: `lettit_visitor=${visitor}`, "user-agent": BROWSER }, body: form });
  assert.equal(r.status, 201);
  let evs = await events();
  const id = named(evs, "$identify")[0];
  assert.equal(id.distinct_id, "t-newbie");
  assert.equal(id.properties.$anon_distinct_id, visitor);
  assert.equal(id.properties.$set.agent, "t-newbie");
  assert.equal(named(evs, "signed_up")[0].properties.method, "form");
  assert.equal(named(evs, "signed_up")[0].distinct_id, "t-newbie");
  assert.ok(!JSON.stringify(evs).includes("x.io"), "no email in events");

  const [status, card] = await claimCard(base, { name: "Claimer" });
  assert.equal(status, 201);
  evs = await events();
  assert.equal(named(evs, "agent_claimed")[0].distinct_id, card.id);
  assert.equal(named(evs, "$identify")[0].distinct_id, card.id);
  assert.ok(!JSON.stringify(evs).includes(card.key), "never the key");
  assert.ok(!JSON.stringify(evs).includes("test-password"), "never the password");
});

test("hosted MCP: initialize is mcp_connected, every tool call carries its input and answer", async () => {
  const key = (await claim("Hosted")).key;
  await rpc(key, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "ChatGPT", version: "1" } });
  let evs = await events();
  const c = named(evs, "mcp_connected")[0];
  assert.equal(c.distinct_id, "t-hosted");
  assert.deepEqual([c.properties.transport, c.properties.via, c.properties.client], ["hosted", "key", "ChatGPT"]);

  await call(key, "search", { q: "postgres pooling" });
  await call(key, "post", { category: "coding", topic: "analytics tests", topic_description: "Test topic.", kind: "status", title: "hello from the test", body: "first post" });
  await call(key, "upvote", { post_id: "nope", draft: "x" });
  evs = named(await events(), "tool_called");
  assert.equal(evs.length, 3);
  const [s, p, u] = evs;
  assert.equal(s.distinct_id, "t-hosted");
  assert.deepEqual([s.properties.tool, s.properties.kind, s.properties.transport, s.properties.ok], ["search", "read", "hosted", true]);
  assert.equal(s.properties.query, "postgres pooling");
  assert.equal(s.properties.input.q, "postgres pooling");
  assert.equal(s.properties.answer, "No Results Match");
  assert.equal(typeof s.properties.duration_ms, "number");
  assert.deepEqual([p.properties.tool, p.properties.kind, p.properties.ok], ["post", "write", true]);
  assert.ok(p.properties.answer.includes("hello from the test"));
  assert.equal(u.properties.ok, false);
  assert.match(u.properties.error, /not found|no such/i);
  // Use counting starts with the first call.
  const first = await db("select agent_id from agent_first_use where agent_id = $1", ["t-hosted"]);
  assert.equal(first.length, 1);
});

test("the stdio bridge reports its connection and its calls the same way", async () => {
  const key = (await claim("Bridged")).key;
  const b = bridge(base, path.join(process.env.DATA_DIR, "keys.json"), { LETTIT_KEY: key });
  try {
    await b.initialize();
    await b.rpc("tools/call", { name: "search", arguments: { q: "bridge search" } });
    await b.call("post", { category: "coding", topic: "bridge tests", topic_description: "Test topic.", kind: "status", title: "bridge post", body: "from the bridge" });
    await new Promise((r) => setTimeout(r, 100));
    const evs = await events();
    const c = named(evs, "mcp_connected")[0];
    assert.equal(c.distinct_id, "t-bridged");
    assert.deepEqual([c.properties.transport, c.properties.client], ["bridge", "test"]);
    const calls = named(evs, "tool_called");
    const s = calls.find((e) => e.properties.tool === "search");
    assert.deepEqual([s.distinct_id, s.properties.transport, s.properties.kind, s.properties.client, s.properties.query], ["t-bridged", "bridge", "read", "test", "bridge search"]);
    assert.deepEqual(JSON.parse(s.properties.answer), { match: null }, "the bridge's answer is the API's JSON");
    const p = calls.find((e) => e.properties.tool === "post");
    assert.deepEqual([p.properties.kind, p.properties.ok, p.properties.input.title], ["write", true, "bridge post"]);
    assert.ok(!JSON.stringify(evs).includes(key), "never the key");
  } finally { b.close(); }
});

test("plain HTTP API calls count too, and anonymous reads go under the visitor", async () => {
  const key = (await claim("Http")).key;
  await get("/api/search?q=plain+http", { authorization: `Bearer ${key}`, "user-agent": "python-requests/2.3" });
  await get("/api/recent", { "user-agent": "curl/8" });
  const evs = named(await events(), "tool_called");
  const mine = evs.find((e) => e.distinct_id === "t-http");
  assert.deepEqual([mine.properties.tool, mine.properties.transport, mine.properties.kind, mine.properties.query, mine.properties.client], ["GET /api/search", "http", "read", "plain http", "python"]);
  assert.ok(Array.isArray(JSON.parse(mine.properties.answer)));
  const anon = evs.find((e) => e.properties.tool === "GET /api/recent");
  assert.match(anon.distinct_id, /^v:/);
});

test("week one and 50 uses a week fire once each", async () => {
  const key = (await claim("Loyal")).key;
  await call(key, "whoami", {});
  await events();
  await db("update agent_first_use set at = now() - interval '8 days' where agent_id = $1", ["t-loyal"]);
  await call(key, "whoami", {});
  let evs = await events();
  assert.equal(named(evs, "retained_week_one").length, 1);
  assert.equal(named(evs, "retained_week_one")[0].distinct_id, "t-loyal");
  await call(key, "whoami", {});
  assert.equal(named(await events(), "retained_week_one").length, 0, "only once");

  await db("update agent_usage set uses = 49 where agent_id = $1", ["t-loyal"]);
  await call(key, "whoami", {});
  evs = await events();
  assert.equal(named(evs, "power_week").length, 1);
  assert.equal(named(evs, "power_week")[0].properties.uses, 50);
  await call(key, "whoami", {});
  assert.equal(named(await events(), "power_week").length, 0, "only once a week");
});

test("the human search page reports the question", async () => {
  await get("/search?q=how+to+pool&kind=procedure", { "user-agent": BROWSER, cookie: "lettit_visitor=websearcher" });
  const e = named(await events(), "search_performed")[0];
  assert.equal(e.distinct_id, "websearcher");
  assert.deepEqual([e.properties.surface, e.properties.q, e.properties.kind, e.properties.results], ["web", "how to pool", "procedure", 0]);
});

test("without a key nothing is sent", async () => {
  analytics.configure({ key: "" });
  try {
    await get("/agent", { "user-agent": BROWSER });
    assert.equal((await events()).length, 0);
    assert.equal(analytics.key(), "", "no PostHog key: events stay local only");
  } finally { analytics.configure({ key: "phc_test" }); }
  await get("/agent", { "user-agent": BROWSER });
  assert.equal(named(await events(), "landing_viewed").length, 1);
});
