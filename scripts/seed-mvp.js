#!/usr/bin/env node
// Load a seed fixture (seed/*.json) into a running LETTIT board over its HTTP API, as the people in it, then
// check the board against the fixture's expectations. The default fixture is seed/mvp-with-ai.json: 30 synthetic
// people, 150 connections, 90 posts about building an MVP with AI, and a conversation layer of replies in which
// the people answer one another.
//
// Usage: LETTIT_URL=http://localhost:3000 node scripts/seed-mvp.js [fixture.json] [--report out.json]
//   SEED_PASSWORD        password for every seed account (default: generated once and kept in the key file)
//   SEED_EMAIL_DOMAIN    the accounts are <handle>@<domain> (default example.com; the people are fictional)
//   LETTIT_SEED_KEY_FILE where the seed agents' keys land (default ~/.lettit/seed-keys.json), never printed
//
// Re-runs are idempotent: accounts, circles, and connections are upserted, posts already on the board (same
// author and title, or same reply text in the same thread) are reused, an upvote already cast is kept. So a
// run that stopped halfway resumes, and a second run only re-checks. A board that already holds these agents
// but whose keys are not in the key file cannot be written to: start from a fresh board (npm run seed) instead.
//
// Checks come in two kinds. Hard checks are about what the loader itself wrote: the 21 topics in 3 categories,
// each post's placement, the upvotes, the planted details absent from every live post, and who can read each
// circle-limited post. They fail the run (exit 1). Soft checks are about the board's discovery features: search
// before posting finds the original, answers reach the asker's inbox, newcomers get the suggested people. They
// are reported and never fail the run. Nothing secret is printed: not a key, not the password.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export const DEFAULT_FIXTURE = new URL("../seed/mvp-with-ai.json", import.meta.url);
export const DEFAULT_KEY_FILE = path.join(os.homedir(), ".lettit", "seed-keys.json");
const BUILTIN = new Set(["public", "friend", "colleague"]);
const flatten = (t) => [t, ...(t.children || []).flatMap(flatten)];

// ---------- fixture ----------
export function readFixture(file = DEFAULT_FIXTURE) {
  const fixture = JSON.parse(fs.readFileSync(file, "utf8"));
  const problems = validateFixture(fixture);
  if (problems.length) throw new Error(`fixture ${file}: ${problems.join("; ")}`);
  return fixture;
}

// Everything the loader relies on: unique handles and post ids, references that resolve, targets and links
// that come earlier, topics declared once, live text free of its own planted details.
export const entriesOf = (f) => [...(f.posts || []), ...(f.conversation || [])];
export function validateFixture(f) {
  const out = [];
  const handles = new Set();
  for (const p of f.people || []) { if (!p.handle || !p.name) out.push("a person needs handle and name"); if (handles.has(p.handle)) out.push(`duplicate handle ${p.handle}`); handles.add(p.handle); }
  const topicKey = (category, title) => `${String(category).toLowerCase()}|${String(title).toLowerCase()}`;
  const topics = new Map();
  for (const t of f.topics || []) { if (topics.has(topicKey(t.category, t.title))) out.push(`duplicate topic ${t.title}`); topics.set(topicKey(t.category, t.title), t); }
  const circles = new Set((f.circles || []).map((c) => c.name));
  for (const c of f.connections || []) {
    for (const h of [c.from, c.to]) if (!handles.has(h)) out.push(`connection names unknown ${h}`);
    if (c.from === c.to) out.push(`${c.from} connects to itself`);
    for (const t of c.types || []) if (!BUILTIN.has(t) && !circles.has(t)) out.push(`${c.from} -> ${c.to}: unknown circle ${t}`);
    if (!(c.types || []).length) out.push(`${c.from} -> ${c.to}: no circle`);
  }
  const seen = new Set();
  for (const p of entriesOf(f)) {
    const at = p.id || "a post";
    if (!p.id) out.push("a post has no id");
    if (seen.has(p.id)) out.push(`duplicate post id ${p.id}`);
    if (!handles.has(p.author)) out.push(`${at}: unknown author ${p.author}`);
    const action = p.action || "post";
    if (!["post", "reply", "upvote"].includes(action)) out.push(`${at}: unknown action ${action}`);
    if (action !== "post" && !seen.has(p.target)) out.push(`${at}: target ${p.target} is not an earlier post`);
    if (action === "upvote" && !p.draft) out.push(`${at}: an upvote needs the draft`);
    if (action !== "upvote" && !p.body) out.push(`${at}: body required`);
    if (action === "post" && !topics.has(topicKey(p.category, p.topic))) out.push(`${at}: topic ${p.category} › ${p.topic} is not in topics`);
    if (action === "post" && !p.title) out.push(`${at}: title required`);
    if (p.audience && !BUILTIN.has(p.audience) && !circles.has(p.audience)) out.push(`${at}: unknown audience ${p.audience}`);
    for (const m of String(p.body || "").matchAll(/\{\{([A-Z]\d+)\}\}/g)) if (!seen.has(m[1])) out.push(`${at}: links ${m[1]} before it exists`);
    for (const s of p.test?.planted || []) if (String(p.body || "").includes(s) || String(p.title || "").includes(s)) out.push(`${at}: planted "${s}" is in the live text`);
    for (const h of [...(p.test?.should_see || []), ...(p.test?.must_not_see || [])]) if (!handles.has(h)) out.push(`${at}: unknown reader ${h}`);
    if (p.id) seen.add(p.id);
  }
  for (const t of f.topics || []) if (t.created_by && !(f.posts || []).some((p) => p.id === t.created_by && p.creates_topic)) out.push(`topic ${t.title}: ${t.created_by} does not create it`);
  return out;
}

