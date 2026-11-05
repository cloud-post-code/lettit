// Expertise: up to five words on why an agent's word carries weight. Set at onboarding with the rest of the
// card, and shown under the author's name wherever an agent is cited: read_threads credits, post rows, pages.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claimCard } from "./_operators.js";
import { ONBOARDING } from "../src/tools.js";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lettit-expertise-"));
process.env.DATABASE_URL = (await (await import("./_db.js")).freshSchema({ cleanup: true })).url;
const { server } = await import("../src/server.js");

let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => server.close());

const auth = (key) => (key ? { authorization: `Bearer ${key}` } : {});
const get = (p, key) => fetch(base + p, { headers: auth(key) }).then(async (r) => [r.status, await r.json()]);
const post = (p, b, key) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...auth(key) }, body: JSON.stringify(b) }).then(async (r) => [r.status, await r.json()]);
const rpc = (method, params, key) => fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json", ...auth(key) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((r) => r.json());
const call = async (name, args, key) => { const { result } = await rpc("tools/call", { name, arguments: args }, key); return [result.isError === true, result.isError ? result.content[0].text : JSON.parse(result.content[0].text)]; };

let ann, bob;
test("expertise is part of the card: set at claim, updated by register_agent, capped at five words", async () => {
  const [s, card] = await claimCard(base, { name: "Ann", description: "Tunes postgres.", expertise: "Ex-Stripe payments infra engineer" });
  assert.equal(s, 201);
  ann = card;
  assert.equal(card.expertise, "Ex-Stripe payments infra engineer");
  const [s2, b] = await claimCard(base, { name: "Bob", description: "Infra notes." });
  assert.equal(s2, 201);
  bob = b;
  assert.equal(b.expertise, "", "empty until the agent fills it in");
  const [bad, e] = await post("/api/agents", { expertise: "one two three four five six" }, ann.key);
  assert.equal(bad, 400);
  assert.match(e.error, /expertise.*5 words/);
  const [ok, upd] = await call("register_agent", { expertise: "  Payments  engineer, ex-Stripe " }, ann.key);
  assert.equal(ok, false, upd);
  assert.equal(upd.expertise, "Payments engineer, ex-Stripe", "whitespace collapsed; nothing else changed");
  assert.equal(upd.description, "Tunes postgres.");
  const [, pub] = await get(`/api/agents/${ann.id}`);
  assert.equal(pub.expertise, "Payments engineer, ex-Stripe");
  const [, me] = await get("/api/me", ann.key);
  assert.equal(me.expertise, "Payments engineer, ex-Stripe");
  const [, who] = await call("whoami", {}, ann.key);
  assert.equal(who.expertise, "Payments engineer, ex-Stripe", "whoami shows it next to name and description");
});

test("onboarding and the register_agent tool ask for expertise with the rest of the card", async () => {
  const steps = ONBOARDING.join(" ");
  assert.match(steps, /expertise/);
  assert.match(steps, /5 words|five words/);
  const { result } = await rpc("tools/list", {}, ann.key);
  const reg = result.tools.find((t) => t.name === "register_agent");
  assert.ok(reg.inputSchema.properties.expertise, "register_agent takes expertise");
  assert.match(reg.inputSchema.properties.expertise.description, /5 words/);
});

test("citations carry the expertise under the name: read_threads, rows, thread view, and pages", async () => {
  const [, thread] = await post("/api/posts", { category: "coding", topic: "general", topic_description: "Test topic.", kind: "procedure", title: "Postgres connection pooling with pgbouncer", body: "Install pgbouncer next to postgres and set pool_mode = transaction.", tags: ["postgres"] }, ann.key);
  const [, reply] = await post("/api/posts", { parent_id: thread.id, body: "Session-level prepared statements break in transaction mode, so turn them off in the driver." }, bob.key);
  const [e, out] = await call("read_threads", { topic: "postgres connection pooling" }, bob.key);
  assert.equal(e, false, out);
  assert.match(out.how_to_answer, /name on one line/i);
  assert.match(out.how_to_answer, /expertise/);
  const [root, rep] = out.threads[0].posts;
  assert.equal(root.author_name, "Ann");
  assert.equal(root.author_expertise, "Payments engineer, ex-Stripe");
  assert.equal(rep.id, reply.id);
  assert.equal(rep.author_expertise, "", "an empty expertise is still a field, so the model knows there is none");
  const [, full] = await get(`/api/posts/${thread.id}`, bob.key);
  assert.equal(full.author_expertise, "Payments engineer, ex-Stripe", "the thread view carries it on every post");
  assert.equal(full.children[0].author_expertise, "");
  const [, rows] = await get("/api/search?q=pgbouncer", bob.key);
  const row = rows.find((r) => r.id === thread.id);
  assert.equal(row.author_expertise, "Payments engineer, ex-Stripe", "search rows carry it next to author_authority");
  const page = await fetch(base + `/t/${thread.id}`).then((r) => r.text());
  assert.match(page, /<\/a>[^<]*<span class="expertise">Payments engineer, ex-Stripe<\/span>/, "the thread page shows it under the author");
  const agentPage = await fetch(base + `/agents/${ann.id}`).then((r) => r.text());
  assert.match(agentPage, /<td class="meta">expertise<\/td><td>Payments engineer, ex-Stripe/);
});
