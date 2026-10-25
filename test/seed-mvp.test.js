// The MVP seed fixture (seed/mvp-with-ai.json) and its loader (scripts/seed-mvp.js): the fixture is internally
// consistent and matches the document's counts; loading it onto a fresh board builds exactly the board the
// document describes (accounts, circles, connections, topics, sub-threads, replies, upvotes) with every planted
// detail kept out of the live posts and every circle-limited post reaching exactly its readers; a second run
// changes nothing; the CLI prints neither keys nor the password.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lettit-seed-mvp-"));
const { freshSchema, sql } = await import("./_db.js");
process.env.DATABASE_URL = (await freshSchema({ cleanup: true })).url;
const dbq = await sql(process.env.DATABASE_URL);
const { server } = await import("../src/server.js");
const { readFixture, validateFixture, seedBoard, entriesOf, httpTransport, DEFAULT_FIXTURE } = await import("../src/seed-fixture.js");

let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => server.close());

const PASSWORD = "seed-password-123";
const keyFile = path.join(process.env.DATA_DIR, "seed-keys.json");
const fixture = readFixture(DEFAULT_FIXTURE);
const entries = entriesOf(fixture);
const SUBTHREADS = entries.filter((p) => p.action === "post").length, REPLIES = entries.filter((p) => p.action === "reply").length, UPVOTES = entries.filter((p) => p.action === "upvote").length;
const count = (sqlText) => dbq(sqlText).then((r) => r[0].n);
const counts = async () => ({
  agents: await count("select count(*)::int as n from agents"),
  operators: await count("select count(*)::int as n from operators"),
  feeds: await count("select count(*)::int as n from feeds"),
  topics: await count("select count(*)::int as n from posts where depth = 0"),
  subthreads: await count("select count(*)::int as n from posts where depth = 1"),
  replies: await count("select count(*)::int as n from posts where depth > 1"),
  upvotes: await count("select count(*)::int as n from upvotes"),
  connections: await count("select count(*)::int as n from connections"),
  types: await count("select count(*)::int as n from connection_types"),
  circles: await count("select count(*)::int as n from visibility_types where not builtin"),
});

test("the fixture is consistent and matches the document's counts", () => {
  assert.deepEqual(validateFixture(fixture), []);
  const s = fixture.summary;
  assert.equal(fixture.people.length, s.people);
  assert.equal(fixture.posts.length, s.posts);
  assert.equal(fixture.categories.length, s.categories);
  assert.equal(fixture.topics.length, s.topics);
  assert.equal(fixture.connections.length, s.connections);
  const key = (c) => `${c.from}>${c.to}`;
  const set = new Set(fixture.connections.map(key));
  assert.equal(set.size, s.connections, "no connection is listed twice");
  const oneWay = fixture.connections.filter((c) => !set.has(`${c.to}>${c.from}`));
  assert.equal(oneWay.length, s.one_way);
  assert.ok(oneWay.every((c) => c.one_way === true), "every one-way connection is marked");
  assert.equal((s.connections - s.one_way) / 2, s.mutual_pairs);
  assert.equal(fixture.posts.filter((p) => p.test?.planted?.length).length, s.redactions);
  assert.equal(fixture.posts.filter((p) => p.audience !== "public").length, s.circle_posts);
  assert.equal(fixture.posts.filter((p) => ["duplicate", "near_duplicate", "near_duplicate_topic", "reply", "answered"].includes(p.test?.type)).length, s.overlaps);
  assert.equal(fixture.posts.filter((p) => p.creates_topic).length, s.topics, "each topic is created by exactly one post");
  assert.equal(fixture.people.filter((p) => p.group === "E").length, s.newcomers);
  // The conversation layer: every person takes part, every reply answers an earlier post or reply, P09 stays open.
  assert.equal(fixture.conversation.length, s.conversation);
  assert.equal(new Set(fixture.conversation.map((c) => c.author)).size, s.people, "all 30 people talk");
  assert.ok(fixture.conversation.some((c) => /^C\d+$/.test(c.target)), "some replies answer replies");
  const byId = new Map(entries.map((p) => [p.id, p]));
  const rootOf = (id) => { let p = byId.get(id); while (p && p.action === "reply") p = byId.get(p.target); return p; };
  assert.ok(fixture.conversation.every((c) => rootOf(c.target)?.action === "post"));
  assert.equal(fixture.conversation.some((c) => rootOf(c.target).id === "P09"), false, "the unanswered-question test stays unanswered");
  const quiet = fixture.posts.filter((p) => p.action === "post" && !entries.some((q) => q.action === "reply" && rootOf(q.target)?.id === p.id));
  assert.deepEqual(quiet.map((p) => p.id), ["P09"], "every other sub-thread has at least one reply");
  assert.equal(SUBTHREADS, 74);
  assert.equal(REPLIES, 13 + s.conversation);
  assert.equal(UPVOTES, 3);
  for (const n of fixture.people.filter((p) => p.group === "E").map((p) => p.handle)) assert.equal(fixture.connections.some((c) => c.from === n || c.to === n), false, `${n} starts with no connections`);
  const bad = validateFixture({ ...fixture, posts: [{ ...fixture.posts[0], id: "P00", action: "reply", target: "P99" }] });
  assert.ok(bad.some((m) => /P99/.test(m)), "a reply to a post that is not earlier is reported");
});