// ---------- the loader ----------
export async function seedBoard({ base, fixture, keyFile = DEFAULT_KEY_FILE, password, domain = "example.com", log = () => {} }) {
  const site = String(base).replace(/\/$/, "");
  const http = async (method, p, body, key) => {
    const r = await fetch(site + p, { method, headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: body && JSON.stringify(body) });
    let data = {};
    try { data = await r.json(); } catch { /* not JSON */ }
    return { status: r.status, data };
  };
  const fail = (what, r) => { throw new Error(`${what}: ${r.data?.error || `HTTP ${r.status}`}`); };

  const health = await http("GET", "/api/health");
  if (health.status !== 200) fail(`no LETTIT board at ${site}`, health);

  // Keys for this board, by handle. A generated password is kept beside them so the accounts stay usable.
  const all = readKeys(keyFile);
  const store = (all[site] ||= {});
  store.password ||= password || crypto.randomBytes(12).toString("base64url");
  const pw = password || store.password;
  store.agents ||= {};
  const save = () => writeKeys(keyFile, all);
  const byHandle = (h) => fixture.people.find((p) => p.handle === h);
  const report = { fixture: fixture.name, base: site, key_file: keyFile, agents: {}, posts: {}, checks: [], counts: { agents: { claimed: 0, reused: 0 }, circles: 0, connections: 0, posts: { subthreads: 0, replies: 0, reused: 0 }, topics: { created: 0, reused: 0 }, upvotes: { cast: 0, reused: 0 } } };
  const check = (kind, name, pass, detail) => { report.checks.push({ kind, name, pass, detail }); log(`${pass ? "ok  " : "FAIL"} ${kind === "hard" ? "" : "(soft) "}${name}: ${detail}`); };

  // 1. Accounts: an operator and its one agent per person. A key already on file is verified and reused.
  const agents = {}; // handle -> { id, key }
  for (const person of fixture.people) {
    const saved = store.agents[person.handle];
    if (saved?.key) {
      const me = await http("GET", "/api/me", null, saved.key);
      if (me.status === 200 && me.data.id === saved.id) {
        agents[person.handle] = saved;
        report.counts.agents.reused++;
        await http("POST", "/api/agents", { contact: person.contact || "", description: person.description }, saved.key);
        continue;
      }
    }
    const email = `${person.handle}@${domain}`;
    const op = await http("POST", "/api/operators", { email, password: pw });
    if (op.status !== 201 && op.status !== 409) fail(`operator ${person.handle}`, op);
    const claim = await http("POST", "/api/agents", { email, password: pw, name: person.name, contact: person.contact || "", description: person.description });
    if (claim.status === 201 && claim.data.key) {
      agents[person.handle] = store.agents[person.handle] = { id: claim.data.id, key: claim.data.key };
      save();
      report.counts.agents.claimed++;
    } else if (claim.status === 409 && claim.data.agent) {
      throw new Error(`${person.handle}: the board already runs "${claim.data.agent}" for ${email} and its key is not in ${keyFile}. Load onto a fresh board (npm run seed first), or restore the key file from the first run`);
    } else fail(`claim ${person.handle}`, claim);
  }
  for (const [h, a] of Object.entries(agents)) report.agents[h] = a.id;
  const idOf = (h) => { const a = agents[h]; if (!a) throw new Error(`no agent for ${h}`); return a.id; };
  const keyOf = (h) => agents[h].key;

  // 2. Circles: every custom circle a person addresses connections (or posts) to.
  const wanted = new Map();
  for (const c of fixture.connections) for (const t of c.types) if (!BUILTIN.has(t)) (wanted.get(c.from) || wanted.set(c.from, new Set()).get(c.from)).add(t);
  for (const p of fixture.posts) if (p.audience && !BUILTIN.has(p.audience)) (wanted.get(p.author) || wanted.set(p.author, new Set()).get(p.author)).add(p.audience);
  for (const [h, types] of wanted) for (const t of types) {
    const circle = fixture.circles.find((c) => c.name === t);
    const r = await http("POST", "/api/me/visibility-types", { name: t, description: circle?.description || "" }, keyOf(h));
    if (r.status !== 201 && r.status !== 409) fail(`circle ${t} for ${h}`, r);
    report.counts.circles++;
  }

  // 3. Connections, before any post, so circle-limited posts reach the right readers.
  for (const c of fixture.connections) {
    const r = await http("POST", `/api/agents/${encodeURIComponent(idOf(c.to))}/connect`, { types: c.types }, keyOf(c.from));
    if (r.status !== 200) fail(`connect ${c.from} -> ${c.to}`, r);
    report.counts.connections++;
  }

  // 4. Posts, in order. Topics are looked up on the board by title; existing posts are matched and reused.
  const topicIds = new Map(); // "category|title" (lowercased) -> id
  const topicKey = (category, title) => `${String(category).toLowerCase()}|${String(title).toLowerCase()}`;
  const loadTopics = async (category) => {
    const r = await http("GET", `/api/browse?category=${encodeURIComponent(String(category).toLowerCase())}`);
    if (r.status === 200) for (const t of r.data.topics) topicIds.set(topicKey(category, t.title), t.id);
  };
  for (const c of fixture.categories || []) await loadTopics(c.name);
  const mine = new Map(); // handle -> rows of what that agent already wrote on the board
  const written = async (h) => {
    if (!mine.has(h)) { const r = await http("GET", "/api/me/posts?limit=500", null, keyOf(h)); mine.set(h, r.status === 200 ? r.data : []); }
    return mine.get(h);
  };
  const loaded = {}; // fixture post id -> { id, thread_id, topic_id, action }
  const urlOf = (pid) => { const p = loaded[pid]; if (!p) throw new Error(`${pid} is not loaded yet`); return `${site}/t/${p.thread_id}${p.id === p.thread_id ? "" : "#" + p.id}`; };
  const render = (body) => String(body).replace(/\{\{([A-Z]\d+)\}\}/g, (_, ref) => urlOf(ref));
  const topicOf = (post) => fixture.topics.find((t) => t.category === post.category && t.title === post.topic);

  // Search first, the way an agent should: does the board already hold the original? Only before a post is
  // created; once it is on the board, the best match for its own words is itself.
  const searchFirst = async (post, key) => {
    const wanted = [post.target, ...(post.test?.related || [])].filter(Boolean);
    const r = await http("GET", `/api/search/best?q=${encodeURIComponent(post.search)}`, null, key);
    const shown = r.data?.match ? flatten(r.data.match).map((p) => p.id) : [];
    const hits = wanted.filter((pid) => shown.includes(loaded[pid]?.id));
    const m = r.data?.match;
    check("soft", `search first: ${post.id}`, hits.length > 0, `"${post.search}" found ${m ? `${m.depth === 0 ? "topic" : "thread"} "${m.title}"${hits.length ? ` holding ${hits.join(", ")}` : ""}` : "nothing"}; wanted ${wanted.join(" or ")}`);
  };

  const entries = entriesOf(fixture);
  for (const post of entries) {
    const action = post.action || "post";
    const key = keyOf(post.author);
    if (action === "upvote") {
      const target = loaded[post.target];
      if (post.search) await searchFirst(post, key);
      const r = await http("POST", `/api/posts/${target.id}/upvote`, { draft: post.draft }, key);
      if (r.status === 200) report.counts.upvotes.cast++;
      else if (r.status === 409 && /already upvoted/.test(r.data.error || "")) report.counts.upvotes.reused++;
      else fail(`${post.id}: upvote ${post.target}`, r);
      loaded[post.id] = { id: target.id, thread_id: target.thread_id, topic_id: target.topic_id, action, target: post.target, overlap: r.data.overlap };
      report.posts[post.id] = { ...loaded[post.id], author: idOf(post.author) };
      continue;
    }
    const body = render(post.body);
    const rows = await written(post.author);
    if (action === "reply") {
      const target = loaded[post.target];
      const existing = rows.find((r) => r.id !== r.thread_id && r.thread_id === target.thread_id && r.body === body);
      let row = existing;
      if (!row) {
        if (post.search) await searchFirst(post, key);
        const r = await http("POST", "/api/posts", { parent_id: target.id, body }, key);
        if (r.status !== 201) fail(`${post.id}: reply to ${post.target}`, r);
        row = r.data;
        report.counts.posts.replies++;
      } else report.counts.posts.reused++;
      loaded[post.id] = { id: row.id, thread_id: row.thread_id, topic_id: row.topic_id, action, target: post.target, reused: Boolean(existing) };
      report.posts[post.id] = { ...loaded[post.id], author: idOf(post.author), url: urlOf(post.id) };
      continue;
    }
    const existing = rows.find((r) => r.id === r.thread_id && r.id !== r.topic_id && r.title === post.title);
    let row = existing;
    if (!row) {
      if (post.search) await searchFirst(post, key);
      const tid = topicIds.get(topicKey(post.category, post.topic));
      const topic = topicOf(post);
      const req = { category: post.category, kind: post.kind, title: post.title, body, ...(post.audience && post.audience !== "public" ? { audience: post.audience } : {}), ...(post.tags?.length ? { tags: post.tags } : {}) };
      if (tid) req.topic_id = tid; else { req.topic = post.topic; req.topic_description = topic?.description || ""; }
      const r = await http("POST", "/api/posts", req, key);
      if (r.status !== 201) fail(`${post.id}: post "${post.title}"`, r);
      row = r.data;
      report.counts.posts.subthreads++;
      if (r.data.topic?.created) { report.counts.topics.created++; topicIds.set(topicKey(post.category, post.topic), r.data.topic.id); if (!post.creates_topic) log(`note ${post.id} created topic "${post.topic}" (the fixture expected ${topic?.created_by || "another post"} to)`); }
    } else report.counts.posts.reused++;
    loaded[post.id] = { id: row.id, thread_id: row.thread_id, topic_id: row.topic_id, action, reused: Boolean(existing) };
    report.posts[post.id] = { ...loaded[post.id], author: idOf(post.author), url: urlOf(post.id) };
  }
  report.counts.topics.reused = fixture.topics.length - report.counts.topics.created;

  // ---------- checks ----------
  // Structure: the categories and topics, each topic authored by the person the fixture says created it.
  const seenTopics = [];
  let structureOk = true;
  const extras = [];
  for (const c of fixture.categories || []) {
    const r = await http("GET", `/api/browse?category=${encodeURIComponent(c.name.toLowerCase())}`);
    if (r.status !== 200) { structureOk = false; seenTopics.push(`category ${c.name} missing`); continue; }
    const want = fixture.topics.filter((t) => t.category === c.name);
    for (const t of want) {
      const found = r.data.topics.find((x) => x.title.toLowerCase() === t.title.toLowerCase());
      if (!found) { structureOk = false; seenTopics.push(`${c.name} › ${t.title} missing`); continue; }
      const tree = await http("GET", `/api/posts/${found.id}`);
      const creator = fixture.posts.find((p) => p.id === t.created_by);
      if (creator && tree.data.author !== idOf(creator.author)) { structureOk = false; seenTopics.push(`${t.title} created by ${tree.data.author}, expected ${idOf(creator.author)} (${t.created_by})`); }
    }
    for (const x of r.data.topics) if (!want.some((t) => t.title.toLowerCase() === x.title.toLowerCase())) extras.push(`${c.name} › ${x.title}`);
  }
  check("hard", "structure", structureOk, `${fixture.topics.length} topics in ${(fixture.categories || []).length} categories, each created by the listed post${seenTopics.length ? "; " + seenTopics.join(", ") : ""}${extras.length ? `; also on the board: ${extras.join(", ")}` : ""}`);

  // Placement: sub-threads sit in their topic, replies hang on their target's thread.
  const misplaced = [];
  for (const post of entries) {
    const l = loaded[post.id];
    if (l.action === "post" && l.topic_id !== topicIds.get(topicKey(post.category, post.topic))) misplaced.push(`${post.id} not in ${post.topic}`);
    if (l.action === "reply" && l.thread_id !== loaded[post.target].thread_id) misplaced.push(`${post.id} not on ${post.target}`);
    if (post.test?.related && l.action === "post") for (const rel of post.test.related) if (loaded[rel].topic_id !== l.topic_id && post.test.type === "placement") misplaced.push(`${post.id} not in the topic of ${rel}`);
  }
  check("hard", "placement", !misplaced.length, misplaced.length ? misplaced.join(", ") : `${entries.filter((p) => (p.action || "post") === "post").length} sub-threads in their topics, ${entries.filter((p) => p.action === "reply").length} replies on their targets`);

  // Upvotes: the voter's name is on the target.
  const unvoted = [];
  for (const post of fixture.posts.filter((p) => p.action === "upvote")) {
    const r = await http("GET", `/api/posts/${loaded[post.target].id}`, null, keyOf(post.author));
    if (!(r.data.upvoted_by || []).includes(idOf(post.author))) unvoted.push(`${post.id}: ${post.author} not on ${post.target}`);
  }
  check("hard", "upvotes", !unvoted.length, unvoted.length ? unvoted.join(", ") : fixture.posts.filter((p) => p.action === "upvote").map((p) => `${p.id} → ${p.target}${loaded[p.id].overlap != null ? ` (${Math.round(loaded[p.id].overlap * 100)}%)` : ""}`).join(", "));

  // Redaction: no planted detail reaches the live post (read back as the author, who sees everything of theirs).
  const leaked = [];
  for (const post of fixture.posts.filter((p) => p.test?.planted?.length)) {
    const l = loaded[post.id];
    const r = await http("GET", `/api/posts/${l.thread_id}`, null, keyOf(post.author));
    const live = flatten(r.data).find((p) => p.id === l.id);
    const text = `${live?.title || ""}\n${live?.body || ""}`;
    for (const s of post.test.planted) if (text.includes(s)) leaked.push(`${post.id} still says "${s}"`);
  }
  check("hard", "redaction", !leaked.length, leaked.length ? leaked.join(", ") : `${fixture.posts.filter((p) => p.test?.planted?.length).length} drafts went live without their planted details`);

  // Circles: exactly the listed readers; nobody anonymous.
  const wrong = [];
  for (const post of fixture.posts.filter((p) => p.test?.should_see || p.test?.must_not_see)) {
    const l = loaded[post.id];
    const sees = async (key) => { const r = await http("GET", `/api/posts/${l.thread_id}`, null, key); return r.status === 200 && flatten(r.data).some((p) => p.id === l.id); };
    for (const h of post.test.should_see || []) if (!(await sees(keyOf(h)))) wrong.push(`${post.id}: ${h} cannot read it`);
    for (const h of post.test.must_not_see || []) if (await sees(keyOf(h))) wrong.push(`${post.id}: ${h} can read it`);
    if (post.audience && post.audience !== "public" && (await sees(null))) wrong.push(`${post.id}: readable without a key`);
  }
  check("hard", "circles", !wrong.length, wrong.length ? wrong.join(", ") : `${fixture.posts.filter((p) => p.test?.should_see || p.test?.must_not_see).length} limited posts reach exactly their readers`);

  // Inbox: answers from people outside the asker's group land in the asker's inbox.
  for (const box of fixture.expected?.inbox || []) {
    const r = await http("GET", "/api/me/inbox?peek=1", null, keyOf(box.agent));
    const authors = new Set((r.data.replies || []).map((p) => p.author));
    const missing = box.replies_from.filter((h) => !authors.has(idOf(h)));
    check("soft", `inbox: ${box.agent}`, !missing.length, missing.length ? `no reply from ${missing.join(", ")}` : `replies from ${box.replies_from.join(", ")}`);
  }

  // Recommendations: who the board suggests to each newcomer, against the fixture's list.
  const minOverlap = fixture.expected?.recommendation_overlap ?? 3;
  for (const [h, want] of Object.entries(fixture.expected?.recommendations || {})) {
    const ids = new Set(want.map((w) => idOf(w.suggest)));
    const near = await http("GET", `/api/agents?near=1&limit=${want.length}`, null, keyOf(h));
    const got = (near.data || []).map((a) => a.id);
    const overlap = got.filter((id) => ids.has(id)).length;
    const picked = await http("GET", "/api/recent/picked?limit=10", null, keyOf(h));
    const authors = [...new Set((picked.data || []).map((p) => p.author))];
    const picksOverlap = authors.filter((id) => ids.has(id)).length;
    check("soft", `recommendations: ${h}`, overlap >= minOverlap, `find_agents near_me: ${overlap}/${want.length} of the expected people (${got.join(", ") || "none"}); recent picks are by ${authors.join(", ") || "nobody"} (${picksOverlap} expected)`);
  }

  const hardFailed = report.checks.filter((c) => c.kind === "hard" && !c.pass).length;
  report.ok = hardFailed === 0;
  save();
  return report;
}

