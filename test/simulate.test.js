// Simulated users (src/simulate.js): on a seeded board, the scripted brain plays every prompt type once through the
// real API as the seed personas; the type rotates and the least-run agent is picked; every run is logged to sim_runs
// with its steps and served without bodies on /api/sim/runs; writes respect the per-day budget; the Claude brain
// speaks the Messages API shape (checked against a fake fetch); the scheduler runs on its interval and never twice at once.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lettit-sim-"));
const { freshSchema, sql } = await import("./_db.js");
process.env.DATABASE_URL = (await freshSchema({ cleanup: true })).url;
const dbq = await sql(process.env.DATABASE_URL);
const { server } = await import("../src/server.js");
const { readFixture, seedBoard, httpTransport, readKeys, DEFAULT_FIXTURE } = await import("../src/seed-fixture.js");
const { createSimulator, scriptedBrain, claudeBrain, dbStore, fileStore, publicRun, parseJson, keywords, fakeUserPrompt, productOf, subjectsOf, failureClass, supportsFallback, OCCASIONS, PROMPT_TYPES } = await import("../src/simulate.js");
const { WRITES } = await import("../src/tools.js");

let base, keys, sim;
const fixture = readFixture(DEFAULT_FIXTURE);
const keyFile = path.join(process.env.DATA_DIR, "seed-keys.json");
before(async () => {
  await new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); }));
  const report = await seedBoard({ request: httpTransport(base), base, fixture, keyFile, password: "seed-password-123" });
  assert.equal(report.ok, true);
  keys = readKeys(keyFile)[base].agents;
});
after(() => server.close());

// A deterministic random source so the picks and templates repeat.
const seeded = (s) => () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
const keyFor = async (handle) => keys[handle].key;
const logs = [];
const make = (opts = {}) => createSimulator({ request: httpTransport(base), fixture, brain: scriptedBrain({ random: seeded(7) }), store: dbStore(), keyFor, log: (m) => logs.push(m), random: seeded(11), ...opts });

test("ten runs play every prompt type in rotation, each by a different least-run agent, through the real API", async () => {
  sim = make();
  const runs = [];
  for (let i = 0; i < PROMPT_TYPES.length; i++) runs.push(await sim.run());
  assert.deepEqual(runs.map((r) => r.prompt_type), PROMPT_TYPES.map((t) => t.id), "types rotate in order");
  assert.equal(new Set(runs.map((r) => r.agent_id)).size, runs.length, "an agent is not picked again while others have fewer runs");
  for (const r of runs) {
    assert.equal(r.ok, true, `${r.prompt_type} as ${r.agent_id}: ${r.error}`);
    assert.ok(r.task && r.prompt, "task and prompt invented");
    assert.ok(OCCASIONS.includes(r.context.occasion), "an occasion was drawn");
    assert.ok(Array.isArray(r.context.recent_posts) && r.context.recent_posts.length >= 1 && r.context.recent_posts[0].title, "the persona's recent posts were read for context");
    assert.ok(r.context.inbox && typeof r.context.inbox.replies === "number", "the inbox was peeked for context");
    assert.ok(!/\b(catch-up|share-finding|near_duplicate)\b/.test(r.prompt), "the prompt never names the request kind");
    assert.ok(r.steps.length >= 1, `${r.prompt_type} made calls`);
    assert.ok(r.outcome, "a closing note");
    const t = PROMPT_TYPES.find((x) => x.id === r.prompt_type);
    for (const s of r.steps) {
      assert.ok(t.tools.includes(s.tool), `${r.prompt_type} used only its tools (${s.tool})`);
      assert.ok(s.status === 0 || s.status < 500, `${s.tool} did not 5xx: ${s.error}`);
      assert.equal(typeof s.ms, "number");
    }
    assert.equal(r.writes, r.steps.filter((s) => WRITES.has(s.tool) && s.status >= 200 && s.status < 300).length, "writes counted");
    assert.ok(r.writes <= 3);
    // Every call the board accepted was read back and found as sent; nothing failed on the board's side.
    for (const s of r.steps.filter((x) => x.status >= 200 && x.status < 300)) assert.equal(s.check?.ok, true, `${r.prompt_type}/${s.tool}: ${s.check?.detail}`);
    for (const s of r.steps.filter((x) => x.status >= 400 || x.status === 0)) assert.ok(["etiquette", "model", "harness"].includes(s.failure), `${s.tool} ${s.status} ${s.error} classed ${s.failure}`);
    assert.equal(r.checks.passed, r.steps.filter((x) => x.check?.ok).length);
    assert.equal(r.checks.failed, 0);
    assert.deepEqual(r.anomalies, [], `${r.prompt_type}: ${JSON.stringify(r.anomalies)}`);
  }
  const verifiedWrites = runs.flatMap((r) => r.steps).filter((s) => WRITES.has(s.tool) && s.check?.ok);
  const kinds = new Set(verifiedWrites.map((s) => s.tool));
  assert.ok(kinds.has("register_agent") && (kinds.has("post") || kinds.has("reply")) && kinds.size >= 3, `verified writes of several kinds: ${[...kinds].join(",")}`);
  const posted = verifiedWrites.find((s) => s.tool === "post" || s.tool === "reply");
  assert.match(posted.check.detail, /reads back/);
  assert.ok(logs.some((m) => / checks \d+\/\d+/.test(m)) && !logs.some((m) => /ANOMALIES/.test(m)));
  const writes = runs.reduce((n, r) => n + r.writes, 0);
  assert.ok(writes >= 5, `the cycle wrote to the board (${writes} writes)`);
  assert.ok(runs.find((r) => r.prompt_type === "research").writes === 0, "research is read-only");
  assert.ok(logs.some((m) => /^sim research as /.test(m)));
  assert.ok(!logs.join("\n").includes("lettit_"), "no key in the log");
});

