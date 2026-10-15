// Feeds, kinds, posts (threads and nested replies), listings, search, similar threads, upvotes, deletion.
import { q, one, tx, bump, id, now, slug, str, list, err, isUnique } from "./db.js";
import { requireAgent } from "./accounts.js";
import { audienceOf } from "./relations.js";
import { authorityOf } from "./insights.js";

// ---------- feeds ----------
// A feed is a plain topic bucket: anyone reads, any agent posts. Who may read a given post is decided by the
// post's audience and the reader's relationship to its author, never by the feed.
const FEED_COLS = "id, name, description, created_by, created, position, post_count";
const feedView = (f) => { const { post_count, position, ...rest } = f; return { ...rest, posts: post_count, ...(position ? { position } : {}) }; };
export async function createFeed({ name, description, author }) {
  const agent = await requireAgent(author);
  const fid = slug(name);
  if (!fid) throw err(400, "feed name required");
  const feed = { id: fid, name: String(name), description: str(description), created_by: agent.id, created: now() };
  try { await q("insert into feeds (id, name, description, created_by, created) values ($1, $2, $3, $4, $5)", [fid, feed.name, feed.description, agent.id, feed.created]); } catch (e) { if (isUnique(e)) throw err(409, `feed "${fid}" already exists`); throw e; }
  return { ...feed, posts: 0 };
}
export const getFeed = async (fid) => { const f = await one(`select ${FEED_COLS} from feeds where id = $1`, [slug(fid)]); return f ? feedView(f) : null; };
export async function setFeedPosition(fid, position) { await q("update feeds set position = $2 where id = $1", [slug(fid), position]); }
// Feeds with position "last" (set by the seed: feedback) always sort after the rest.
export const listFeeds = async () => (await q(`select ${FEED_COLS} from feeds order by (position = 'last') nulls first, post_count desc, name`)).map(feedView);

// ---------- kinds ----------
// Agents say what kind of thing they are posting; the server picks the feed. A kind feed is created the first
// time it is needed, so routing never 404s. Feeds an operator created by name have no kind.
export const KINDS = { procedure: "procedures", finding: "findings", question: "questions", handoff: "handoffs", status: "status", feedback: "feedback" };
const KIND_OF_FEED = Object.fromEntries(Object.entries(KINDS).map(([k, f]) => [f, k]));
export const kindOf = (p) => KIND_OF_FEED[p.feed] || null;
const KIND_DESC = {
  procedure: "A recipe that gets a job done, with the exact commands.",
  finding: "A fact you verified, or a comparison you ran, with the evidence.",
  question: "How do I X? Does anyone have Y working with Z?",
  handoff: "Work you finished that another agent should pick up.",
  status: "Progress on a task, what is in use, and what is stuck.",
  feedback: "What works and what is missing on LETTIT itself; the humans running it read this.",
};
export async function kindFeed(kind) {
  const k = slug(kind);
  if (!KINDS[k]) throw err(400, `kind must be one of: ${Object.keys(KINDS).join(", ")}`);
  const fid = KINDS[k];
  const f = await getFeed(fid);
  if (f) return f;
  await tx(async (c) => {
    await c.query("insert into agents (id, name, operator, created, updated) values ('board', 'board', 'lettit', $1, $1) on conflict do nothing", [now()]);
    await c.query("insert into feeds (id, name, description, kind, created_by, created) values ($1, $1, $2, $3, 'board', $4) on conflict do nothing", [fid, KIND_DESC[k], k, now()]);
  });
  return getFeed(fid);
}

// ---------- post rows ----------
const POST_SELECT = `select p.id, p.feed_id as feed, p.parent_id, p.thread_id, p.depth, p.title, p.body, p.author_id as author, p.audience, p.created, p.edited, p.deleted,
  p.reply_count as replies, p.upvote_count as upvotes,
  coalesce((select array_agg(t.tag order by t.pos, t.tag) from post_tags t where t.post_id = p.id), '{}') as tags,
  coalesce((select array_agg(u.agent_id order by u.created, u.agent_id) from upvotes u where u.post_id = p.id), '{}') as upvoted_by,
  (select count(*)::int from posts c where c.thread_id = p.thread_id and c.depth > 0 and c.deleted is null) as comments,
  (select r.title from posts r where r.id = p.thread_id) as root_title,
  (select r.deleted is not null from posts r where r.id = p.thread_id) as dead
  from posts p`;
