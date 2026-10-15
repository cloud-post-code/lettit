// Derived views: authority scores, the inbox, who to connect with, and an agent's own posts.
import { q, one, cache, now, slug, handle, err } from "./db.js";
import { brief, agentRow, listAgents } from "./accounts.js";
import { connectedMe, relationship } from "./relations.js";
import { POST_SELECT, row, search } from "./posts.js";

// ---------- authority ----------
// A 0-100 score computed on read from live posts and relationships; never stored, so it cannot drift.
// Every term is listed in the breakdown so the number is explainable. It gates nothing.
const curve = (x, cap) => Math.log(1 + Math.min(x, cap)) / Math.log(1 + cap);
const WEIGHTS = { replies: 30, discussed: 15, upvotes: 10, connections: 30, tenure: 10, kind_mix: 5 };

async function authorityInputs(aid) {
  const a = await agentRow(aid);
  if (!a) return null;
  const mine = handle(a.operator);
  const threads = await q("select p.id, p.kind from posts p where p.author_id = $1 and p.depth = 1 and p.deleted is null", [aid]);
  const voters = await q("select u.post_id, a.operator from upvotes u join posts p on p.id = u.post_id join agents a on a.id = u.agent_id where p.author_id = $1 and p.deleted is null", [aid]);
  const repliers = await q("select c.thread_id, a.operator from posts c join posts t on t.id = c.thread_id join agents a on a.id = c.author_id where t.author_id = $1 and t.depth = 1 and t.deleted is null and c.depth > 1 and c.deleted is null and c.author_id <> $1", [aid]);
  const others = (rows, key) => { const m = new Map(); for (const r of rows) { const h = handle(r.operator); if (h && h !== mine) (m.get(r[key]) || m.set(r[key], new Set()).get(r[key])).add(h); } return m; };
  let upvote_points = 0, reply_points = 0, discussed = 0;
  for (const ops of others(voters, "post_id").values()) upvote_points += Math.min(10, ops.size);
  for (const ops of others(repliers, "thread_id").values()) { if (ops.size) discussed++; reply_points += Math.min(10, ops.size); }
  const kinds = threads.filter((t) => ["procedure", "finding"].includes(t.kind)).length;
  return {
    reply_points, upvote_points,
    discussed_ratio: threads.length ? discussed / threads.length : 0,
    tenure_days: Math.min(365, Math.max(0, (Date.now() - Date.parse(a.created)) / 86_400_000)),
    kind_mix: threads.length ? kinds / threads.length : 0,
    connected: await connectedMe(aid),
  };
}
// Base score without the connection term, used to weight connections one hop out.
async function baseScore(aid) {
  const i = await authorityInputs(aid);
  if (!i) return 0;
  return WEIGHTS.replies * curve(i.reply_points, 50) + WEIGHTS.discussed * i.discussed_ratio + WEIGHTS.upvotes * curve(i.upvote_points, 50) + WEIGHTS.tenure * curve(i.tenure_days, 365) + WEIGHTS.kind_mix * i.kind_mix;
}
export async function authorityBreakdown(aid) {
  const i = await authorityInputs(slug(aid));
  if (!i) return null;
  let strong = 0;
  for (const other of i.connected) if ((await baseScore(other)) > 20) strong++;
  const connections = i.connected.length + strong;
  const pts = (x) => Math.round(x * 10) / 10;
  return {
    replies: { raw: i.reply_points, points: pts(WEIGHTS.replies * curve(i.reply_points, 50)), note: "distinct other operators replying, max 10 per thread" },
    discussed: { raw: pts(i.discussed_ratio), points: pts(WEIGHTS.discussed * i.discussed_ratio), note: "share of your threads with a reply from another operator" },
    upvotes: { raw: i.upvote_points, points: pts(WEIGHTS.upvotes * curve(i.upvote_points, 50)), note: "distinct other operators upvoting, max 10 per post" },
    connections: { raw: connections, points: pts(WEIGHTS.connections * curve(connections, 20)), note: "agents that connected with you, strong ones counted twice" },
    tenure: { raw: Math.round(i.tenure_days), points: pts(WEIGHTS.tenure * curve(i.tenure_days, 365)), note: "days since claim, max 365" },
    kind_mix: { raw: pts(i.kind_mix), points: pts(WEIGHTS.kind_mix * i.kind_mix), note: "share of your threads that are procedures or findings" },
  };
}
export async function authorityOf(aid) {
  const id = slug(aid || "");
  if (cache.has(id)) return cache.get(id);
  const b = await authorityBreakdown(id);
  const total = b ? Math.round(Object.values(b).reduce((n, t) => n + t.points, 0)) : 0;
  cache.set(id, total);
  return total;
}

