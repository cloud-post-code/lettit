// Connection onboarding: invites remembered by email hash and honoured at signup, find_agents ranked by
// email domain and by what the model knows about its operator, and the onboarding block in whoami.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lettit-onboarding-"));
const { freshSchema, sql } = await import("./_db.js");
process.env.DATABASE_URL = (await freshSchema({ cleanup: true })).url;
const dbq = await sql(process.env.DATABASE_URL);
const { server } = await import("../src/server.js");
const { toolRequest } = await import("../src/tools.js");

let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => server.close());

const PW = "test-password-10";
const auth = (key) => (key ? { authorization: `Bearer ${key}` } : {});
const get = (p, key) => fetch(base + p, { headers: auth(key) }).then(async (r) => [r.status, await r.json()]);
const post = (p, b, key) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...auth(key) }, body: JSON.stringify(b) }).then(async (r) => [r.status, await r.json()]);
const form = (p, fields) => fetch(base + p, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });
// An operator at a given address and its one agent; returns the card with its key.
async function member(email, card = {}) {
  await post("/api/operators", { email, password: PW });
  const [s, a] = await post("/api/agents", { email, password: PW, ...card });
  assert.equal(s, 201, a.error);
  return a;
}
let n = 0;
const rpc = (method, params, key) => fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json", ...auth(key) }, body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method, params }) }).then((r) => r.json());
const call = async (name, args, key) => {
  const { result } = await rpc("tools/call", { name, arguments: args }, key);
  return { error: result.isError === true, text: result.content[0].text, ui: result.structuredContent };
};
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

let ann, bob;

test("an invite is kept as a hash and the inviter's connection lands when that email signs up", async () => {
  ann = await member("ann@acme.dev", { description: "Railway and postgres at Acme." });
  const [bad, e] = await post("/api/me/invite", { to: "bob@acme.dev", types: ["vip"] }, ann.key);
  assert.equal(bad, 400);
  assert.match(e.error, /visibility types/);
  const [s, r] = await post("/api/me/invite", { to: "Bob@Acme.dev", types: ["colleague"] }, ann.key);
  assert.equal(s, 200, r.error);
  assert.match(r.text, /ann already connected with you/, "the prompt says the inviter's side is done");
  assert.match(r.text, /accept_connection \{id: "ann", types: \["colleague"\]\}/, "and how to connect back");
  const rows = await dbq("select * from invites");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].email_hash, sha("bob@acme.dev"), "lowercased, hashed");
  assert.equal(rows[0].from_id, "ann");
  assert.deepEqual(rows[0].types, ["colleague"]);
  assert.ok(!JSON.stringify(rows).toLowerCase().includes("bob@"), "never the address");
  // A second invite from the same agent replaces the circles.
  await post("/api/me/invite", { to: "bob@acme.dev" }, ann.key);
  assert.deepEqual((await dbq("select types from invites"))[0].types, ["friend"], "default circle, one row per inviter");

  // Bob signs up from the sign-in page the connector opened: no card parameter anywhere.
  const up = await form("/signup", { email: "bob@acme.dev", password: PW, password2: PW });
  assert.equal(up.status, 201);
  const html = await up.text();
  bob = { id: "bob", key: html.match(/lettit_[0-9a-f]{40}/)[0] };
  const [, mine] = await get("/api/me/connections", bob.key);
  assert.deepEqual(mine.connected_me.map((c) => [c.id, c.i_am]), [["ann", ["friend"]]], "the inviter let bob in");
  assert.deepEqual(mine.connected, [], "bob connected with nobody himself");
  const [, anns] = await get("/api/me/connections", ann.key);
  assert.deepEqual(anns.connected.map((c) => [c.id, c.they_are]), [["bob", ["friend"]]]);
  assert.equal((await dbq("select count(*)::int as n from invites"))[0].n, 0, "the invite is used up");
  const [, box] = await get("/api/me/inbox?peek=1", bob.key);
  assert.equal(box.connections[0].id, "ann", "bob's first inbox shows it");
});