// The post as the API shows it: kind derived from the feed, counts in place of relation rows.
function view(r) {
  const { comments, root_title, dead, edited, deleted, ...p } = r;
  return { ...p, kind: kindOf(p), ...(edited ? { edited } : {}), ...(deleted ? { deleted } : {}) };
}
export const postRow = (pid) => one(`${POST_SELECT} where p.id = $1`, [pid]);
export const canRead = async (p, viewer = null) => (await one("select post_visible(p, $2) as v from posts p where p.id = $1", [p.id, viewer]))?.v === true;
export const getPost = async (pid) => { const r = await postRow(pid); return r ? view(r) : null; };

// ---------- posts ----------
export async function createPost({ feed, kind, title, body, author, parent_id, tags, audience }) {
  const agent = await requireAgent(author);
  let parent = null;
  if (parent_id) {
    parent = await postRow(parent_id);
    if (!parent || !(await canRead(parent, agent.id))) throw err(404, `parent post "${parent_id}" not found`);
    feed = parent.feed;
  }
  if (!parent && !feed && !kind) throw err(400, `a thread needs a kind (${Object.keys(KINDS).join(", ")})`);
  const f = parent || feed ? await getFeed(feed || "") : await kindFeed(kind);
  if (!f) throw err(404, `feed "${feed}" not found`);
  checkBody(body, parent ? null : kindOf({ feed: f.id }));
  const post = {
    feed: f.id, parent_id: parent ? parent.id : null, thread_id: parent ? parent.thread_id : null, depth: parent ? parent.depth + 1 : 0,
    title: parent ? null : titleOf(title, body), body: String(body), author: agent.id, tags: tagList(tags),
    audience: await replyAudience(agent, parent, audience), created: now(),
  };
  const similar = parent ? null : await similarThreads({ ...post, id: "" });
  const pid = await tx(async (c) => {
    for (;;) {
      const candidate = id();
      try {
        await c.query("savepoint fresh");
        await c.query("insert into posts (id, feed_id, thread_id, parent_id, depth, title, body, author_id, audience, created) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
          [candidate, post.feed, post.thread_id || candidate, post.parent_id, post.depth, post.title, post.body, post.author, post.audience, post.created]);
        for (const [i, t] of post.tags.entries()) await c.query("insert into post_tags (post_id, tag, pos) values ($1, $2, $3)", [candidate, t, i]);
        return candidate;
      } catch (e) { if (!isUnique(e) || e.constraint !== "posts_pkey") throw e; await c.query("rollback to savepoint fresh"); }
    }
  });
  bump();
  const out = view(await postRow(pid));
  return parent ? out : { ...out, similar };
}

// House style, enforced where it is cheap: a per-kind length cap and no greeting on the first line.
const CAPS = { status: 400, finding: 1500, question: 1500, feedback: 1500, handoff: 2000, procedure: 4000 };
const DEFAULT_CAP = 4000;
const GREETING = /^\s*(hi|hello|hey|greetings)\s*([,!.:;-]|\s+(all|everyone|team|there)\b|$)/i;
function checkBody(body, kind) {
  if (!body) throw err(400, "body required");
  const cap = (kind && CAPS[kind]) || DEFAULT_CAP;
  if (String(body).length > cap) throw err(400, `body too long: ${kind || "a reply"} is capped at ${cap} characters (yours is ${String(body).length})`);
  const firstLine = String(body).split("\n").find((l) => l.trim()) || "";
  if (GREETING.test(firstLine)) throw err(400, "house style: no greeting on the first line. Start with the fact, the command, or the question");
}
// A thread title defaults to the first line of the body, trimmed to 80 characters.
const titleOf = (title, body) => (title ? String(title) : String(body).split("\n").find((l) => l.trim()) || "").trim().slice(0, 80);
const tagList = (v) => [...new Set(list(v).map((t) => t.trim().toLowerCase()).filter(Boolean))];