test("the log lands in sim_runs with steps, and the public view carries no bodies", async () => {
  const [{ n }] = await dbq("select count(*)::int as n from sim_runs");
  assert.equal(n, PROMPT_TYPES.length);
  const [{ steps }] = await dbq("select steps from sim_runs where prompt_type = 'share-finding'");
  assert.ok(steps.length >= 1 && steps[0].tool && "args" in steps[0]);
  const rows = await fetch(`${base}/api/sim/runs?limit=5`).then((r) => r.json());
  assert.equal(rows.length, 5);
  for (const r of rows) {
    assert.deepEqual(Object.keys(r).filter((k) => ["outcome", "steps", "body"].includes(k)), [], "no outcome, steps, or body");
    assert.ok(Array.isArray(r.tools) && r.tools.every((t) => !("args" in t) && !("result" in t)));
    assert.ok(r.agent && r.type && r.task && r.prompt && r.occasion);
  }
  const [{ context }] = await dbq("select context from sim_runs where prompt_type = 'research'");
  assert.ok(OCCASIONS.includes(context.occasion) && context.inbox);
  const one = await fetch(`${base}/api/sim/runs?type=tidy`).then((r) => r.json());
  assert.equal(one.length, 1);
  assert.equal(one[0].type, "tidy");
  const bad = await fetch(`${base}/api/sim/runs?limit=abc`).then((r) => r.status);
  assert.equal(bad, 200);
  assert.ok(rows.every((r) => r.checks && Array.isArray(r.anomalies) && r.tools.every((t) => t.status < 200 || t.status >= 300 || t.check === true)));
});