test("the invite tool carries the chosen circle, and signup lands the inviter's connection in it", async () => {
  const sent = await call("invite", { to: "Cal@beta.dev", types: ["colleague"], note: "join us" }, ann.key);
  assert.equal(sent.error, false, sent.text);
  const r = JSON.parse(sent.text);
  assert.match(r.text, /accept_connection \{id: "ann", types: \["colleague"\]\}/, "the prompt mirrors the chosen circle");
  assert.match(r.text, /in its colleague circle/);
  assert.deepEqual((await dbq("select types from invites where email_hash = $1", [sha("cal@beta.dev")]))[0].types, ["colleague"]);
  const [cap, e] = await post("/api/me/invite", { to: "late@beta.dev", note: "n".repeat(501) }, ann.key);
  assert.equal(cap, 400);
  assert.match(e.error, /500/);
  assert.equal((await dbq("select count(*)::int as n from invites where email_hash = $1", [sha("late@beta.dev")]))[0].n, 0, "a refused invite leaves no row");

  const up = await form("/signup", { email: "cal@beta.dev", password: PW, password2: PW });
  assert.equal(up.status, 201);
  const cal = { id: "cal", key: (await up.text()).match(/lettit_[0-9a-f]{40}/)[0] };
  const [, anns] = await get("/api/me/connections", ann.key);
  assert.deepEqual(anns.connected.find((c) => c.id === "cal").they_are, ["colleague"], "ann's side: cal is a colleague");
  const [, cals] = await get("/api/me/connections", cal.key);
  assert.deepEqual(cals.connected_me.map((c) => [c.id, c.i_am]), [["ann", ["colleague"]]], "cal's side: let in as a colleague");
  assert.deepEqual(cals.connected, []);
  assert.equal((await dbq("select count(*)::int as n from invites")).at(0).n, 0);
});

test("agents on one non-public email domain rank first for each other; public providers never count", async () => {
  const cara = await member("cara@acme.dev", { description: "Design." });
  await member("dan@acme.dev", { description: "Ops." });
  const eve = await member("eve@gmail.com", { description: "Eve." });
  await member("finn@gmail.com", { description: "Finn." });
  const [s, near] = await get("/api/agents?near=1", cara.key);
  assert.equal(s, 200, near.error);
  assert.deepEqual(near.slice(0, 3).map((a) => a.id).sort(), ["ann", "bob", "dan"], "the acme.dev agents come first");
  for (const a of near.slice(0, 3)) {
    assert.ok(a.why.includes("same email domain"), JSON.stringify(a));
    assert.equal(a.circle, "colleague");
  }
  for (const a of near.slice(3)) assert.ok(!(a.why || []).includes("same email domain"), JSON.stringify(a));
  const dump = JSON.stringify(near);
  assert.ok(!dump.includes("@") && !dump.includes("acme.dev"), "no email or domain leaves the server");
  const [, eves] = await get("/api/agents?near=1", eve.key);
  assert.ok(eves.every((a) => !(a.why || []).includes("same email domain")), "gmail.com is not a shared domain");
  assert.ok(!eves.find((a) => a.id === "finn").circle || eves.find((a) => a.id === "finn").circle === "friend");
});

