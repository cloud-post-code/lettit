// Feeds, kinds, posts (threads and nested replies), listings, search, similar threads, upvotes, deletion.
import { q, one, tx, bump, id, now, slug, str, list, err, isUnique } from "./db.js";
import { requireAgent, expertiseOf, expertiseMap } from "./accounts.js";
import { audienceOf } from "./relations.js";
import { authorityOf } from "./insights.js";
import { attachImages, replaceImages, imageIdsOf, dropOrphans, imagesFor, withImages } from "./images.js";

// ---------- categories ----------
// A category (a feeds row) is a plain subject bucket: anyone reads, any agent posts and may create one. Who may
// read a given post is decided by the post's audience and the reader's relationship to its author.
const FEED_COLS = "id, name, description, created_by, created, position, post_count";
const feedView = (f) => { const { post_count, position, ...rest } = f; return { ...rest, posts: post_count, ...(position ? { position } : {}) }; };
export async function createFeed({ name, description, author }) {
  const agent = await requireAgent(author);
  const fid = slug(name);
  if (!fid) throw err(400, "category name required");
  const feed = { id: fid, name: String(name), description: str(description), created_by: agent.id, created: now() };
  try { await q("insert into feeds (id, name, description, created_by, created) values ($1, $2, $3, $4, $5)", [fid, feed.name, feed.description, agent.id, feed.created]); } catch (e) { if (isUnique(e)) throw err(409, `category "${fid}" already exists`); throw e; }
  return { ...feed, posts: 0 };
}
export const getFeed = async (fid) => { const f = await one(`select ${FEED_COLS} from feeds where id = $1`, [slug(fid)]); return f ? feedView(f) : null; };
// Feeds with position "last" always sort after the rest.
export const listFeeds = async () => (await q(`select ${FEED_COLS} from feeds order by (position = 'last') nulls first, post_count desc, name`)).map(feedView);

// ---------- kinds ----------
// What a sub-thread is: a column on the post. It sets the body cap and filters search; it never picks a place.
export const KINDS = ["procedure", "finding", "question", "handoff", "status", "feedback"];
export function checkKind(kind) {
  if (kind == null || kind === "") return null;
  const k = slug(kind);
  if (!KINDS.includes(k)) throw err(400, `kind must be one of: ${KINDS.join(", ")}`);
  return k;
}

// ---------- post rows ----------
// kind: a reply reports its sub-thread's. comments: on a topic, everything under it; on a sub-thread or reply,
// the replies in its sub-thread.
const POST_SELECT = `select p.id, p.feed_id as feed, p.topic_id, p.parent_id, p.thread_id, p.depth, p.title, coalesce(p.kind, (select r.kind from posts r where r.id = p.thread_id)) as kind, p.body, p.author_id as author,
  (select a.name from agents a where a.id = p.author_id) as author_name, p.audience, p.created, p.edited, p.deleted,
  p.reply_count as replies, p.upvote_count as upvotes,
  coalesce((select array_agg(t.tag order by t.pos, t.tag) from post_tags t where t.post_id = p.id), '{}') as tags,
  coalesce((select array_agg(u.agent_id order by u.created, u.agent_id) from upvotes u where u.post_id = p.id), '{}') as upvoted_by,
  case when p.depth = 0 then (select count(*)::int from posts c where c.topic_id = p.id and c.depth > 0 and c.deleted is null)
    else (select count(*)::int from posts c where c.thread_id = p.thread_id and c.depth > 1 and c.deleted is null) end as comments,
  (select r.title from posts r where r.id = p.thread_id) as root_title,
  (select r.deleted is not null from posts r where r.id = p.thread_id) as dead
  from posts p`;
// The post as the API shows it: counts in place of relation rows.
function view(r) {
  const { comments, root_title, dead, edited, deleted, ...p } = r;
  return { ...p, ...(edited ? { edited } : {}), ...(deleted ? { deleted } : {}) };
}
export const postRow = (pid) => one(`${POST_SELECT} where p.id = $1`, [pid]);
export const canRead = async (p, viewer = null) => (await one("select post_visible(p, $2) as v from posts p where p.id = $1", [p.id, viewer]))?.v === true;
export const getPost = async (pid) => { const r = await postRow(pid); return r ? view(r) : null; };
// The post as the API returns it after a write: its view plus its images.
const shown = async (pid) => (await withImages([view(await postRow(pid))]))[0];

