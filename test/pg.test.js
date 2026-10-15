// The hand-written Postgres client: extended protocol with parameters, typed decoding, transactions, pool.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { connect, pool, decode, parseArray } from "../src/pg.js";
import { freshSchema } from "./_db.js";

let schema, c;
before(async () => { schema = await freshSchema(); c = await connect(schema.url); });
after(async () => { c.end(); await schema.drop(); });

test("parameters round-trip every type the store uses", async () => {
  const [r] = await c.query(
    "select $1::int as i, $2::bigint as big, $3::bool as b, $4::text as s, $5::text as empty, $6::text as nul, $7::text[] as arr, $8::jsonb as j, $9::timestamptz as t, $10::numeric as n",
    [7, 9007199254740991n, false, "héllo 'quoted' \\ \"x\" 日本", "", null, ["a", "b c", null, 'q"x', "back\\slash"], { k: [1, "two", null] }, new Date("2026-01-02T03:04:05.678Z"), 1.5],
  );
  assert.deepEqual(r, { i: 7, big: 9007199254740991, b: false, s: "héllo 'quoted' \\ \"x\" 日本", empty: "", nul: null, arr: ["a", "b c", null, 'q"x', "back\\slash"], j: { k: [1, "two", null] }, t: "2026-01-02T03:04:05.678Z", n: 1.5 });
});

test("timestamps come back as UTC ISO strings whatever the server zone", async () => {
  const [r] = await c.query("select '2026-06-01 12:00:00+02'::timestamptz as t, '2026-06-01 12:00:00'::timestamp as plain");
  assert.equal(r.t, "2026-06-01T10:00:00.000Z");
  assert.equal(r.plain, "2026-06-01T12:00:00.000Z");
});

test("rows carry the affected count; a failed statement rejects and the connection stays usable", async () => {
  await c.query("create table kv (k text primary key, v int)");
  const ins = await c.query("insert into kv values ($1, $2), ($3, $4)", ["a", 1, "b", 2]);
  assert.equal(ins.count, 2);
  assert.deepEqual(Object.keys(ins), []);
  await assert.rejects(c.query("insert into kv values ($1, $2)", ["a", 3]), (e) => e.code === "23505" && e.constraint === "kv_pkey");
  await assert.rejects(c.query("select $1::int", ["x"]), /invalid input syntax/);
  assert.deepEqual(await c.query("select k, v from kv order by k"), [{ k: "a", v: 1 }, { k: "b", v: 2 }]);
  const up = await c.query("update kv set v = v + 1 where v > $1", [1]);
  assert.equal(up.count, 1);
});

test("simple queries still run several statements and return the last result", async () => {
  const rows = await c.query("create table two (n int); insert into two values (1), (2); select count(*)::int as n from two");
  assert.deepEqual(rows, [{ n: 2 }]);
});

test("tx commits on return and rolls back on throw", async () => {
  await c.query("create table t (n int)");
  const out = await c.tx(async (q) => { await q.query("insert into t values (1)"); return "done"; });
  assert.equal(out, "done");
  await assert.rejects(c.tx(async (q) => { await q.query("insert into t values (2)"); throw new Error("boom"); }), /boom/);
  await assert.rejects(c.tx(async (q) => { await q.query("insert into t values (3)"); await q.query("select 1/0"); }), /division by zero/);
  assert.deepEqual(await c.query("select n from t order by n"), [{ n: 1 }]);
});

test("a pool serves concurrent queries on at most size connections and reuses them", async () => {
  const p = pool(schema.url, 2);
  const ids = await Promise.all(Array.from({ length: 6 }, () => p.query("select pg_backend_pid() as pid, pg_sleep(0.05)").then(([r]) => r.pid)));
  assert.equal(new Set(ids).size, 2);
  assert.equal(p.size, 2);
  await p.tx(async (q) => { await q.query("create table pooled (n int)"); await q.query("insert into pooled values (1)"); });
  assert.deepEqual(await p.query("select n from pooled"), [{ n: 1 }]);
  p.end();
});

test("the search_path in the URL scopes unqualified names to the test schema", async () => {
  const [r] = await c.query("select current_schema() as s");
  assert.equal(r.s, schema.name);
});

test("decode and parseArray handle the edge cases", () => {
  assert.equal(decode(16, "t"), true);
  assert.equal(decode(23, "42"), 42);
  assert.equal(decode(25, "42"), "42");
  assert.deepEqual(parseArray("{}"), []);
  assert.deepEqual(parseArray('{a,"b,c",NULL,"NULL","\\"q\\""}'), ["a", "b,c", null, "NULL", '"q"']);
  assert.deepEqual(decode(1007, "{1,2,NULL}"), [1, 2, null]);
});