test("the tool-call report: every tool exercised by the cycle, verified, no board errors, coverage named", async () => {
  const report = await fetch(`${base}/api/sim/report`).then((r) => r.json());
  assert.equal(report.healthy, true, JSON.stringify(report.anomalies));
  assert.equal(report.runs.runs, PROMPT_TYPES.length);
  assert.equal(report.runs.failed, 0);
  assert.equal(report.runs.checks_failed, 0);
  assert.ok(report.runs.checks_passed > 20);
  assert.equal(report.runs.anomalies, 0);
  const byTool = Object.fromEntries(report.tools.map((r) => [r.tool, r]));
  // Tools every cycle reaches whatever the board holds; the rest depend on what search and the inbox turn up.
  const ALWAYS = ["inbox", "connections", "search", "read_threads", "visibility_types", "my_posts", "find_agents", "whoami", "register_agent", "recent"];
  const STATE = ["browse", "post", "reply", "upvote", "edit", "get_agent", "connect", "accept_connection", "set_visibility"];
  for (const name of ALWAYS) {
    assert.ok(byTool[name], `${name} was called`);
    assert.equal(byTool[name].board, 0, name);
    assert.equal(byTool[name].failed_checks, 0, name);
    assert.ok(byTool[name].verified >= 1 || byTool[name].ok === 0, `${name} verified when it succeeded`);
    assert.ok(typeof byTool[name].avg_ms === "number");
  }
  assert.ok(report.uncovered.every((t) => STATE.includes(t)), `only state-dependent tools may be uncovered after one cycle: ${report.uncovered}`);
  for (const r of report.tools) { assert.equal(r.board, 0, r.tool); assert.equal(r.failed_checks, 0, r.tool); assert.ok(r.ok === 0 || r.verified >= 1, `${r.tool} verified when it succeeded`); }
  assert.ok(Array.isArray(report.errors) && report.errors.every((e) => e.failure !== "board"));
  const week = await fetch(`${base}/api/sim/report?week=99`).then((r) => r.json());
  assert.equal(week.runs.runs, 0);
  assert.deepEqual(failureClass(0), "harness");
  assert.deepEqual(failureClass(503), "board");
  assert.deepEqual(failureClass(409, "already upvoted"), "etiquette");
  assert.deepEqual(failureClass(400, "draft overlaps post x by 20%; an upvote needs 60%. Your draft adds something: reply to it instead"), "etiquette");
  assert.deepEqual(failureClass(404, "post not found"), "model");
  assert.deepEqual(failureClass(400, "body required"), "model");
});

test("the /sim page is the sheet: report, per-tool table, and every run with its prompt and calls, without bodies", async () => {
  const [status, html] = await fetch(`${base}/sim`).then(async (r) => [r.status, await r.text()]);
  assert.equal(status, 200);
  assert.match(html, /<h1>Simulated users<\/h1>/);
  assert.match(html, /<b>healthy<\/b>: every accepted call read back as sent/);
  assert.match(html, /<td>search<\/td><td>\d+<\/td><td>\d+<\/td><td>\d+<\/td>/, "a per-tool row with calls, 2xx, verified");
  for (const r of await fetch(`${base}/api/sim/runs?limit=100`).then((x) => x.json())) {
    assert.ok(html.includes(`href="/agents/${r.agent}"`), r.agent);
    assert.ok(html.includes(r.prompt.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])).slice(0, 40)), `prompt shown: ${r.prompt.slice(0, 40)}`);
  }
  const outcomes = await dbq("select outcome from sim_runs where outcome is not null and length(outcome) > 20");
  for (const { outcome } of outcomes) assert.ok(!html.includes(outcome.slice(0, 60).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]))), "no closing note on the public sheet");
  assert.ok(!html.includes("lettit_"), "no key");
  const [, filtered] = await fetch(`${base}/sim?type=tidy&limit=5`).then(async (r) => [r.status, await r.text()]);
  assert.match(filtered, /value="tidy"/);
  assert.equal((filtered.match(/<div class="meta">tidy/g) || []).length, 1);
  assert.ok(!/<div class="meta">research/.test(filtered));
  const [, none] = await fetch(`${base}/sim?week=77`).then(async (r) => [r.status, await r.text()]);
  assert.match(none, /no runs match/);
});

test("a spent daily write budget makes a run read-only, and a write beyond the per-run cap is refused", async () => {
  const tight = make({ maxWritesPerDay: 0 });
  const r = await tight.run({ type: "share-finding" });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.writes, 0);
  assert.ok(r.steps.filter((s) => WRITES.has(s.tool)).every((s) => s.status === 0 && /not available/.test(s.error)), JSON.stringify(r.steps.map((s) => [s.tool, s.status, s.error])));
  const capped = make({ maxWritesPerRun: 0 });
  const r2 = await capped.run({ type: "status" });
  assert.equal(r2.ok, true, r2.error);
  assert.equal(r2.writes, 0);
  assert.ok(r2.steps.some((s) => s.tool === "post" && /write budget/.test(s.error || "")));
});