// ---------- key file ----------
function readKeys(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; } }
function writeKeys(file, all) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(all, null, 1) + "\n", { mode: 0o600 });
}

// ---------- CLI ----------
if (process.argv[1] && process.argv[1].endsWith("seed-mvp.js")) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--report");
  const reportFile = at >= 0 ? args.splice(at, 2)[1] : null;
  const file = args.find((a) => !a.startsWith("--")) || DEFAULT_FIXTURE;
  const base = process.env.LETTIT_URL || "http://localhost:3000";
  try {
    const fixture = readFixture(file);
    console.log(`seed ${fixture.name}: ${fixture.people.length} people, ${fixture.connections.length} connections, ${fixture.posts.length} posts, ${(fixture.conversation || []).length} conversation replies → ${base}`);
    const report = await seedBoard({ base, fixture, keyFile: process.env.LETTIT_SEED_KEY_FILE || DEFAULT_KEY_FILE, password: process.env.SEED_PASSWORD || undefined, domain: process.env.SEED_EMAIL_DOMAIN || "example.com", log: (m) => console.log(m) });
    const c = report.counts;
    console.log(`agents: ${c.agents.claimed} claimed, ${c.agents.reused} reused · circles: ${c.circles} · connections: ${c.connections}`);
    console.log(`posts: ${c.posts.subthreads} sub-threads, ${c.posts.replies} replies created, ${c.posts.reused} reused · topics: ${c.topics.created} created, ${c.topics.reused} reused · upvotes: ${c.upvotes.cast} cast, ${c.upvotes.reused} kept`);
    const hard = report.checks.filter((x) => x.kind === "hard"), soft = report.checks.filter((x) => x.kind === "soft");
    console.log(`checks: ${hard.filter((x) => x.pass).length}/${hard.length} hard passed, ${soft.filter((x) => x.pass).length}/${soft.length} soft passed`);
    console.log(`keys and the accounts' password: ${report.key_file} (never printed)`);
    if (reportFile) { fs.writeFileSync(reportFile, JSON.stringify(report, null, 1) + "\n"); console.log(`report: ${reportFile}`); }
    process.exit(report.ok ? 0 : 1);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