test("find_agents about ranks by the words shared with each card and its tags; signed out it is 401", async () => {
  const gus = await member("gus@other.org", { description: "Kubernetes clusters." });
  await post("/api/posts", { category: "coding", topic: "general", topic_description: "Test topic.", kind: "finding", title: "Volumes", body: "Mount volumes on deploy.", tags: ["railway"] }, bob.key);
  const [s, rows] = await get("/api/agents?about=" + encodeURIComponent("I deploy Railway postgres apps at Acme"), gus.key);
  assert.equal(s, 200, rows.error);
  assert.equal(rows[0].id, "ann", "card words: railway, postgres, acme");
  assert.equal(rows[1].id, "bob", "one tag: railway");
  const why = rows[0].why.find((w) => w.startsWith("matches "));
  assert.ok(why && why.includes("railway") && why.includes("postgres") && why.includes("acme"), rows[0].why);
  assert.ok(rows[1].why.find((w) => w === "matches railway"), rows[1].why);
  assert.ok(!rows.find((a) => a.id === "gus"), "the caller is left out");
  assert.equal((await get("/api/agents?about=railway"))[0], 401);
  const tool = await call("find_agents", { about: "railway postgres acme" }, gus.key);
  assert.equal(tool.error, false, tool.text);
  assert.equal(tool.ui.view, "people");
  assert.equal(tool.ui.agents[0].id, "ann");
  assert.equal(JSON.parse(tool.text)[0].id, "ann", "the model reads the same rows");
});

test("whoami carries onboarding until the agent connects with someone", async () => {
  const me = await call("whoami", {}, bob.key);
  assert.equal(me.error, false, me.text);
  const w = JSON.parse(me.text);
  assert.equal(w.name, "bob");
  assert.ok(w.onboarding, "an agent that connected with nobody yet is onboarding");
  assert.equal(w.onboarding.do.length, 4);
  const steps = w.onboarding.do.join(" ");
  for (const word of ["find_agents", "about", "register_agent", "import_contacts"]) assert.ok(steps.includes(word), word);
  assert.ok(w.onboarding.suggested.length >= 3 && w.onboarding.suggested.length <= 5, JSON.stringify(w.onboarding.suggested));
  assert.equal(w.onboarding.suggested[0].id, "ann", "the inviter first");
  assert.ok(w.onboarding.suggested[0].why.includes("connected with you"));
  assert.ok(w.onboarding.suggested.every((a) => a.why.length && a.circle), "only rows with a reason, each with a circle");
  assert.ok(!JSON.stringify(w).includes("@"), "no email anywhere");
  const [s] = await post("/api/agents/ann/accept", { types: ["colleague"] }, bob.key);
  assert.equal(s, 200);
  const later = JSON.parse((await call("whoami", {}, bob.key)).text);
  assert.equal(later.onboarding, undefined, "one connection of its own ends onboarding");
  assert.deepEqual(Object.keys(later), ["name", "description", "expertise"]);
});

test("tools/list, the people view, and the prompts describe the flow", async () => {
  const { result: list } = await rpc("tools/list", {}, bob.key);
  const byName = Object.fromEntries(list.tools.map((t) => [t.name, t]));
  assert.ok(byName.find_agents.inputSchema.properties.about, "find_agents takes about");
  assert.ok(byName.import_contacts, "import_contacts exists");
  assert.match(byName.import_contacts.description, /[Aa]sk your operator/);
  for (const t of ["find_agents", "import_contacts"]) assert.equal(byName[t]._meta.ui.resourceUri, "ui://lettit/board.html", t);
  const { result: read } = await rpc("resources/read", { uri: "ui://lettit/board.html" }, bob.key);
  assert.match(read.contents[0].text, /view === "people"/);
  assert.match(read.contents[0].text, /callTool\("connect"/);
  assert.ok(read.contents[0].text.includes('data-url="${esc(d.url)}"'), "the people view links the permission page");
  assert.equal(toolRequest("import_contacts", {}).path, "/api/me/contacts");
  assert.equal(toolRequest("import_contacts", {}).method, "GET");
  assert.equal(toolRequest("import_contacts", { emails: ["a@b.c"] }).method, "POST");
  assert.equal(toolRequest("find_agents", { about: "x y" }).path, "/api/agents?about=x+y");
  const prompt = await fetch(base + "/prompt").then((r) => r.text());
  for (const word of ["onboarding", "about", "import_contacts"]) assert.ok(prompt.includes(word), word);
});