test("an unknown handle or type fails the run and is still logged", async () => {
  await assert.rejects(sim.run({ handle: "nobody" }), /unknown handle/);
  await assert.rejects(sim.run({ type: "nope" }), /unknown prompt type/);
  const broken = make({ keyFor: async () => "lettit_" + "0".repeat(40) });
  const r = await broken.run({ type: "research" });
  assert.equal(r.ok, false);
  assert.match(r.error, /cannot sign in/);
  const [{ n }] = await dbq("select count(*)::int as n from sim_runs where ok = false");
  assert.equal(n, 1);
});

test("the Claude brain speaks the Messages API: invents from JSON, runs the tool loop, feeds errors back", async () => {
  const requests = [];
  const replies = [
    { content: [{ type: "text", text: '```json\n{"task": "Shipping the approval flow this week.", "prompt": "Find what the board says about approval flows and brief me."}\n```' }], stop_reason: "end_turn", usage: { input_tokens: 120, output_tokens: 30 } },
    { content: [{ type: "text", text: "Searching." }, { type: "tool_use", id: "toolu_1", name: "search", input: { q: "approval flow" } }, { type: "tool_use", id: "toolu_2", name: "post", input: { category: "x" } }], stop_reason: "tool_use", usage: { input_tokens: 2000, output_tokens: 50, cache_read_input_tokens: 1500 } },
    { content: [{ type: "text", text: "Diego's handoff thread covers the approval API; nothing to add." }], stop_reason: "end_turn", usage: { input_tokens: 2200, output_tokens: 40, cache_read_input_tokens: 1500 } },
  ];
  const fetchFn = async (url, init) => { requests.push({ url, init: { ...init, body: JSON.parse(init.body) } }); const r = replies.shift(); return { ok: true, status: 200, json: async () => r }; };
  const brain = claudeBrain({ apiKey: "sk-test", fetchFn, model: "claude-opus-5-5" });
  const s2 = createSimulator({ request: httpTransport(base), fixture, brain, store: fileStore(path.join(process.env.DATA_DIR, "runs.jsonl")), keyFor, random: seeded(3) });
  const r = await s2.run({ handle: "diego.codes", type: "research" });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.brain, "claude");
  assert.equal(r.model, "claude-opus-5-5");
  assert.equal(r.task, "Shipping the approval flow this week.");
  assert.match(r.prompt, /approval flows/);
  assert.equal(r.outcome, "Diego's handoff thread covers the approval API; nothing to add.");
  assert.deepEqual(r.tokens, { input: 4320, output: 120, cache_read: 3000 });
  assert.equal(requests.length, 3);
  const [invent, act, act2] = requests.map((x) => x.init);
  assert.equal(requests[0].url, "https://api.anthropic.com/v1/messages");
  assert.equal(invent.headers["x-api-key"], "sk-test");
  assert.equal(invent.headers["anthropic-version"], "2026-10-21");
  assert.equal(invent.headers["anthropic-beta"], "server-side-fallback-2026-07-01");
  assert.equal(invent.body.model, "claude-opus-5-5");
  assert.equal(invent.body.fallbacks, "default");
  assert.deepEqual(invent.body.output_config, { effort: "low" });
  assert.equal("thinking" in invent.body, false, "thinking is left to the model's default");
  assert.match(invent.body.system, /JSON only/);
  assert.match(invent.body.system, /Real prompts read like messages/);
  assert.match(invent.body.messages[0].content, /Right now: .+\.\nWhat they have on the board lately, for your orientation only \(the person remembers these loosely and would never quote a title\): "/);
  assert.match(invent.body.messages[0].content, /Waiting in their inbox: \d+ replies, \d+ upvotes, \d+ new connections/);
  assert.match(invent.body.messages[0].content, /Writes about: .*client projects/);
  assert.match(invent.body.messages[0].content, /Kind of request: Find out what the board knows/);
  assert.deepEqual(act.body.tools.map((t) => t.name), ["search", "read_threads", "browse"], "only the type's tools");
  assert.ok(act.body.tools.every((t) => t.input_schema && t.description));
  assert.deepEqual(act.body.tools.at(-1).cache_control, { type: "ephemeral", ttl: "1h" });
  assert.match(act.body.system, /Diego Santos/);
  assert.match(act.body.system, /"research"/);
  assert.deepEqual(act.body.messages, [{ role: "user", content: "Find what the board says about approval flows and brief me." }]);
  assert.equal(act2.body.messages.length, 3);
  assert.equal(act2.body.messages[1].role, "assistant");
  const results = act2.body.messages[2].content;
  assert.equal(results.length, 2, "both tool results in one user message");
  assert.deepEqual(results.map((x) => [x.type, x.tool_use_id]), [["tool_result", "toolu_1"], ["tool_result", "toolu_2"]]);
  assert.equal(results[0].is_error, undefined);
  assert.match(results[0].content, /Handoff: approval flow API is done|No Results Match|title/);
  assert.equal(results[1].is_error, true, "post is not a research tool");
  assert.match(results[1].content, /not available in this run/);
  assert.deepEqual(r.steps.map((s) => [s.tool, s.status]), [["search", 200], ["post", 0]]);
  assert.equal(r.steps[0].check.ok, true);
  assert.equal(r.steps[1].failure, "harness");
  assert.deepEqual(r.checks, { passed: 1, failed: 0 });
  const logged = fs.readFileSync(path.join(process.env.DATA_DIR, "runs.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(logged.length, 1);
  assert.equal(logged[0].id, r.id);
  assert.equal(publicRun(logged[0]).outcome, undefined);
  const refusal = claudeBrain({ apiKey: "sk-test", fetchFn: async () => ({ ok: false, status: 429, json: async () => ({ error: { message: "rate limited" } }) }) });
  const s3 = createSimulator({ request: httpTransport(base), fixture, brain: refusal, store: fileStore(path.join(process.env.DATA_DIR, "runs2.jsonl")), keyFor });
  const bad = await s3.run({ handle: "leof", type: "ask" });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /claude 429: rate limited/);
  assert.deepEqual(bad.anomalies, [], "an API outage is a failed run, not a board anomaly");
  // Haiku 5.5 has no server-side refusal fallback: neither the beta header nor the parameter is sent.
  const seen = [];
  const haiku = claudeBrain({ apiKey: "sk-test", model: "claude-haiku-5-5", fetchFn: async (url, init) => { seen.push({ ...init, body: JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: '{"task":"t","prompt":"p"}' }], stop_reason: "end_turn", usage: {} }) }; } });
  await haiku.invent({ persona: fixture.people[0], type: PROMPT_TYPES[1] });
  assert.equal(seen[0].body.model, "claude-haiku-5-5");
  assert.equal("fallbacks" in seen[0].body, false);
  assert.equal("anthropic-beta" in seen[0].headers, false);
  assert.deepEqual(seen[0].body.output_config, { effort: "low" });
  assert.equal(supportsFallback("claude-opus-5-5"), true);
  assert.equal(supportsFallback("claude-sonnet-5-5"), true);
  assert.equal(supportsFallback("claude-haiku-5-5"), false);
});

