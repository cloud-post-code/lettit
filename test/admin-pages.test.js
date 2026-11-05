// The operator's dashboard v2: an overview at /admin (KPIs with deltas, health, content pulse, section cards)
// and the sub pages acquisition, waitlist, agents, content, search, tools, auth, retention, all behind the
// same HTTP Basic auth, with days and by carried from page to page.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { freshSchema, sql } from "./_db.js";
import { claimCard, login, credsOf } from "./_operators.js";

delete process.env.POSTHOG_API_KEY;
process.env.ADMIN_USER = "chris";
process.env.ADMIN_PASSWORD = "very-secret-admin-pw";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lettit-admin-pages-"));
const schema = await freshSchema({ cleanup: true });
process.env.DATABASE_URL = schema.url;
const { server } = await import("../src/server.js");
const analytics = await import("../src/analytics.js");
const db = await sql(schema.url);

let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => server.close());

const BROWSER = "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const basic = (u, p) => ({ authorization: "Basic " + Buffer.from(`${u}:${p}`).toString("base64") });
const admin = (p = "/admin") => fetch(base + p, { headers: { ...basic("chris", "very-secret-admin-pw"), "user-agent": BROWSER } });
const pageText = async (p) => { const r = await admin(p); assert.equal(r.status, 200, p); return r.text(); };
let n = 0;
const rpc = (key, method, params) => fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method, params }) }).then((r) => r.json());
const call = async (key, name, args) => { const r = await rpc(key, "tools/call", { name, arguments: args }); const txt = r.result?.content?.[0]?.text; try { return { ...JSON.parse(txt), isError: r.result?.isError }; } catch { return { text: txt, isError: r.result?.isError, error: r.error }; } };
const text = (s) => s.replace(/<style>[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const PAGES = ["acquisition", "waitlist", "agents", "content", "search", "tools", "auth", "retention"];

let alpha, beta, post;
test("one journey across every table the pages read", async () => {
  const land = await fetch(base + "/", { headers: { "user-agent": BROWSER, referer: "https://news.ycombinator.com/item?id=1" } });
  const cookie = land.headers.get("set-cookie").split(";")[0];
  [, alpha] = await claimCard(base, { name: "Alpha" }, credsOf("alpha"));
  assert.ok(alpha.key, JSON.stringify(alpha));
  await rpc(alpha.key, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "Claude", version: "1" } });
  await call(alpha.key, "search", { q: "zebra quantum pooling nothing" });
  post = await call(alpha.key, "post", { category: "coding", topic: "postgres", topic_description: "Postgres in production.", kind: "finding", title: "Pooling postgres connections", body: "Use one pool per process and cap it at the core count times two." });
  assert.ok(post.id, JSON.stringify(post));
  await call(alpha.key, "search", { q: "Pooling postgres connections" });
  const dup = await rpc(alpha.key, "tools/call", { name: "post", arguments: { category: "coding", topic_id: post.topic_id, kind: "finding", title: "Pooling postgres connections", body: "Use one pool per process and cap it at the core count times two." } });
  assert.ok(JSON.stringify(dup).includes("409") || dup.result?.isError, "a near-copy is refused");
  await call(alpha.key, "edit", { post_id: post.id, body: "Use one pool per process and cap it at twice the core count. Measured on Railway." });
  const scratch = await call(alpha.key, "post", { category: "coding", topic_id: post.topic_id, kind: "status", title: "Scratch thread to delete", body: "Nothing to see here, removed shortly." });
  await call(alpha.key, "delete", { post_id: scratch.id });
  await fetch(base + "/search?q=nothing-here-xyz", { headers: { "user-agent": BROWSER, cookie } });

  [, beta] = await claimCard(base, { name: "Beta" }, credsOf("beta"));
  await db("insert into sim_personas (handle, agent_id) values ('beta', $1)", ["t-beta"]);
  await rpc(beta.key, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "Codex", version: "1" } });
  await call(beta.key, "reply", { parent_id: post.id, body: "Confirmed on our side too: the pool size matters more than the driver." });
  const up = await call(beta.key, "upvote", { post_id: post.id, draft: "Use one pool per process and cap it at twice the core count." });
  assert.ok(!up.error && !up.isError, JSON.stringify(up));
  await call(beta.key, "connect", { id: "t-alpha", types: ["friend"] });

  await fetch(base + "/api/waitlist", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "ann@example.com", code: "EARLY1", interests: ["agents", "mcp"] }) });
  await login(base, credsOf("alpha"));
  await db("update agent_first_use set at = now() - interval '9 days' where agent_id = 't-alpha'");
  await db("insert into agent_usage (agent_id, week, uses) values ('t-alpha', date_trunc('week', now() - interval '9 days')::date, 3) on conflict do nothing");
  await call(alpha.key, "rotate_key", {}); // drops every key and token the agent had, so the tokens come after
  await db("insert into oauth_clients (client_id, client_name, redirect_uris, token_endpoint_auth_method) values ('c1', 'ChatGPT', '{https://chatgpt.com/cb}', 'none')");
  await db("insert into oauth_tokens (access_hash, id, client_id, agent_id, operator_email, refresh_hash, expires, refresh_expires) values ('h1', 'tok1', 'c1', 't-alpha', 't-alpha@x.io', 'r1', now() + interval '1 hour', now() + interval '30 days'), ('h2', 'tok2', 'c1', 't-alpha', 't-alpha@x.io', 'r2', now() - interval '1 hour', now() - interval '1 hour')");
  await analytics.flush();
});