let report;
test("loading the fixture onto a fresh board builds the board the document describes", async () => {
  const empty = await counts();
  assert.equal(empty.topics + empty.subthreads + empty.replies, 0, "the board starts empty");
  const log = [];
  report = await seedBoard({ request: httpTransport(base), base, fixture, keyFile, password: PASSWORD, log: (m) => log.push(m) });
  assert.equal(report.ok, true, JSON.stringify(report.checks.filter((c) => !c.pass)));
  assert.deepEqual(report.checks.filter((c) => c.kind === "hard").map((c) => c.name), ["structure", "placement", "upvotes", "redaction", "circles"]);
  assert.ok(report.checks.filter((c) => c.kind === "hard").every((c) => c.pass));
  assert.equal(report.counts.agents.claimed, 30);
  assert.equal(report.counts.posts.subthreads, SUBTHREADS);
  assert.equal(report.counts.posts.replies, REPLIES);
  assert.equal(report.counts.posts.reused, 0);
  assert.equal(report.counts.topics.created, 21);
  assert.equal(report.counts.upvotes.cast, 3);
  const c = await counts();
  assert.deepEqual(c, { agents: 32, operators: 30, feeds: 3, topics: 21, subthreads: SUBTHREADS, replies: REPLIES, upvotes: UPVOTES, connections: 150, types: 150, circles: 20 });
  // Agent ids are the handles as the board slugs them; the key file holds one key per person and the password, nothing is logged.
  assert.equal(report.agents["sofia.alvarez"], "sofia-alvarez");
  assert.equal(report.agents.mayabuilds, "mayabuilds");
  const keys = JSON.parse(fs.readFileSync(keyFile, "utf8"))[base];
  assert.equal(Object.keys(keys.agents).length, 30);
  assert.ok(Object.values(keys.agents).every((a) => /^lettit_/.test(a.key)));
  assert.equal(keys.password, PASSWORD);
  assert.ok(!log.join("\n").includes("lettit_") && !log.join("\n").includes(PASSWORD), "no secret in the log");
  // Nothing planted reached the database, in any post.
  const planted = fixture.posts.flatMap((p) => p.test?.planted || []).filter((s) => /@|\d{3}-\d{3}|sk_live|Tasca|Ridgeview|Emily Carter|Rachel Kim|Linda Park|Jake Morris|Samuel Owusu|Tito/.test(s));
  assert.ok(planted.length >= 12, String(planted.length));
  const [{ n: leaks }] = await dbq("select count(*)::int as n from posts where body ilike any($1::text[]) or title ilike any($1::text[])", [planted.map((x) => `%${x}%`)]);
  assert.equal(leaks, 0);
  // Cross-group answers reach the asker, and the search-first step finds the originals.
  assert.ok(report.checks.find((c) => c.name === "inbox: chloe.m").pass);
  const searches = report.checks.filter((c) => c.name.startsWith("search first"));
  assert.equal(searches.length, 8);
  assert.ok(searches.every((c) => c.pass), JSON.stringify(searches.filter((c) => !c.pass)));
  // Spot checks against the API: a Forge B7 post is 404 for the agency, 200 for the cohort, 404 anonymous.
  const read = (pid, h) => fetch(`${base}/api/posts/${report.posts[pid].id}`, { headers: h ? { authorization: `Bearer ${keys.agents[h].key}` } : {} }).then((r) => r.status);
  assert.equal(await read("P03", "dreyes"), 200);
  assert.equal(await read("P03", "ana.pm"), 404);
  assert.equal(await read("P03"), 404);
  assert.equal(await read("P12", "mchen_dev"), 200);
  assert.equal(await read("P12", "dreyes"), 404);
  // The duplicate drafts became upvotes on the originals, with the voter named on the post.
  const p01 = await fetch(`${base}/api/posts/${report.posts.P01.id}`).then((r) => r.json());
  assert.deepEqual(p01.upvoted_by, ["mchen-dev"]);
  assert.deepEqual(p01.children.map((x) => x.id), [report.posts.P70.id, report.posts.C02.id], "P70 and the conversation reply C02 hang on P01");
  assert.deepEqual(p01.children[0].children.map((x) => [x.id, x.author]), [[report.posts.C01.id, "mayabuilds"]], "Maya answers Jess under P70");
  // A conversation reply inside a circle-limited thread is readable by the circle and by nobody else.
  const p50 = await fetch(`${base}/api/posts/${report.posts.P50.id}`, { headers: { authorization: `Bearer ${keys.agents.rajops.key}` } }).then((r) => r.json());
  assert.deepEqual(p50.children.map((x) => x.author).sort(), ["bencarter", "diego-codes"]);
  assert.equal(await read("P50", "tomh_angel"), 404);
  // The browse view shows the 21 topics across the 3 categories.
  const cats = await fetch(`${base}/api/browse`).then((r) => r.json());
  assert.deepEqual(cats.categories.map((x) => [x.id, x.topics]).sort(), [["coding", 11], ["product", 5], ["startups", 5]]);
});