test("scripted prompts read like the person: their product, their subjects, their voice, varied across runs", () => {
  const type = (id) => PROMPT_TYPES.find((x) => x.id === id);
  const person = (h) => ({ ...fixture.people.find((x) => x.handle === h), subjects: subjectsOf(fixture, h) });
  assert.equal(productOf(person("mayabuilds")), "ShiftSwap");
  assert.equal(productOf(person("aishab")), "Kindred Kitchens");
  assert.equal(productOf(person("prof.rossi")), "my class");
  assert.equal(productOf(person("zoeadams")), "the budgeting app");
  assert.deepEqual(subjectsOf(fixture, "dreyes"), ["payments and billing", "backend and database"]);
  const ctx = { recent_posts: [{ title: "Make Stripe webhook handlers idempotent", kind: "procedure", replies: 3, upvotes: 0 }], inbox: { replies: 2, upvotes: 1, connections: 1 } };
  const seen = new Set();
  for (let i = 0; i < 12; i++) {
    const { task, prompt } = fakeUserPrompt(person("dreyes"), type("share-finding"), { occasion: OCCASIONS[i % OCCASIONS.length], context: ctx, random: seeded(100 + i) });
    assert.ok(/LedgerLite|payments and billing|backend and database/.test(prompt), prompt);
    assert.ok(!/share-finding|LETTIT/.test(prompt));
    assert.ok(prompt.length > 30 && prompt.length < 400);
    assert.match(task, /Daniel Reyes, .*LedgerLite/);
    seen.add(prompt);
  }
  assert.ok(seen.size >= 3, `varied prompts: ${seen.size}`);
  // Voice: the terse engineer writes one sentence; the beginner hedges and asks for an explanation; the skeptic asks back.
  for (let i = 0; i < 6; i++) { const terse = fakeUserPrompt(person("dreyes"), type("research"), { context: ctx, random: seeded(20 + i) }).prompt; assert.ok(!/When you have a moment|Quick one|Hey,|Morning\.|Keep it factual|new to this/.test(terse), terse); }
  const beginner = fakeUserPrompt(person("chloe.m"), type("ask"), { context: ctx, random: seeded(2) }).prompt;
  assert.match(beginner, /PlantPal/);
  assert.match(beginner, /like I am new to this/);
  const skeptic = fakeUserPrompt(person("prof.rossi"), type("pushback"), { context: ctx, random: seeded(3) }).prompt;
  assert.match(skeptic, /what would change my mind\?$/);
  const catchUp = fakeUserPrompt(person("jessmakes"), type("catch-up"), { context: ctx, random: seeded(4) }).prompt;
  assert.ok(/2 replies waiting|my post about stripe webhook|GroomBook/.test(catchUp), catchUp);
  assert.ok(!catchUp.includes('"'), "no thread title is quoted");
  const tidy = fakeUserPrompt(person("cnovak"), type("tidy"), { context: ctx, random: seeded(6) }).prompt;
  assert.ok(!tidy.includes('"'), tidy);
  // This quarter's work shows up in what they ask for.
  const withBeat = fakeUserPrompt(person("mayabuilds"), type("status"), { context: ctx, random: seeded(7), beat: "Pilot live on 2 hospital units; building charge-nurse approval with Pixelfold." }).prompt;
  assert.ok(/pilot live on 2 hospital units|ShiftSwap/.test(withBeat), withBeat);
  // Every type has a prompt for every persona.
  for (const p of fixture.people) for (const ty of PROMPT_TYPES) assert.ok(fakeUserPrompt(person(p.handle), ty, { random: seeded(5) }).prompt.length > 20, `${p.handle} ${ty.id}`);
});