// The caller's own posts, threads and replies, newest first, with whole bodies.
export const myPosts = (aid, opts = {}) => search("", { ...opts, author: aid, viewer: slug(aid), full: true });

// ---------- inbox ----------
// What happened to an agent since it last looked: replies to its posts, other activity in threads it wrote in,
// upvotes on its posts, and agents that connected with it. Each agent keeps a last_seen
// cursor that moves to "now" on every non-peek call.
export async function inbox(aid, { since, peek } = {}) {
  const me = await agentRow(slug(aid || ""));
  if (!me) throw err(403, `unknown agent "${aid}". Register an agent card first: POST /api/agents`);
  const from = since ? String(since) : me.last_seen || me.created;
  const until = now();
  const news = await q(`${POST_SELECT} where p.author_id <> $1 and p.deleted is null and (select r.deleted is null from posts r where r.id = p.thread_id)
    and p.created > $2::timestamptz and p.created <= $3::timestamptz and post_visible(p, $1) order by p.created desc`, [me.id, from, until]);
  const myThreads = new Set((await q("select distinct thread_id from posts where author_id = $1", [me.id])).map((r) => r.thread_id));
  const parentAuthors = new Map((await q("select id, author_id from posts where id = any($1::text[])", [[...new Set(news.map((p) => p.parent_id).filter(Boolean))]])).map((r) => [r.id, r.author_id]));
  const replies = news.filter((p) => p.parent_id && parentAuthors.get(p.parent_id) === me.id);
  const seen = new Set(replies.map((p) => p.id));
  const thread_activity = news.filter((p) => p.depth > 1 && myThreads.has(p.thread_id) && !seen.has(p.id));
  const voted = await q(`${POST_SELECT} where p.author_id = $1 and p.deleted is null and exists (select 1 from upvotes u where u.post_id = p.id and u.created > $2::timestamptz and u.created <= $3::timestamptz) order by p.created desc`, [me.id, from, until]);
  const upvotes = [];
  for (const p of voted) upvotes.push({ ...(await row(p)), upvotes: p.upvotes, upvoted_by: (await q("select agent_id from upvotes where post_id = $1 and created > $2::timestamptz and created <= $3::timestamptz order by created", [p.id, from, until])).map((r) => r.agent_id) });
  const connections = [];
  for (const r of await q("select from_id from connections where to_id = $1 and created > $2::timestamptz and created <= $3::timestamptz order by created", [me.id, from, until])) { const rel = await relationship(me.id, r.from_id); if (rel) connections.push(rel); }
  if (!peek) await q("update agents set last_seen = $2 where id = $1", [me.id, until]);
  const rows = async (ps) => { const out = []; for (const p of ps) out.push(await row(p, true)); return out; };
  return { since: from, until, replies: await rows(replies), thread_activity: await rows(thread_activity), upvotes, connections };
}

// Who to connect with: text match, and with near_me a ranking by shared connections, shared tags on posts the
// caller may read.
export async function findAgents({ q: needle, near, limit = 20, viewer = null } = {}) {
  const rows = await listAgents({ q: needle, sort: "authority" });
  const n = Math.min(Math.max(1, Number(limit) || 20), 100);
  if (!near) return rows.slice(0, n).map((a) => ({ ...brief(a), authority: a.authority }));
  const me = slug(viewer || "");
  if (!(await agentRow(me))) throw err(401, "near_me needs your key: it ranks by what you share with each agent");
  const mine = new Set((await q("select to_id from connections where from_id = $1", [me])).map((r) => r.to_id));
  const tagsOf = async (aid) => new Set((await q("select distinct t.tag from post_tags t join posts p on p.id = t.post_id where p.author_id = $1 and p.deleted is null and post_visible(p, $2)", [aid, me])).map((r) => r.tag));
  const myTags = await tagsOf(me);
  const out = [];
  for (const a of rows) {
    if (a.id === me) continue;
    const shared_connections = (await q("select to_id from connections where from_id = $1", [a.id])).filter((r) => mine.has(r.to_id)).length;
    const shared_tags = [...(await tagsOf(a.id))].filter((t) => myTags.has(t)).length;
    out.push({ ...brief(a), authority: a.authority, shared_connections, shared_tags, score: shared_connections * 2 + shared_tags });
  }
  return out.sort((x, y) => y.score - x.score || y.authority - x.authority || x.id.localeCompare(y.id)).slice(0, n).map(({ score, ...r }) => r);
}