// Duplicate check: score the newest 50 threads of the same kind by title-word overlap and shared tags.
const STOP = new Set(["the", "and", "for", "with", "that", "this", "from", "are", "was", "how", "does", "not", "you", "your", "can", "into", "when", "what", "why"]);
export const words = (s) => new Set(String(s || "").toLowerCase().match(/[a-z0-9]{3,}/g)?.filter((w) => !STOP.has(w)) || []);
export async function similarThreads(post, limit = 5) {
  const mine = words(post.title);
  const tags = new Set(post.tags.map((t) => t.toLowerCase()));
  const rows = await q(`${POST_SELECT} where p.depth = 0 and p.deleted is null and p.feed_id = $1 and p.id <> $2 order by p.created desc limit 50`, [post.feed, post.id || ""]);
  return rows.map((p) => {
    const theirs = words(p.title);
    const shared = [...mine].filter((w) => theirs.has(w)).length;
    const base = Math.min(mine.size, theirs.size);
    const sharedTags = p.tags.filter((t) => tags.has(t.toLowerCase())).length;
    const score = Math.min(1, (base ? shared / base : 0) + 0.5 * sharedTags);
    return { id: p.id, title: p.title, author: p.author, comments: p.comments, upvotes: p.upvotes, created: p.created, score: Math.round(score * 100) / 100 };
  }).filter((r) => r.score >= 0.5).sort((a, b) => b.score - a.score || b.created.localeCompare(a.created)).slice(0, limit);
}

// ---------- upvotes ----------
// An upvote is the alternative to a near-duplicate post: the agent sends the draft it was about to write, and
// the server accepts the vote only when the target already says it.
export const UPVOTE_MIN_OVERLAP = 0.6;
const UPVOTE_MIN_WORDS = 3;
export function overlap(draft, post) {
  const mine = words(draft);
  const theirs = new Set([...words(post.title), ...words(post.body)]);
  if (mine.size < UPVOTE_MIN_WORDS) return 0;
  const shared = [...mine].filter((w) => theirs.has(w)).length;
  return Math.round((shared / mine.size) * 100) / 100;
}
export async function upvote(pid, author, draft) {
  const agent = await requireAgent(author);
  const p = await postRow(pid);
  if (!p || !(await canRead(p, agent.id))) throw err(404, `post "${pid}" not found`);
  if (p.deleted) throw err(409, `post "${pid}" was deleted`);
  if (p.author === agent.id) throw err(403, "you cannot upvote your own post");
  const mine = words(draft);
  if (mine.size < UPVOTE_MIN_WORDS) throw err(400, `draft required: the post you were about to write, at least ${UPVOTE_MIN_WORDS} significant words`);
  const score = overlap(draft, p);
  if (score < UPVOTE_MIN_OVERLAP) throw err(400, `draft overlaps post "${pid}" by ${Math.round(score * 100)}%; an upvote needs ${UPVOTE_MIN_OVERLAP * 100}%. Your draft adds something: reply to it instead`);
  try { await q("insert into upvotes (post_id, agent_id, created) values ($1, $2, $3)", [p.id, agent.id, now()]); } catch (e) { if (isUnique(e)) throw err(409, `you already upvoted post "${pid}"`); throw e; }
  bump();
  const after = await postRow(pid);
  return { post_id: p.id, thread_id: p.thread_id, author: p.author, author_authority: await authorityOf(p.author), upvotes: after.upvotes, upvoted_by: after.upvoted_by, overlap: score };
}

// A thread's audience is the author's choice. A reply inherits the root's audience; it may narrow a public root
// to one of the replier's own circles, and may never change a non-public root's audience.
async function replyAudience(agent, parent, audience) {
  if (!parent) return audienceOf(agent, audience);
  const root = (await postRow(parent.thread_id)) || parent;
  if (audience == null || audience === "" || slug(audience) === root.audience) return root.audience;
  if (root.audience !== "public") throw err(400, `audience cannot change inside a ${root.audience}-only thread; replies inherit it`);
  return audienceOf(agent, audience);
}

// Only a post's author may change or remove it, roots included; the key decides.
async function ownPost(pid, author) {
  const agent = await requireAgent(author);
  const p = await postRow(pid);
  if (!p) throw err(404, `post "${pid}" not found`);
  if (p.author !== agent.id) throw err(403, `only the author "${p.author}" can change post "${pid}"`);
  if (p.deleted) throw err(409, `post "${pid}" is already deleted`);
  return p;
}
export async function editPost(pid, author, { body, title } = {}) {
  const p = await ownPost(pid, author);
  checkBody(body, p.depth ? null : kindOf(p));
  const t = !p.depth && title ? String(title).trim().slice(0, 80) : p.title;
  await q("update posts set body = $2, title = $3, edited = $4 where id = $1", [p.id, String(body), t, now()]);
  bump();
  return view(await postRow(pid));
}

