// The operator's journey dashboard at /admin: HTTP Basic auth with ADMIN_USER and ADMIN_PASSWORD (Railway
// variables), fed by the events kept in Postgres. Works without a PostHog key: the local copy is enough.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { freshSchema, sql } from "./_db.js";

delete process.env.POSTHOG_API_KEY;
process.env.ADMIN_USER = "chris";
process.env.ADMIN_PASSWORD = "very-secret-admin-pw";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lettit-admin-"));
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
let n = 0;
const rpc = (key, method, params) => fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method, params }) }).then((r) => r.json());
const text = (s) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

test("the dashboard needs the admin credentials from the environment", async () => {
  const anon = await fetch(base + "/admin");
  assert.equal(anon.status, 401);
  assert.match(anon.headers.get("www-authenticate"), /^Basic realm=/);
  const wrong = await fetch(base + "/admin", { headers: basic("chris", "nope") });
  assert.equal(wrong.status, 401);
  const wrongUser = await fetch(base + "/admin", { headers: basic("admin", "very-secret-admin-pw") });
  assert.equal(wrongUser.status, 401);
  const ok = await admin();
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("cache-control"), /no-store/);
  const page = await ok.text();
  assert.ok(page.includes("Sees landing page") && page.includes("50 uses in a week"), "the five steps are named");
  assert.ok(!page.includes("very-secret-admin-pw"));
});

test("without ADMIN_USER and ADMIN_PASSWORD the page says it is not configured", async () => {
  const user = process.env.ADMIN_USER;
  delete process.env.ADMIN_USER;
  try {
    const r = await fetch(base + "/admin", { headers: basic("chris", "very-secret-admin-pw") });
    assert.equal(r.status, 404);
    assert.match(await r.text(), /ADMIN_USER/);
  } finally { process.env.ADMIN_USER = user; }
});

test("one journey shows up in the funnel, the breakdowns, the questions, and the agent list", async () => {
  // A human lands, signs up, connects through the hosted endpoint, asks a question, comes back a week later.
  const land = await fetch(base + "/agent", { headers: { "user-agent": BROWSER } });
  const cookie = land.headers.get("set-cookie").split(";")[0];
  await fetch(base + "/api/operators", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "t-journey@x.io", password: "test-password-10" }) });
  // The claim comes from the same browser (the starter prompt pasted into a tool that reads the cookie's page), so the visitor merges into the agent.
  const card = await fetch(base + "/api/agents", { method: "POST", headers: { "content-type": "application/json", cookie, "user-agent": BROWSER }, body: JSON.stringify({ name: "Journey", email: "t-journey@x.io", password: "test-password-10" }) }).then((r) => r.json());
  assert.ok(card.key, JSON.stringify(card));
  await rpc(card.key, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "Claude", version: "1" } });
  await rpc(card.key, "tools/call", { name: "search", arguments: { q: "how do I pool postgres connections" } });
  await analytics.flush();
  await db("update agent_first_use set at = now() - interval '9 days' where agent_id = $1", ["t-journey"]);
  await rpc(card.key, "tools/call", { name: "whoami", arguments: {} });
  // An agent that only fetched the prompt, never converted.
  await fetch(base + "/prompt", { headers: { "user-agent": "curl/8" } });
  await analytics.flush();

  const rows = await db("select event, distinct_id from events order by id");
  assert.ok(rows.some((r) => r.event === "landing_viewed") && rows.some((r) => r.event === "tool_called"), "events are kept locally without a PostHog key");

  const page = await (await admin()).text();
  const t = text(page);
  // Funnel by visitor: the human reached steps 1-4; the curl agent only step 1.
  assert.match(t, /human.*?Sees landing page.*?1.*?Connected to MCP.*?1.*?First read or write.*?1.*?Back after one week.*?1.*?50 uses in a week.*?0/s);
  assert.match(t, /agent.*?Sees landing page.*?1.*?Connected to MCP.*?0/s);
  assert.ok(page.includes("how do I pool postgres connections"), "the question is listed");
  assert.ok(page.includes("No Results Match"), "with the answer it got");
  assert.ok(page.includes("t-journey"), "attached to the agent");
  assert.ok(page.includes("<svg"), "charts are drawn");

  const byClient = text(await (await admin("/admin?by=client")).text());
  assert.match(byClient, /Chrome.*?Sees landing page.*?1/s);
  assert.match(byClient, /curl.*?Sees landing page.*?1/s);
  const byTransport = text(await (await admin("/admin?by=transport")).text());
  assert.match(byTransport, /hosted.*?Connected to MCP.*?1/s);
});

test("the stored events are the same shape PostHog gets, and old tool calls are swept", async () => {
  const [row] = await db("select event, distinct_id, properties from events where event = 'tool_called' and properties->>'tool' = 'search' limit 1");
  assert.equal(row.properties.query, "how do I pool postgres connections");
  assert.equal(row.distinct_id, "t-journey");
  await db("update events set created = now() - interval '100 days' where event = 'tool_called' and properties->>'tool' = 'whoami'");
  const store = await import("../src/store.js");
  await store.sweep();
  assert.equal((await db("select count(*)::int as n from events where properties->>'tool' = 'whoami'"))[0].n, 0);
  assert.equal((await db("select count(*)::int as n from events where event = 'landing_viewed'"))[0].n, 2, "funnel events stay");
});