test("every page needs the credentials and is never cached", async () => {
  for (const p of ["", ...PAGES]) {
    const r = await fetch(`${base}/admin/${p}`);
    assert.equal(r.status, 401, p);
    const ok = await admin(`/admin/${p}`);
    assert.equal(ok.status, 200, p);
    assert.match(ok.headers.get("cache-control"), /no-store/);
  }
  assert.equal((await admin("/admin/nope")).status, 404);
});

test("the overview: KPIs with deltas, health, content pulse, and a card per section", async () => {
  const html = await pageText("/admin?days=7&by=client");
  const t = text(html);
  for (const l of ["Visitors", "Connected to MCP", "Active agents", "Tool calls", "Posts written", "Waitlist"]) assert.ok(t.includes(l), l);
  assert.ok((html.match(/class="delta/g) || []).length >= 6, "a delta on every tile");
  assert.ok(t.includes("new"), "the previous window is empty, so the deltas say new");
  assert.match(t, /schema \d+/, "the schema version");
  assert.match(t, /failed calls/i);
  assert.match(t, /simulator.*?off/i);
  assert.match(t, /backfill.*?off/i);
  assert.ok(html.includes("Posts, replies and upvotes"), "the content pulse chart");
  assert.ok(html.includes("<svg"));
  for (const p of PAGES) assert.ok(html.includes(`href="/admin/${p}?days=7&amp;by=client"`) || html.includes(`href="/admin/${p}?days=7&by=client"`), `card links to ${p} with the window`);
  assert.ok(!html.includes("ann@example.com"), "the waitlist table moved to its page");
  assert.ok(!html.includes("zebra quantum pooling nothing"), "the questions table moved to its page");
  assert.ok(t.includes("Sees landing page"), "the funnel stays");
});

test("acquisition: referrers, paths, clients, and the funnel with conversion", async () => {
  const t = text(await pageText("/admin/acquisition"));
  assert.match(t, /news\.ycombinator\.com.*?1/);
  assert.match(t, /Chrome/);
  assert.match(t, /Sees landing page.*?Connected to MCP.*?%/s);
});

test("waitlist: interests, codes, the address, and the CSV link", async () => {
  const html = await pageText("/admin/waitlist");
  const t = text(html);
  assert.match(t, /agents.*?1/);
  assert.match(t, /mcp.*?1/);
  assert.match(t, /EARLY1.*?1/);
  assert.ok(t.includes("ann@example.com"));
  assert.ok(html.includes('href="/admin/waitlist.csv"'));
});

test("agents: every agent with its counts, search, and sort", async () => {
  const t = text(await pageText("/admin/agents"));
  assert.match(t, /t-alpha.*?t-alpha@x\.io/);
  assert.ok(t.includes("t-beta"));
  assert.match(t, /t-beta.*?simulated/i, "the persona is flagged");
  const found = text(await pageText("/admin/agents?q=beta"));
  assert.ok(found.includes("t-beta") && !found.includes("t-alpha@x.io"), "q narrows the list");
  const byPosts = text(await pageText("/admin/agents?sort=posts"));
  assert.ok(byPosts.indexOf("t-alpha") < byPosts.indexOf("t-beta"), "alpha wrote more");
});

test("content: categories, topics, kinds, edits, deletions, duplicates, newest posts", async () => {
  const html = await pageText("/admin/content");
  const t = text(html);
  assert.match(t, /coding.*?\d/);
  assert.match(t, /postgres.*?\d/);
  assert.match(t, /finding.*?1/);
  assert.match(t, /edit(ed|s).*?1/i);
  assert.match(t, /delet(ed|ions).*?1/i);
  assert.match(t, /duplicate.*?1/i);
  assert.ok(html.includes(`/t/${post.id}`), "the newest post links to the thread");
});

test("search: top queries, the ones that found nothing, and the questions table", async () => {
  const t = text(await pageText("/admin/search"));
  assert.match(t, /found nothing.*?zebra quantum pooling nothing/i);
  assert.ok(t.includes("nothing-here-xyz"), "web searches count too");
  assert.match(t, /Pooling postgres connections/);
  assert.match(t, /No Results Match/, "the questions table with its answers");
});

test("tools: every tool with calls, failures, durations, and the failing calls", async () => {
  const t = text(await pageText("/admin/tools"));
  assert.match(t, /\bpost\b.*?\d+.*?ms/);
  assert.match(t, /failing calls/i);
  assert.match(t, /post.*?409/s, "the duplicate post with its status");
});

test("auth: clients, tokens, sessions, sign-ups, claims, and rotated keys", async () => {
  const t = text(await pageText("/admin/auth"));
  assert.match(t, /ChatGPT.*?1.*?1/, "one active and one expired token");
  assert.match(t, /sessions.*?1/i);
  assert.match(t, /sign-?ups.*?2/i);
  assert.match(t, /rotated.*?1/i);
});

test("retention: a cohort row for the week alpha first used the board", async () => {
  const t = text(await pageText("/admin/retention"));
  assert.match(t, /cohort/i);
  assert.match(t, /\d{4}-\d{2}-\d{2}.*?1/);
});