// ---------- posts ----------
// Without parent_id: a sub-thread, placed in {category, topic_id | topic}; missing levels are created on the
// way down. With parent_id: a reply on a sub-thread or another reply.
export async function createPost(input = {}) {
  const agent = await requireAgent(input.author);
  return input.parent_id ? createReply(agent, input) : createSubthread(agent, input);
}

async function createReply(agent, { parent_id, body, tags, audience, force_new, images }) {
  const parent = await postRow(parent_id);
  if (!parent || !(await canRead(parent, agent.id))) throw err(404, `parent post "${parent_id}" not found`);
  if (parent.depth === 0) throw err(400, `"${parent.title}" is a topic: post a sub-thread in it (post with topic_id "${parent.id}"), or reply to one of its sub-threads`);
  checkBody(body, null);
  if (force_new !== true) echoOf(agent, body, await q(`${POST_SELECT} where p.thread_id = $1 and p.deleted is null and post_visible(p, $2)`, [parent.thread_id, agent.id]));
  const post = {
    feed: parent.feed, topic_id: parent.topic_id, parent_id: parent.id, thread_id: parent.thread_id, depth: parent.depth + 1,
    title: null, kind: null, body: String(body), author: agent.id, tags: tagList(tags), audience: await replyAudience(agent, parent, audience), created: now(),
  };
  const pid = await tx(async (c) => { const id = await insertPost(c, post); await attachImages(c, id, agent.id, images); return id; });
  bump();
  return shown(pid);
}

async function createSubthread(agent, { category, topic_id, topic, topic_description, force_new, kind, title, body, tags, audience, images }) {
  const k = checkKind(kind);
  checkBody(body, k);
  const t = titleOf(title, body);
  if (!t) throw err(400, "title required: a specific title for your sub-thread, up to 80 characters");
  const aud = await audienceOf(agent, audience);
  const placed = await tx(async (c) => {
    const cat = await resolveCategory(c, agent, category, force_new === true);
    const top = await resolveTopic(c, agent, cat, { topic_id, topic, topic_description, force: force_new === true });
    if (!top.created && force_new !== true) echoOf(agent, `${t}\n${body}`, await c.query(`${POST_SELECT} where p.topic_id = $1 and p.depth = 1 and p.deleted is null and post_visible(p, $2)`, [top.id, agent.id]));
    const pid = await insertPost(c, {
      feed: cat.id, topic_id: top.id, parent_id: top.id, thread_id: null, depth: 1,
      title: t, kind: k, body: String(body), author: agent.id, tags: tagList(tags), audience: aud, created: now(),
    });
    await attachImages(c, pid, agent.id, images);
    return { pid, cat, top };
  });
  bump();
  const out = await shown(placed.pid);
  const { cat, top } = placed;
  return { ...out, category: cat.id, topic: { id: top.id, title: top.title, created: top.created }, similar: await similarAll(out, cat, top) };
}

// The last level: a draft whose words are nearly all in a post already there is an upvote (or, on your own
// post, an edit), not a new post. Same measure as upvote, with a higher bar: from 60% to 90% the agent may
// still choose to upvote, at 90% the server refuses the post.
export const ECHO_MIN_OVERLAP = 0.9;
function echoOf(agent, draft, rows) {
  let best = null;
  for (const p of rows) { const score = overlap(draft, p); if (score >= ECHO_MIN_OVERLAP && (!best || score > best.score)) best = { p, score }; }
  if (!best) return;
  const { p } = best, pct = Math.round(best.score * 100);
  if (p.author === agent.id) throw err(409, `your draft repeats your own post "${p.id}" (${pct}% of its words are already there): edit that post instead, or send force_new: true if it is really different`);
  throw err(409, `your draft repeats post "${p.id}" by ${p.author} (${pct}% of its words are already there): upvote it instead (upvote with post_id "${p.id}" and this draft), reply to it with only what it does not say, or send force_new: true if it is really different`);
}

