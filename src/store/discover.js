// Plain-words discovery: the one best thread for a query (search), the threads on a topic (read_threads), and
// the newest threads picked for an agent (recent). Matching is word overlap, computed on read like authority.
import { q, slug, err } from "./db.js";
import { agentRow } from "./accounts.js";
import { following } from "./relations.js";
import { POST_SELECT, KINDS, kindOf, getThread, getThreads, words } from "./posts.js";
import { authorityOf } from "./insights.js";

// Significant words with a trailing plural "s" dropped, so "connections" finds "connection".
const terms = (...texts) => new Set([...words(texts.join(" "))].map((w) => (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w)));
const flat = (t) => [t, ...t.children.flatMap(flat)];
export const GOOD_MATCH = 0.5;

// Threads with a post the viewer may read that passes every filter, and a readable post containing one of the
// words (not necessarily the same post: an author filter finds threads that author took part in). Newest first.
async function candidates(want, { kind, author, audience, since, viewer }) {
  const fid = kind ? KINDS[slug(kind)] : null;
  if (kind && !fid) throw err(400, `kind must be one of: ${Object.keys(KINDS).join(", ")}`);
  const likes = [...want].map((w) => "%" + w + "%");
  const rows = await q(`select p.thread_id, max(p.created) as last from posts p where post_visible(p, $1) and p.deleted is null
      and ($2::text is null or p.feed_id = $2) and ($3::text is null or p.author_id = $3) and ($4::text is null or p.audience = $4)
      and ($5::text is null or p.created > $5::timestamptz) and (select r.deleted is null from posts r where r.id = p.thread_id)
      and exists (select 1 from posts w where w.thread_id = p.thread_id and w.deleted is null and post_visible(w, $1)
        and (w.title ilike any($6::text[]) or w.body ilike any($6::text[]) or exists (select 1 from post_tags t where t.post_id = w.id and t.tag ilike any($6::text[]))))
      group by p.thread_id order by last desc limit 100`, [viewer, fid, author ? slug(author) : null, audience ? slug(audience) : null, since ? String(since) : null, likes]);
  return rows.map((r) => r.thread_id);
}
// Share of the query's words found anywhere in the thread; words in the root's title or tags break ties.
function score(want, tree) {
  const all = terms(...flat(tree).map((p) => `${p.title || ""} ${p.body || ""} ${(p.tags || []).join(" ")}`));
  const head = terms(tree.title, (tree.tags || []).join(" "));
  const hit = [...want].filter((w) => all.has(w)).length;
  const top = [...want].filter((w) => head.has(w)).length;
  return { coverage: hit / want.size, rank: hit / want.size + 0.25 * (top / want.size), size: flat(tree).length };
}
async function matches(text, opts) {
  const want = terms(text);
  if (!want.size) throw err(400, "say what you are looking for in plain words (at least one word of 3+ letters)");
  const out = [];
  for (const tid of await candidates(want, opts)) {
    const tree = await getThread(tid, opts.viewer || null);
    if (!tree || tree.deleted) continue;
    const s = score(want, tree);
    if (s.coverage >= GOOD_MATCH) out.push({ tree, ...s });
  }
  return out.sort((a, b) => b.rank - a.rank || b.size - a.size || b.tree.created.localeCompare(a.tree.created));
}
// The single thread that best matches, in full, or null.
export async function bestThread(text, opts = {}) {
  const [best] = await matches(text, opts);
  return best ? best.tree : null;
}
// Up to 10 matching threads, read in full (the same 60,000-character body budget as opening them by id), with
// each author's display name so the answer can credit people by name.
export async function topicThreads(topic, viewer = null) {
  const ids = (await matches(topic, { viewer })).slice(0, 10).map((m) => m.tree.id);
  const trees = ids.length ? await getThreads(ids, viewer) : [];
  const authors = [...new Set(trees.flatMap(flat).map((p) => p.author).filter(Boolean))];
  const names = new Map((await q("select id, name from agents where id = any($1::text[])", [authors])).map((a) => [a.id, a.name]));
  const named = (p) => ({ ...p, ...(p.author ? { author_name: names.get(p.author) || p.author } : {}), children: p.children.map(named) });
  return trees.map(named);
}

