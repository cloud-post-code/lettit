// Test helper: a private schema per test file on the local database, like the temp DATA_DIR used to be.
// TEST_DATABASE_URL names the database; each call creates schema t_<random>, returns a URL whose
// search_path points at it, and a drop() that removes it. No reachable database fails fast and says how.
import crypto from "node:crypto";
import { after } from "node:test";
import { connect, parseUrl } from "../src/pg.js";

export const BASE_URL = process.env.TEST_DATABASE_URL || "postgres://lettit_test:lettit_test_pw@127.0.0.1:5432/lettit_test";
const HOW = "start a local Postgres and run: createdb lettit_test && psql -d postgres -c \"create role lettit_test login password 'lettit_test_pw'\" && psql -d lettit_test -c \"grant all on schema public to lettit_test\" (or set TEST_DATABASE_URL)";

// With `board`, the schema starts with a legacy board row holding that document, so the server's migrations
// import it on open: the way a test used to write board.json before starting the server.
// cleanup: true registers a root-level after() hook that drops the schema (for a test file's own schema).
export async function freshSchema({ board, cleanup = false } = {}) {
  const name = "t_" + crypto.randomBytes(6).toString("hex");
  let c;
  try { c = await connect(BASE_URL); } catch (e) { throw new Error(`no test database at ${parseUrl(BASE_URL).host}:${parseUrl(BASE_URL).port} (${e.message}); ${HOW}`); }
  await c.query(`create schema ${name}`);
  if (board) {
    await c.query(`create table ${name}.board (id int primary key check (id = 1), doc jsonb not null, updated timestamptz not null default now())`);
    await c.query(`insert into ${name}.board (id, doc) values (1, $1::jsonb)`, [JSON.stringify(board).replace(/\\u0000/g, "")]);
  }
  c.end();
  const u = new URL(BASE_URL);
  u.searchParams.set("search_path", name);
  let dropped = false;
  const drop = async () => { if (dropped) return; dropped = true; const d = await connect(BASE_URL); await d.query(`drop schema ${name} cascade`); d.end(); };
  if (cleanup) after(drop);
  return { name, url: u.toString(), drop };
}

// A query function on the schema behind a URL, for assertions against the tables.
export async function sql(url) {
  const c = await connect(url);
  after(() => c.end());
  return (text, params) => c.query(text, params);
}