test("helpers: lenient JSON, keywords, persona picking by least runs", async () => {
  assert.deepEqual(parseJson('Sure: {"task": "a", "prompt": "b"} done'), { task: "a", prompt: "b" });
  assert.equal(parseJson("nonsense"), null);
  assert.deepEqual(keywords("Tests written before the code keep AI-generated code honest.", 3), ["tests", "written", "before"]);
  const { person, type } = await sim.pick();
  assert.equal(type.id, PROMPT_TYPES[(PROMPT_TYPES.length + 3) % PROMPT_TYPES.length].id, "rotation continues from the total so far (13 runs logged)");
  const h = await dbStore().history();
  assert.equal(h.byAgent.get(person.handle.replace(/[^a-z0-9]+/g, "-")) || 0, 0, "a persona with no runs yet is picked first");
});

test("the scheduler runs on its interval and never overlaps", async () => {
  const slow = make({ brain: { name: "slow", model: null, invent: async () => ({ task: "t", prompt: "p" }), act: async ({ call }) => { await call("whoami", {}); await new Promise((r) => setTimeout(r, 120)); return { outcome: "done" }; } }, maxSteps: 2 });
  const beforeN = (await dbq("select count(*)::int as n from sim_runs"))[0].n;
  slow.start(40, { delayMs: 0 });
  await new Promise((r) => setTimeout(r, 330));
  slow.stop();
  const during = slow.running;
  await new Promise((r) => setTimeout(r, 200));
  const afterN = (await dbq("select count(*)::int as n from sim_runs"))[0].n;
  const made = afterN - beforeN;
  assert.ok(made >= 2 && made <= 4, `ran ${made} times in 330ms with 120ms runs on a 40ms interval: no overlap`);
  assert.equal(typeof during, "boolean");
  const whoami = await dbq("select steps from sim_runs where brain = 'slow' limit 1");
  assert.equal(whoami[0].steps[0].tool, "whoami");
});
