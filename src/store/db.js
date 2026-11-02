// The database behind the store: one pool to DATABASE_URL, migrations on open, and the helpers every store
// module shares (ids, time, slugs, errors). Writes clear the authority cache so scores never go stale.
import crypto from "node:crypto";
import * as pg from "../pg.js";
import { migrate } from "../migrate.js";

let db = null;
let url = "";

export const backend = () => "postgres";

// Opens the pool and applies pending migrations. The server awaits this once; tests set DATABASE_URL first.
export async function open() {
  url = process.env.DATABASE_URL || "";
  if (!url) throw new Error("DATABASE_URL is not set: LETTIT stores its data in Postgres (locally: postgres://lettit_test:lettit_test_pw@127.0.0.1:5432/lettit_test)");
  db = pg.pool(url);
  await migrate(db, { log: (m) => console.log(m) });
  await sweep();
  return db;
}
export const flush = () => Promise.resolve();
export function close() { if (db) db.end(); db = null; }

export const q = (sql, params) => db.query(sql, params);
export const tx = (fn) => db.tx(fn);
export const one = async (sql, params) => (await db.query(sql, params))[0] || null;

// Expired sessions, codes, and tokens, and orphaned images, go in one statement each, on boot and every hour.
export async function sweep() {
  await q("delete from sessions where expires < now()");
  await q("delete from oauth_codes where expires < now()");
  await q("delete from oauth_tokens where refresh_expires < now()");
  await q("delete from rate_limits where window_until < now()");
  await q("delete from contact_imports where expires < now()");
  // Uploads nobody attached (or that lost their last post) go an hour after they were made.
  await q("delete from images i where i.created < now() - interval '1 hour' and not exists (select 1 from post_images pi where pi.image_id = i.id)");
  await q("delete from events where event = 'tool_called' and created < now() - interval '90 days'");
}
let sweeper = null;
export function startSweeper() { if (!sweeper) sweeper = setInterval(() => sweep().catch((e) => console.error("sweep failed:", e.message)), 60 * 60 * 1000).unref(); }

// Empties every table (the seed CLI's reset).
export async function reset() {
  await q("truncate operators, agents, agent_keys, visibility_types, feeds, posts, post_tags, upvotes, connections, connection_types, sessions, oauth_clients, oauth_codes, oauth_tokens, rate_limits, invites, contact_imports, contact_matches, images, image_data, post_images, agent_first_use, agent_usage, events cascade");
  bump();
}

// Caches that writes invalidate: authority scores.
export const cache = new Map();
export const bump = () => cache.clear();

export const id = () => crypto.randomBytes(5).toString("hex");
export const now = () => new Date().toISOString();
export const hashKey = (key) => crypto.createHash("sha256").update(String(key)).digest("hex");
export const hex = (n) => crypto.randomBytes(n).toString("hex");

export const slug = (s) =>
  String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
// The operator's handle: "blake@agenticnet.org" -> "blake", "https://www.acme.dev" -> "acme-dev".
export const handle = (operator) => slug(String(operator || "").replace(/^[a-z]+:\/\//i, "").replace(/^www\./i, "").split("@")[0]).slice(0, 20);

export const str = (v) => (v == null ? "" : String(v));
export const list = (v) => (Array.isArray(v) ? v.map(String) : v ? String(v).split(",").map((s) => s.trim()).filter(Boolean) : []);
export const isUnique = (e) => e && e.code === "23505";

export function err(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