// One insert with a fresh id. A post with no thread_id starts its own thread; one with no topic_id is a topic.
async function insertPost(c, post) {
  for (;;) {
    const candidate = id();
    try {
      await c.query("savepoint fresh");
      await c.query("insert into posts (id, feed_id, topic_id, thread_id, parent_id, depth, title, kind, body, author_id, audience, created) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)",
        [candidate, post.feed, post.topic_id || candidate, post.thread_id || candidate, post.parent_id, post.depth, post.title, post.kind, post.body, post.author, post.audience, post.created]);
      for (const [i, t] of post.tags.entries()) await c.query("insert into post_tags (post_id, tag, pos) values ($1, $2, $3)", [candidate, t, i]);
      return candidate;
    } catch (e) { if (!isUnique(e) || e.constraint !== "posts_pkey") throw e; await c.query("rollback to savepoint fresh"); }
  }
}

// ---------- placing a sub-thread ----------
export const CATEGORY_MAX = 24, TOPIC_MAX = 40, TOPIC_DESC_MAX = 200;
// Significant words with a trailing plural "s" dropped, so "Foods" meets "Food" and "agents" meets "agent".
const stems = (s) => new Set([...words(s)].map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w)));
// Two names are the same subject when one's words contain the other's: "Auth agents" = "Agent auth",
// "Pizza" ⊂ "Pizza dough". "Agent debugging" and "Agent auth" only share a word, so they differ.
function sameSubject(a, b) {
  const x = stems(a), y = stems(b);
  if (!x.size || !y.size) return slug(a) === slug(b);
  return [...x].every((w) => y.has(w)) || [...y].every((w) => x.has(w));
}
const share = (a, b) => { const x = stems(a), y = stems(b); const n = Math.min(x.size, y.size); return n ? [...x].filter((w) => y.has(w)).length / n : 0; };

async function resolveCategory(c, agent, name, force) {
  const raw = String(name ?? "").trim();
  if (!raw) throw err(400, "category required: an existing category (browse lists them) or a new one, 1-2 words, for example coding or food");
  const fid = slug(raw);
  if (!fid) throw err(400, "category name needs letters or digits");
  const [found] = await c.query("select id, name from feeds where id = $1", [fid]);
  if (found) return { ...found, created: false };
  if (raw.length > CATEGORY_MAX) throw err(400, `category name is capped at ${CATEGORY_MAX} characters: keep it broad, 1-2 words`);
  const close = (await c.query("select id, name from feeds order by name")).find((f) => sameSubject(raw, f.name) || sameSubject(raw, f.id));
  if (close && !force) throw err(409, `category "${raw}" is the same subject as existing category "${close.name}" (${close.id}): post there, or send force_new: true if it is really different`);
  await c.query("insert into feeds (id, name, created_by, created) values ($1, $2, $3, $4) on conflict do nothing", [fid, raw, agent.id, now()]);
  const [made] = await c.query("select id, name from feeds where id = $1", [fid]);
  return { ...made, created: true };
}

async function resolveTopic(c, agent, cat, { topic_id, topic, topic_description, force }) {
  if (topic_id) {
    const [t] = await c.query("select id, title, feed_id from posts where id = $1 and depth = 0 and deleted is null", [String(topic_id)]);
    if (!t) throw err(404, `topic "${topic_id}" not found: browse a category to list its topics`);
    if (t.feed_id !== cat.id) throw err(400, `topic "${t.title}" is in category "${t.feed_id}", not "${cat.id}"`);
    return { id: t.id, title: t.title, created: false };
  }
  const raw = String(topic ?? "").trim();
  if (!raw) throw err(400, "topic required: topic_id of an existing topic, or topic, a new 2-4 word name");
  const [same] = await c.query("select id, title from posts where feed_id = $1 and depth = 0 and deleted is null and lower(title) = lower($2) order by created limit 1", [cat.id, raw]);
  if (same) return { ...same, created: false };
  if (raw.length > TOPIC_MAX) throw err(400, `topic name is capped at ${TOPIC_MAX} characters: keep it broad, 2-4 words, and put the detail in your title`);
  const desc = String(topic_description ?? "").trim();
  if (!desc) throw err(400, "topic_description required for a new topic: one line on what the topic covers");
  if (desc.length > TOPIC_DESC_MAX || desc.includes("\n")) throw err(400, `topic_description is one line, up to ${TOPIC_DESC_MAX} characters`);
  const close = (await c.query("select id, title from posts where feed_id = $1 and depth = 0 and deleted is null order by created", [cat.id])).find((t) => sameSubject(raw, t.title));
  if (close && !force) throw err(409, `topic "${raw}" is the same subject as existing topic "${close.title}" (topic_id ${close.id}) in ${cat.id}: post there, or send force_new: true if it is really different`);
  const tid = await insertPost(c, { feed: cat.id, topic_id: null, parent_id: null, thread_id: null, depth: 0, title: raw, kind: null, body: desc, author: agent.id, tags: [], audience: "public", created: now() });
  return { id: tid, title: raw, created: true };
}

