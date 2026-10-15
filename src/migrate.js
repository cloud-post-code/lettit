// Schema migrations: numbered files in src/migrations (NNNN_name.sql or NNNN_name.js), applied in order, each
// in its own transaction, under an advisory lock so two instances never migrate at once. Applied versions are
// recorded in schema_migrations. Forward-only. The server runs migrate() on boot; `node src/migrate.js` runs
// it by hand and `--status` lists applied and pending.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as pg from "./pg.js";

const DIR = path.join(path.dirname(new URL(import.meta.url).pathname), "migrations");
const LOCK = 7342001;

export function files(dir = DIR) {
  return fs.readdirSync(dir).map((f) => f.match(/^(\d{4})_(.+)\.(sql|js)$/)).filter(Boolean)
    .map((m) => ({ version: Number(m[1]), name: m[2], file: path.join(dir, m[0]) }))
    .sort((a, b) => a.version - b.version);
}

async function applied(c) {
  await c.query("create table if not exists schema_migrations (version integer primary key, name text not null, applied_at timestamptz not null default now())");
  return new Set((await c.query("select version from schema_migrations")).map((r) => r.version));
}

// db: a pg pool or client. Returns the migrations applied by this call.
export async function migrate(db, { dir = DIR, log = () => {} } = {}) {
  const run = async (c) => {
    await c.query(`select pg_advisory_lock(${LOCK})`);
    try {
      const done = await applied(c);
      const out = [];
      for (const m of files(dir)) {
        if (done.has(m.version)) continue;
        await c.tx(async (t) => {
          if (m.file.endsWith(".sql")) await t.query(fs.readFileSync(m.file, "utf8"));
          else await (await import(pathToFileURL(m.file).href)).default(t);
          await t.query("insert into schema_migrations (version, name) values ($1, $2)", [m.version, m.name]);
        });
        log(`migrated ${String(m.version).padStart(4, "0")}_${m.name}`);
        out.push(m);
      }
      return out;
    } finally {
      await c.query(`select pg_advisory_unlock(${LOCK})`);
    }
  };
  return db.connection ? db.connection(run) : run(db);
}

export async function status(db, { dir = DIR } = {}) {
  const run = async (c) => {
    const done = await applied(c);
    const all = files(dir);
    return { applied: all.filter((m) => done.has(m.version)), pending: all.filter((m) => !done.has(m.version)) };
  };
  return db.connection ? db.connection(run) : run(db);
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("DATABASE_URL is not set"); process.exit(1); }
  const c = await pg.connect(url);
  try {
    if (process.argv.includes("--status")) {
      const s = await status(c);
      for (const m of s.applied) console.log(`applied  ${String(m.version).padStart(4, "0")}_${m.name}`);
      for (const m of s.pending) console.log(`pending  ${String(m.version).padStart(4, "0")}_${m.name}`);
    } else {
      const done = await migrate(c, { log: console.log });
      console.log(done.length ? `${done.length} applied` : "nothing to apply");
    }
  } finally { c.end(); }
}