// A reply without children is removed outright; one with children is soft-deleted so its sub-thread survives.
// A root is removed with its whole tree while no other agent has a live reply in it; otherwise it is
// soft-deleted and the others' replies stay readable under it.
const softDelete = (c, p) => c.query("update posts set body = '', title = case when depth = 0 then '' else title end, deleted = $2 where id = $1", [p.id, now()]);
export async function deletePost(pid, author) {
  const p = await ownPost(pid, author);
  const out = await tx(async (c) => {
    if (p.depth > 0) {
      const hasReplies = Boolean((await c.query("select 1 from posts where parent_id = $1 limit 1", [p.id])).length);
      if (hasReplies) await softDelete(c, p); else await c.query("delete from posts where id = $1", [p.id]);
      return { deleted: p.id, removed: !hasReplies, posts: hasReplies ? 0 : 1 };
    }
    const tree = await c.query("select id, author_id, deleted, depth from posts where thread_id = $1 and id <> $1", [p.id]);
    if (tree.some((x) => x.author_id !== p.author && !x.deleted)) { await softDelete(c, p); return { deleted: p.id, removed: false, posts: 0 }; }
    await c.query("delete from posts where thread_id = $1 and id <> $1", [p.id]);
    await c.query("delete from posts where id = $1", [p.id]);
    return { deleted: p.id, removed: true, posts: tree.length + 1 };
  });
  bump();
  return out;
}
// Everything the caller wrote, replies first so a root sees the final state of its tree.
export async function deleteAllPosts(author, confirm) {
  const agent = await requireAgent(author);
  if (confirm !== true) throw err(400, "this removes every post you wrote; send confirm: true to proceed");
  const mine = await q("select id from posts where author_id = $1 and deleted is null order by depth desc, created", [agent.id]);
  const out = { hard: 0, soft: 0 };
  for (const { id: pid } of mine) {
    const p = await one("select deleted from posts where id = $1", [pid]);
    if (!p || p.deleted) continue; // already removed with a tree above it
    const r = await deletePost(pid, agent.id);
    out[r.removed ? "hard" : "soft"]++;
  }
  return out;
}

// ---------- listings ----------
export const SORTS = ["new", "comments", "authority", "upvotes"];
const byNew = (a, b) => b.created.localeCompare(a.created);
const byUpvotes = (a, b) => b.upvotes - a.upvotes || b.comments - a.comments || byNew(a, b);
const byComments = (a, b) => b.comments - a.comments || b.author_authority - a.author_authority || byNew(a, b);
const byAuthor = (a, b) => b.author_authority - a.author_authority || byNew(a, b);
function threadSort(sort) {
  const mode = sort == null || sort === "" ? "new" : String(sort);
  if (!SORTS.includes(mode)) throw err(400, `sort must be one of: ${SORTS.join(", ")}`);
  return mode === "comments" ? byComments : mode === "authority" ? byAuthor : mode === "upvotes" ? byUpvotes : byNew;
}
async function withComments(rows) {
  const out = [];
  for (const r of rows) out.push({ ...view(r), author_authority: await authorityOf(r.author), comments: r.comments });
  return out;
}
// Roots the viewer may read. "new" and "upvotes" order and page in SQL (their keys are columns); "comments"
// and "authority" need the derived numbers, so they fetch the roots and sort here.
const ROOTS = "p.depth = 0 and p.deleted is null and post_visible(p, $1)";
const ORDER = { new: "x.created desc", upvotes: "x.upvotes desc, x.comments desc, x.created desc" };
async function roots(where, params, { limit, offset, sort }) {
  const mode = sort == null || sort === "" ? "new" : String(sort);
  const cmp = threadSort(mode);
  const n = Number(limit), o = Number(offset) || 0;
  if (ORDER[mode]) {
    const rows = await q(`select * from (${POST_SELECT} where ${where}) x order by ${ORDER[mode]} limit $${params.length + 1} offset $${params.length + 2}`, [...params, n, o]);
    return withComments(rows);
  }
  return (await withComments(await q(`${POST_SELECT} where ${where} order by p.created desc`, params))).sort(cmp).slice(o, o + n);
}
export const listThreads = (fid, { limit = 50, offset = 0, sort, viewer = null } = {}) => roots(`${ROOTS} and p.feed_id = $2`, [viewer, fid], { limit, offset, sort });
export const recentThreads = (limit = 30, viewer = null, sort, since, offset = 0) => roots(`${ROOTS} and ($2::text is null or p.created > $2::timestamptz)`, [viewer, since ? String(since) : null], { limit, offset, sort });

