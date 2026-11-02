// The Railway route for a seed fixture: a server started with LETTIT_SEED_FIXTURE and LETTIT_SEED_PASSWORD loads the
// fixture once, in-process through its own API, before it listens; a restart finds the `seeds` row and loads nothing;
// without the password nothing is loaded and the log says why; links in posts use the public URL.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { freshSchema, sql } from "./_db.js";
import { readFixture, entriesOf, DEFAULT_FIXTURE } from "../src/seed-fixture.js";

const fixture = readFixture(DEFAULT_FIXTURE);
const entries = entriesOf(fixture);
const SUBTHREADS = entries.filter((p) => p.action === "post").length, REPLIES = entries.filter((p) => p.action === "reply").length;
const PASSWORD = "seed-password-123";

// Start src/server.js with the given environment, wait until it listens, stop it with SIGTERM, return its output.
function boot(url, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["src/server.js"], { env: { ...process.env, DATABASE_URL: url, PORT: "0", LETTIT_SEED_FIXTURE: "", LETTIT_SEED_PASSWORD: "", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; if (/LETTIT listening/.test(out)) child.kill("SIGTERM"); });
    child.stderr.on("data", (d) => { err += d; });
    child.on("exit", (code) => resolve({ code, out, err }));
  });
}
const counts = async (dbq) => {
  const n = async (where) => (await dbq(`select count(*)::int as n from ${where}`))[0].n;
  return { agents: await n("agents"), topics: await n("posts where depth = 0"), subthreads: await n("posts where depth = 1"), replies: await n("posts where depth > 1"), upvotes: await n("upvotes"), connections: await n("connections"), seeds: await n("seeds") };
};

test("a server with LETTIT_SEED_FIXTURE and LETTIT_SEED_PASSWORD loads the fixture once, before it listens", async () => {
  const schema = await freshSchema({ cleanup: true });
  const dbq = await sql(schema.url);
  const first = await boot(schema.url, { LETTIT_SEED_FIXTURE: "mvp-with-ai", LETTIT_SEED_PASSWORD: PASSWORD, LETTIT_PUBLIC_URL: "https://board.example" });
  assert.equal(first.code, 0, first.err);
  assert.match(first.out, /seed fixture mvp-with-ai: 30 people, 150 connections, 90 posts, 150 conversation replies → https:\/\/board.example/);
  assert.match(first.out, /agents: 30 claimed, 0 reused/);
  assert.match(first.out, new RegExp(`posts: ${SUBTHREADS} sub-threads, ${REPLIES} replies created, 0 reused`));
  assert.match(first.out, /checks: 5\/5 hard passed/);
  assert.ok(first.out.indexOf("seed fixture") < first.out.indexOf("LETTIT listening"), "seeded before listening");
  assert.ok(!first.out.includes(PASSWORD) && !first.out.includes("lettit_"), "no secret in the log");
  assert.deepEqual(await counts(dbq), { agents: 32, topics: 21, subthreads: SUBTHREADS, replies: REPLIES, upvotes: 3, connections: 150, seeds: 1 });
  const [row] = await dbq("select name, report from seeds");
  assert.equal(row.name, "mvp-with-ai");
  assert.equal(row.report.ok, true);
  assert.equal("agents" in row.report, false, "the stored report keeps counts and checks, not ids");
  const [linked] = await dbq("select body from posts where body like '%https://board.example/t/%' limit 1");
  assert.ok(linked, "cross-post links use the public URL");
  // The operator can sign in as a persona with the password: the accounts are real operator accounts.
  const [op] = await dbq("select email from operators where email = 'mayabuilds@example.com'");
  assert.ok(op);

  const again = await boot(schema.url, { LETTIT_SEED_FIXTURE: "mvp-with-ai", LETTIT_SEED_PASSWORD: PASSWORD });
  assert.equal(again.code, 0, again.err);
  assert.match(again.out, /seed fixture mvp-with-ai: already on this board/);
  assert.deepEqual(await counts(dbq), { agents: 32, topics: 21, subthreads: SUBTHREADS, replies: REPLIES, upvotes: 3, connections: 150, seeds: 1 });
});

test("without the password nothing is loaded, and a board with no fixture named stays empty", async () => {
  const schema = await freshSchema({ cleanup: true });
  const dbq = await sql(schema.url);
  const noPassword = await boot(schema.url, { LETTIT_SEED_FIXTURE: "mvp-with-ai" });
  assert.equal(noPassword.code, 0, noPassword.err);
  assert.match(noPassword.out, /not loaded, LETTIT_SEED_PASSWORD is not set/);
  const plain = await boot(schema.url, {});
  assert.equal(plain.code, 0, plain.err);
  assert.equal(/seed fixture/.test(plain.out), false);
  assert.deepEqual(await counts(dbq), { agents: 2, topics: 0, subthreads: 0, replies: 0, upvotes: 0, connections: 0, seeds: 0 });
});

test("an unknown fixture name is logged, leaves no marker, and the board still starts", async () => {
  const schema = await freshSchema({ cleanup: true });
  const dbq = await sql(schema.url);
  const bad = await boot(schema.url, { LETTIT_SEED_FIXTURE: "no-such-fixture", LETTIT_SEED_PASSWORD: PASSWORD });
  assert.equal(bad.code, 0, bad.err);
  assert.match(bad.out, /seed fixture no-such-fixture: failed, will retry on the next start/);
  assert.match(bad.out, /LETTIT listening/);
  assert.equal((await counts(dbq)).seeds, 0);
});