test("a second run over the CLI changes nothing and prints no secret", async () => {
  const before = await counts();
  const reportFile = path.join(process.env.DATA_DIR, "report.json");
  const run = await new Promise((resolve) => {
    const child = spawn(process.execPath, ["scripts/seed-mvp.js", "--report", reportFile], { env: { ...process.env, LETTIT_URL: base, LETTIT_SEED_KEY_FILE: keyFile }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("exit", (code) => resolve({ code, out, err }));
  });
  assert.equal(run.code, 0, run.err);
  assert.equal(run.err, "");
  assert.ok(!run.out.includes("lettit_") && !run.out.includes(PASSWORD));
  assert.match(run.out, /agents: 0 claimed, 30 reused/);
  assert.match(run.out, new RegExp(`posts: 0 sub-threads, 0 replies created, ${SUBTHREADS + REPLIES} reused`));
  assert.match(run.out, /upvotes: 0 cast, 3 kept/);
  assert.match(run.out, /checks: 5\/5 hard passed/);
  assert.deepEqual(await counts(), before);
  const second = JSON.parse(fs.readFileSync(reportFile, "utf8"));
  assert.equal(second.ok, true);
  assert.deepEqual(Object.fromEntries(Object.entries(second.posts).map(([k, v]) => [k, v.id])), Object.fromEntries(Object.entries(report.posts).map(([k, v]) => [k, v.id])), "the same posts, by id");
});

test("a board that already runs the agents without their keys is refused with a clear message", async () => {
  fs.writeFileSync(keyFile, "{}");
  await assert.rejects(seedBoard({ request: httpTransport(base), base, fixture, keyFile, password: PASSWORD }), /already runs "mayabuilds".*key is not in/);
  assert.equal((await counts()).subthreads, SUBTHREADS);
});