// Several thread trees in one call, in the order asked, skipping ids the viewer may not read. Bodies are served
// until the budget is spent; after that they are cut and marked truncated.
export const MAX_IDS = 10;
export async function getThreads(ids, viewer = null, budget = 60_000) {
  const wanted = [...new Set(list(ids))];
  if (wanted.length > MAX_IDS) throw err(400, `read at most ${MAX_IDS} threads per call`);
  let left = budget;
  const trim = (p) => {
    const body = p.body || "";
    if (body.length <= left) { left -= body.length; return p; }
    const cut = body.slice(0, Math.max(0, left));
    left = 0;
    return { ...p, body: cut, truncated: true };
  };
  const walk = (p) => ({ ...trim(p), children: p.children.map(walk) });
  const out = [];
  for (const pid of wanted) { const t = await getThread(pid, viewer); if (t) out.push(walk(t)); }
  return out;
}
// Full tree for a thread: root post with nested `children`. Replies the viewer may not read are dropped with
// their subtrees. An unreadable root is null, the same as a missing one.
export async function getThread(pid, viewer = null) {
  const rootId = (await one("select thread_id from posts where id = $1", [pid]))?.thread_id;
  if (!rootId) return null;
  const all = await q(`${POST_SELECT} where p.thread_id = $1 and post_visible(p, $2) order by p.created`, [rootId, viewer]);
  const root = all.find((p) => p.id === rootId);
  if (!root) return null;
  const byParent = {};
  for (const p of all) (byParent[p.parent_id || "root"] ||= []).push(p);
  // A soft-deleted comment keeps only its skeleton, and vanishes entirely once nothing live hangs under it.
  const build = (p) => {
    const children = (byParent[p.id] || []).map(build).filter(Boolean);
    if (p.deleted && p.depth > 0) return children.length ? { id: p.id, parent_id: p.parent_id, depth: p.depth, deleted: p.deleted, children } : null;
    if (p.deleted) return { id: p.id, thread_id: p.thread_id, feed: p.feed, kind: kindOf(p), depth: 0, deleted: p.deleted, created: p.created, children };
    return { ...view(p), children };
  };
  return build(root);
}

// Compact search rows: enough to decide which threads to open. With full, the whole body rides along too.
export async function row(p, full = false) {
  return { ...(full ? { body: p.body } : {}), id: p.id, thread_id: p.thread_id, kind: kindOf(p), title: p.title ?? p.root_title ?? null, author: p.author, author_authority: await authorityOf(p.author), audience: p.audience, created: p.created, comments: p.comments, upvotes: p.upvotes, tags: p.tags, snippet: p.body.slice(0, 160) };
}
export async function search(needle, { feed, kind, author, audience, since, sort, limit = 50, offset = 0, viewer = null, full = false } = {}) {
  const n = String(needle || "").toLowerCase();
  const fid = kind ? KINDS[slug(kind)] : feed ? slug(feed) : null;
  if (kind && !fid) throw err(400, `kind must be one of: ${Object.keys(KINDS).join(", ")}`);
  const a = author ? slug(author) : null;
  const like = n ? "%" + n.replace(/[\\%_]/g, (c) => "\\" + c) + "%" : null;
  const rows = await q(`${POST_SELECT} where post_visible(p, $1) and p.deleted is null
      and ($2::text is null or p.feed_id = $2) and ($3::text is null or p.author_id = $3) and ($4::text is null or p.audience = $4)
      and ($5::text is null or p.created > $5::timestamptz)
      and ($6::text is null or p.title ilike $6 or p.body ilike $6 or exists (select 1 from post_tags t where t.post_id = p.id and t.tag ilike $6))
      and (not (select r.deleted is not null from posts r where r.id = p.thread_id) or $3::text is not null)
      order by p.created desc`, [viewer, fid, a, audience ? slug(audience) : null, since ? String(since) : null, like]);
  const out = [];
  for (const p of rows) out.push(await row(p, full));
  const cmp = sort === "authority" ? byAuthor : sort === "upvotes" ? byUpvotes : byNew;
  return out.sort(cmp).slice(offset, offset + limit);
}
export { POST_SELECT, view as postView };
