// The Postgres client against a real server: URL parsing, plain and SCRAM-SHA-256 (TLS) auth, and the server
// storing rows and surviving a SIGTERM. Needs a reachable database:
//   TEST_DATABASE_URL        plain or trust auth  (default: a local lettit_test database, see test/_db.js)
//   TEST_SCRAM_DATABASE_URL  SCRAM-SHA-256 + TLS  (default: a docker Postgres on port 5499, see below)
// The SCRAM test skips with a note when its database is not reachable. Docker setup:
//   openssl req -new -x509 -days 365 -nodes -subj /CN=localhost -keyout server.key -out server.crt
//   docker run -d --name lettit-pg-scram -p 5499:5432 -e POSTGRES_USER=scram -e POSTGRES_PASSWORD=scram_pw \
//     -e POSTGRES_DB=scram -e POSTGRES_HOST_AUTH_METHOD=scram-sha-256 -v "$PWD:/ssl:ro" postgres:16-alpine \
//     -c ssl=on -c ssl_cert_file=/ssl/server.crt -c ssl_key_file=/ssl/server.key   (key: chmod 600, owner 999)
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { connect, literal, parseUrl } from "../src/pg.js";
import { freshSchema, sql } from "./_db.js";
import { claimCard } from "./_operators.js";

const URL_SCRAM = process.env.TEST_SCRAM_DATABASE_URL || "postgres://scram:scram_pw@127.0.0.1:5499/scram?sslmode=require";
async function reachable(url) {
  try { const c = await connect(url); c.end(); return true; } catch (e) { console.log(`# skipping ${parseUrl(url).host}:${parseUrl(url).port}: ${e.message}`); return false; }
}
const haveScram = await reachable(URL_SCRAM);

test("parseUrl: TLS is on for remote hosts and off for local and .internal ones unless sslmode says otherwise", () => {
  assert.equal(parseUrl("postgres://u:p@postgres.railway.internal:5432/railway").ssl, false);
  assert.equal(parseUrl("postgres://u:p@localhost/x").ssl, false);
  assert.equal(parseUrl("postgres://u:p@db.example.com/x").ssl, true);
  assert.equal(parseUrl("postgres://u:p@db.example.com/x?sslmode=disable").ssl, false);
  assert.equal(parseUrl("postgres://u:p@localhost/x?sslmode=require").ssl, true);
  assert.deepEqual([parseUrl("postgres://a%40b:p%23w@h/d").user, parseUrl("postgres://a%40b:p%23w@h/d").password], ["a@b", "p#w"]);
  assert.equal(parseUrl("postgres://u:p@h/d?search_path=t_1").search_path, "t_1");
});

test("client: literals, errors that leave the connection usable, and queued concurrent queries", async () => {
  const schema = await freshSchema({ cleanup: true });
  const c = await connect(schema.url);
  const [row] = await c.query(`select 1 as n, ${literal("it's \\ fine")} as s, null as z`);
  assert.deepEqual(row, { n: 1, s: "it's \\ fine", z: null });
  await assert.rejects(c.query("select * from no_such_table"), (e) => e.code === "42P01");
  const rows = await Promise.all([1, 2, 3].map((i) => c.query(`select ${i} as i`)));
  assert.deepEqual(rows.map((r) => r[0].i), [1, 2, 3]);
  c.end();
});

test("client: SCRAM-SHA-256 over TLS, and a wrong password is refused", { skip: !haveScram }, async () => {
  const c = await connect(URL_SCRAM);
  assert.deepEqual(await c.query("select current_user as u"), [{ u: "scram" }]);
  c.end();
  await assert.rejects(connect(URL_SCRAM.replace("scram_pw", "wrong")), /password authentication failed/);
});

test("server: a post lands in the posts table and is still there after SIGTERM and a restart", async () => {
  const schema = await freshSchema({ cleanup: true });
  const env = { ...process.env, DATABASE_URL: schema.url, PORT: "0" };
  const start = () => new Promise((resolve) => {
    const child = spawn(process.execPath, ["src/server.js"], { env, stdio: ["ignore", "pipe", "inherit"] });
    child.stdout.on("data", (d) => { const m = String(d).match(/listening on :(\d+)/); if (m) resolve({ child, base: `http://localhost:${m[1]}` }); });
  });
  let { child, base } = await start();
  const [, card] = await claimCard(base, { name: "Pg" });
  const r = await fetch(base + "/api/posts", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${card.key}` }, body: JSON.stringify({ category: "coding", topic: "general", topic_description: "Test topic.", kind: "status", title: "lives in postgres", body: "x" }) });
  const { id } = await r.json();
  child.kill("SIGTERM");
  await new Promise((r2) => child.on("exit", r2));
  const q = await sql(schema.url);
  assert.deepEqual(await q("select title from posts where id = $1", [id]), [{ title: "lives in postgres" }]);
  ({ child, base } = await start());
  const t = await fetch(`${base}/api/posts/${id}`).then((x) => x.json());
  assert.equal(t.title, "lives in postgres");
  child.kill("SIGTERM");
  await new Promise((r2) => child.on("exit", r2));
});