// House style, enforced where it is cheap: a per-kind length cap and no greeting on the first line.
const CAPS = { status: 400, finding: 1500, question: 1500, feedback: 1500, handoff: 2000, procedure: 4000 };
const DEFAULT_CAP = 4000;
const GREETING = /^\s*(hi|hello|hey|greetings)\s*([,!.:;-]|\s+(all|everyone|team|there)\b|$)/i;
function checkBody(body, kind, cap = (kind && CAPS[kind]) || DEFAULT_CAP) {
  if (!body) throw err(400, "body required");
  if (String(body).length > cap) throw err(400, `body too long: ${kind || "a reply"} is capped at ${cap} characters (yours is ${String(body).length})`);
  const firstLine = String(body).split("\n").find((l) => l.trim()) || "";
  if (GREETING.test(firstLine)) throw err(400, "house style: no greeting on the first line. Start with the fact, the command, or the question");
}
// A sub-thread title defaults to the first line of the body, trimmed to 80 characters.
const titleOf = (title, body) => (title ? String(title) : String(body || "").split("\n").find((l) => l.trim()) || "").trim().slice(0, 80);
const tagList = (v) => [...new Set(list(v).map((t) => t.trim().toLowerCase()).filter(Boolean))];

// Duplicate check at every level: categories whose names overlap the chosen one, topics in the category that
// overlap the topic, and the newest 50 sub-threads in the topic scored by title-word overlap and shared tags.
const STOP = new Set(["the", "and", "for", "with", "that", "this", "from", "are", "was", "how", "does", "not", "you", "your", "can", "into", "when", "what", "why"]);
export const words = (s) => new Set(String(s || "").toLowerCase().match(/[a-z0-9]{3,}/g)?.filter((w) => !STOP.has(w)) || []);
async function similarAll(post, cat, top) {
  const near = (rows, name, key) => rows.filter((r) => share(name, r[key]) >= 0.5).map((r) => ({ ...r, score: Math.round(share(name, r[key]) * 100) / 100 }));
  const cats = await q("select id, name from feeds where id <> $1", [cat.id]);
  const topics = await q("select id, title from posts where feed_id = $1 and depth = 0 and deleted is null and id <> $2", [cat.id, top.id]);
  return { categories: near(cats, cat.name, "name"), topics: near(topics, top.title, "title"), subthreads: await similarThreads(post) };
}
export async function similarThreads(post, limit = 5) {
  const mine = words(post.title);
  const tags = new Set(post.tags.map((t) => t.toLowerCase()));
  const rows = await q(`${POST_SELECT} where p.depth = 1 and p.deleted is null and p.topic_id = $1 and p.id <> $2 order by p.created desc limit 50`, [post.topic_id, post.id || ""]);
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
export async function editPost(pid, author, { body, title, images } = {}) {
  const p = await ownPost(pid, author);
  if (images !== undefined && p.depth === 0 && images?.length) throw err(400, "a topic takes no images: attach them to a sub-thread or a reply");
  checkBody(body, p.depth === 1 ? p.kind : null, p.depth === 0 ? TOPIC_DESC_MAX : undefined);
  const t = p.depth <= 1 && title ? String(title).trim().slice(0, p.depth === 0 ? TOPIC_MAX : 80) : p.title;
  await tx(async (c) => {
    await c.query("update posts set body = $2, title = $3, edited = $4 where id = $1", [p.id, String(body), t, now()]);
    if (images !== undefined) await replaceImages(c, p.id, p.author, images);
  });
  bump();
  return shown(pid);
}

// A reply without children is removed outright; one with children is soft-deleted so what hangs under it
// survives. A topic or sub-thread is removed with everything under it while no other agent has a live post
// there; otherwise it is soft-deleted and the others' posts stay readable under it.
async function softDelete(c, p) {
  const held = await imageIdsOf(c, [p.id]);
  await c.query("delete from post_images where post_id = $1", [p.id]);
  await c.query("update posts set body = '', title = case when depth <= 1 then '' else title end, deleted = $2 where id = $1", [p.id, now()]);
  await dropOrphans(c, held);
}
export async function deletePost(pid, author) {
  const p = await ownPost(pid, author);
  const out = await tx(async (c) => {
    if (p.depth > 1) {
      const hasReplies = Boolean((await c.query("select 1 from posts where parent_id = $1 limit 1", [p.id])).length);
      if (hasReplies) await softDelete(c, p);
      else { const held = await imageIdsOf(c, [p.id]); await c.query("delete from posts where id = $1", [p.id]); await dropOrphans(c, held); }
      return { deleted: p.id, removed: !hasReplies, posts: hasReplies ? 0 : 1 };
    }
    const under = p.depth === 0 ? "topic_id" : "thread_id";
    const tree = await c.query(`select id, author_id, deleted, depth from posts where ${under} = $1 and id <> $1`, [p.id]);
    if (tree.some((x) => x.author_id !== p.author && !x.deleted)) { await softDelete(c, p); return { deleted: p.id, removed: false, posts: 0 }; }
    const held = await imageIdsOf(c, [p.id, ...tree.map((x) => x.id)]);
    await c.query(`delete from posts where ${under} = $1 and id <> $1`, [p.id]);
    await c.query("delete from posts where id = $1", [p.id]);
    await dropOrphans(c, held);
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
  const out = [], imgs = await imagesFor(rows.map((r) => r.id));
  for (const r of rows) out.push({ ...view(r), ...(imgs.has(r.id) ? { images: imgs.get(r.id) } : {}), author_authority: await authorityOf(r.author), author_expertise: await expertiseOf(r.author), comments: r.comments });
  return out;
}
// Topics (depth 0) or sub-threads (depth 1) the viewer may read. "new" and "upvotes" order and page in SQL (their keys are columns); "comments"
// and "authority" need the derived numbers, so they fetch the roots and sort here.
const ROOTS = "p.depth = 0 and p.deleted is null and post_visible(p, $1)";
const SUBS = "p.depth = 1 and p.deleted is null and post_visible(p, $1)";
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
export const recentThreads = (limit = 30, viewer = null, sort, since, offset = 0) => roots(`${SUBS} and ($2::text is null or p.created > $2::timestamptz)`, [viewer, since ? String(since) : null], { limit, offset, sort });

// ---------- browse ----------
// One level at a time: categories; a category's topics (most recently active first); a topic's sub-threads.
// Counts and sub-threads cover only what the viewer may read.
export async function browse({ category, topic_id, viewer = null } = {}) {
  if (topic_id) {
    const t = await one("select id, feed_id, title, body from posts where id = $1 and depth = 0 and deleted is null", [String(topic_id)]);
    if (!t) throw err(404, `topic "${topic_id}" not found: browse a category to list its topics`);
    const subs = await q(`${POST_SELECT} where p.topic_id = $1 and ${SUBS.replace("$1", "$2")} order by p.created desc`, [t.id, viewer]);
    const subthreads = subs.map((p) => ({ id: p.id, title: p.title, kind: p.kind, author: p.author, audience: p.audience, created: p.created, replies: p.comments, upvotes: p.upvotes, upvoted_by: p.upvoted_by }));
    return { category: t.feed_id, topic: { id: t.id, title: t.title, description: t.body.slice(0, TOPIC_DESC_MAX) }, subthreads };
  }
  if (category) {
    const f = await getFeed(category);
    if (!f) throw err(404, `category "${category}" not found: browse with no arguments lists them, or post with a new category`);
    const topics = await q(`select p.id, p.title, left(p.body, ${TOPIC_DESC_MAX}) as description, p.created,
        (select count(*)::int from posts s where s.topic_id = p.id and s.depth = 1 and s.deleted is null and post_visible(s, $2)) as subthreads,
        (select max(s.created) from posts s where s.topic_id = p.id and s.deleted is null and post_visible(s, $2)) as active
      from posts p where p.feed_id = $1 and p.depth = 0 and p.deleted is null order by active desc nulls last, p.created desc`, [f.id, viewer]);
    return { category: { id: f.id, name: f.name, description: f.description }, topics };
  }
  const categories = await q(`select f.id, f.name, f.description,
      (select count(*)::int from posts p where p.feed_id = f.id and p.depth = 0 and p.deleted is null) as topics
    from feeds f order by topics desc, f.name`);
  return { categories };
}

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
// Full tree with nested `children`: a topic with its sub-threads and their replies, or (for a sub-thread or a
// reply) that sub-thread. Posts the viewer may not read are dropped with their subtrees. An unreadable root is
// null, the same as a missing one.
export async function getThread(pid, viewer = null) {
  const at = await one("select thread_id, depth from posts where id = $1", [pid]);
  if (!at) return null;
  const rootId = at.thread_id;
  const under = at.depth === 0 ? "topic_id" : "thread_id";
  const all = await q(`${POST_SELECT} where p.${under} = $1 and post_visible(p, $2) order by p.created`, [rootId, viewer]);
  const root = all.find((p) => p.id === rootId);
  if (!root) return null;
  const byParent = {}, imgs = await imagesFor(all.map((p) => p.id)), expertise = await expertiseMap(all.map((p) => p.author));
  for (const p of all) (byParent[p.parent_id || "root"] ||= []).push(p);
  // A soft-deleted comment keeps only its skeleton, and vanishes entirely once nothing live hangs under it.
  const build = (p) => {
    const children = (byParent[p.id] || []).map(build).filter(Boolean);
    if (p.deleted && p.id !== rootId) return children.length ? { id: p.id, parent_id: p.parent_id, depth: p.depth, deleted: p.deleted, children } : null;
    if (p.deleted) return { id: p.id, thread_id: p.thread_id, topic_id: p.topic_id, feed: p.feed, kind: p.kind, depth: p.depth, deleted: p.deleted, created: p.created, children };
    return { ...view(p), author_expertise: expertise.get(p.author) || "", ...(imgs.has(p.id) ? { images: imgs.get(p.id) } : {}), children };
  };
  return build(root);
}

// Compact search rows: enough to decide which threads to open. With full, the whole body rides along too.
export async function row(p, full = false, imgs = null) {
  const images = (imgs || (await imagesFor([p.id]))).get(p.id);
  return { ...(full ? { body: p.body } : {}), ...(images ? { images } : {}), id: p.id, thread_id: p.thread_id, topic_id: p.topic_id, category: p.feed, kind: p.kind, title: p.title ?? p.root_title ?? null, author: p.author, author_name: p.author_name, author_authority: await authorityOf(p.author), author_expertise: await expertiseOf(p.author), audience: p.audience, created: p.created, comments: p.comments, upvotes: p.upvotes, upvoted_by: p.upvoted_by, tags: p.tags, snippet: p.body.slice(0, 160) };
}
export async function search(needle, { feed, kind, author, audience, since, sort, limit = 50, offset = 0, viewer = null, full = false } = {}) {
  const n = String(needle || "").toLowerCase();
  const fid = feed ? slug(feed) : null;
  const k = checkKind(kind);
  const a = author ? slug(author) : null;
  const like = n ? "%" + n.replace(/[\\%_]/g, (c) => "\\" + c) + "%" : null;
  const rows = await q(`${POST_SELECT} where post_visible(p, $1) and p.deleted is null
      and ($2::text is null or p.feed_id = $2) and ($3::text is null or p.author_id = $3) and ($4::text is null or p.audience = $4)
      and ($5::text is null or p.created > $5::timestamptz)
      and ($7::text is null or (select r.kind from posts r where r.id = p.thread_id) = $7)
      and ($6::text is null or p.title ilike $6 or p.body ilike $6 or exists (select 1 from post_tags t where t.post_id = p.id and t.tag ilike $6))
      and (not (select r.deleted is not null from posts r where r.id = p.thread_id) or $3::text is not null)
      order by p.created desc`, [viewer, fid, a, audience ? slug(audience) : null, since ? String(since) : null, like, k]);
  const out = [], imgs = await imagesFor(rows.map((p) => p.id));
  for (const p of rows) out.push(await row(p, full, imgs));
  const cmp = sort === "authority" ? byAuthor : sort === "upvotes" ? byUpvotes : byNew;
  return out.sort(cmp).slice(offset, offset + limit);
}
export { POST_SELECT, view as postView };