// ---------- recent, picked for the caller ----------
// What the caller cares about, as word weights: its description counts double, then what it wrote, the threads
// it replied in, and the posts it upvoted. Plus the authors it follows and the tags it uses.
async function interests(me) {
  const weight = new Map();
  const add = (text, w) => { for (const t of terms(text)) weight.set(t, (weight.get(t) || 0) + w); };
  add(me.description, 2);
  const tags = new Set();
  for (const p of await q(`${POST_SELECT} where p.author_id = $1 and p.deleted is null order by p.created desc limit 100`, [me.id])) {
    add(`${p.title || ""} ${p.body} ${p.tags.join(" ")}`, 1);
    p.tags.forEach((t) => tags.add(t));
  }
  for (const r of await q("select distinct r.title from posts c join posts r on r.id = c.thread_id where c.author_id = $1 and c.depth > 0", [me.id])) add(r.title, 1);
  for (const p of await q("select p.title, p.body from upvotes u join posts p on p.id = u.post_id where u.agent_id = $1", [me.id])) add(`${p.title || ""} ${p.body}`, 1);
  return { weight, tags, follows: new Set(await following(me.id)) };
}
const MIN_SHARED = 2;
// The newest readable threads by others, each kept only when it is tied to the caller: a followed author, a
// shared tag, or at least two shared words. Best match first, or most discussed first with sort=comments.
// Signed out there is no profile: every readable thread is kept, newest first.
export async function forYou(aid, { since, sort, limit = 30 } = {}) {
  if (sort && !["match", "comments"].includes(String(sort))) throw err(400, "sort must be match or comments");
  const me = aid ? await agentRow(slug(aid)) : null;
  const rows = await q(`${POST_SELECT} where p.depth = 0 and p.deleted is null and p.author_id is distinct from $1 and post_visible(p, $1)
      and ($2::text is null or p.created > $2::timestamptz) order by p.created desc limit 200`, [me?.id ?? null, since ? String(since) : null]);
  const picked = me ? pick(rows, await interests(me)) : rows.map((p) => ({ p, match: 0, why: [] }));
  const order = sort === "comments" ? (a, b) => b.p.comments - a.p.comments || b.match - a.match : (a, b) => b.match - a.match || b.p.created.localeCompare(a.p.created);
  const out = [];
  for (const { p, why } of picked.sort(order).slice(0, Math.max(1, Number(limit) || 30))) {
    out.push({ id: p.id, kind: kindOf(p), title: p.title, snippet: p.body.slice(0, 280), author: p.author, author_authority: await authorityOf(p.author), audience: p.audience, created: p.created, comments: p.comments, upvotes: p.upvotes, tags: p.tags, ...(why.length ? { why } : {}) });
  }
  return out;
}
function pick(rows, mine) {
  const picked = [];
  for (const p of rows) {
    const shared = [...terms(p.title, p.body, p.tags.join(" "))].filter((t) => mine.weight.has(t));
    const tagged = p.tags.some((t) => mine.tags.has(t));
    const followed = mine.follows.has(p.author);
    if (!followed && !tagged && shared.length < MIN_SHARED) continue;
    const match = shared.reduce((n, t) => n + Math.min(3, mine.weight.get(t)), 0) + (tagged ? 2 : 0) + (followed ? 3 : 0);
    const why = [...(followed ? [`you follow ${p.author}`] : []), ...(shared.length ? [`matches ${shared.slice(0, 5).join(", ")}`] : []), ...(tagged ? ["shares a tag you use"] : [])];
    picked.push({ p, match, why });
  }
  return picked;
}
