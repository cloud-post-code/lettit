// The Postgres store and the wire-protocol client behind it. Needs a reachable database:
//   TEST_DATABASE_URL        plain or trust auth  (default: a local lettit_test database)
//   TEST_SCRAM_DATABASE_URL  SCRAM-SHA-256 + TLS  (default: the docker container from docs/TESTING.md)
// A database that is not reachable skips its tests and says so.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { connect, literal, parseUrl } from "../src/pg.js";
import { claimCard } from "./_operators.js";

const URL_PLAIN = process.env.TEST_DATABASE_URL || "postgres://lettit_test:lettit_test_pw@127.0.0.1:5432/lettit_test";
const URL_SCRAM = process.env.TEST_SCRAM_DATABASE_URL || "postgres://scram:scram_pw@127.0.0.1:5499/scram?sslmode=require";

async function reachable(url) {
  try { const c = await connect(url); c.end(); return true; } catch (e) { console.log(`# skipping ${parseUrl(url).host}:${parseUrl(url).port}: ${e.message}`); return false; }
}
const havePlain = await reachable(URL_PLAIN);
const haveScram = await reachable(URL_SCRAM);

test("parseUrl: TLS is on for remote hosts and off for local and .internal ones unless sslmode says otherwise", () => {
  assert.equal(parseUrl("postgres://u:p@postgres.railway.internal:5432/railway").ssl, false);
  assert.equal(parseUrl("postgres://u:p@localhost/db").ssl, false);
  assert.equal(parseUrl("postgres://u:p@host.proxy.rlwy.net:1234/railway").ssl, true);
  assert.equal(parseUrl("postgres://u:p@host.proxy.rlwy.net:1234/railway?sslmode=disable").ssl, false);
  assert.equal(parseUrl("postgres://u:p@localhost/db?sslmode=require").ssl, true);
  const c = parseUrl("postgresql://us%40er:p%40ss@h:1/d");
  assert.deepEqual([c.user, c.password, c.port, c.database], ["us@er", "p@ss", 1, "d"]);
});

test("client: queries, literals, errors that leave the connection usable, and queued concurrent queries", { skip: !havePlain }, async () => {
  const c = await connect(URL_PLAIN);
  const [row] = await c.query(`select 1 as n, ${literal("it's \\ fine")} as s, null as z`);
  assert.deepEqual(row, { n: "1", s: "it's \\ fine", z: null });
  await assert.rejects(c.query("select * from no_such_table"), (e) => e.code === "42P01");
  assert.deepEqual(await c.query("select 2 as n"), [{ n: "2" }]);
  const rows = await Promise.all([1, 2, 3].map((i) => c.query(`select ${i} as i`)));
  assert.deepEqual(rows.map((r) => r[0].i), ["1", "2", "3"]);
  c.end();
});

test("client: SCRAM-SHA-256 over TLS, and a wrong password is refused", { skip: !haveScram }, async () => {
  const c = await connect(URL_SCRAM);
  assert.deepEqual(await c.query("select current_user as u"), [{ u: "scram" }]);
  c.end();
  await assert.rejects(connect(URL_SCRAM.replace("scram_pw", "wrong")), /password/);
});

// Boots src/server.js as a child on a Postgres store; resolves with { base, stop } once it listens.
function boot(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["src/server.js"], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "inherit"] });
    child.stdout.on("data", (d) => {
      const m = String(d).match(/listening on :(\d+) \((\w+) store\)/);
      if (m) resolve({ base: `http://localhost:${m[1]}`, backend: m[2], stop: () => new Promise((r) => { child.on("exit", r); child.kill("SIGTERM"); }) });
    });
    child.on("exit", (code) => reject(new Error(`server exited early (${code})`)));
  });
}

test("store: writes land in the board row, survive a SIGTERM and restart, and no file is written", { skip: !havePlain }, async () => {
  const admin = await connect(URL_PLAIN);
  await admin.query("drop table if exists board");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lettit-pg-"));
  const env = { DATABASE_URL: URL_PLAIN, DATA_DIR: dir, PORT: "0" };

  const one = await boot(env);
  assert.equal(one.backend, "postgres");
  const [, card] = await claimCard(one.base, { name: "pg-bot" });
  const r = await fetch(one.base + "/api/posts", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${card.key}` }, body: JSON.stringify({ feed: "feedback", title: "lives in postgres", body: "row 1", author: card.id }) });
  assert.equal(r.status, 201);
  const { id } = await r.json();
  await one.stop();

  const [row] = await admin.query("select doc->'posts'->" + literal(id) + "->>'title' as title, count(*) over () as rows from board");
  assert.equal(row.title, "lives in postgres");
  assert.equal(row.rows, "1");
  assert.equal(fs.existsSync(path.join(dir, "board.json")), false, "the file store is not used");

  const two = await boot(env);
  const again = await fetch(two.base + "/api/posts/" + id).then((x) => x.json());
  assert.equal(again.title, "lives in postgres");
  const agents = await fetch(two.base + "/api/agents").then((x) => x.json());
  assert.ok(agents.some((a) => a.id === card.id), "the claimed agent is back after restart");
  await two.stop();
  admin.end();
});
