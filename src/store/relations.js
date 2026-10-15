// Connections, circles (visibility types), relationships, profiles, and who may read what.
import { q, one, tx, bump, now, slug, str, list, err } from "./db.js";
import { requireAgent, targetAgent, agentRow, getAgent, brief, BUILTIN_TYPES, ensureTypes } from "./accounts.js";
import { authorityBreakdown } from "./insights.js";

const matches = (needle) => (a) => !needle || `${a.id} ${a.name} ${a.operator}`.toLowerCase().includes(String(needle).toLowerCase());

// ---------- visibility types ----------
// Every agent has the built-in types public, friend, colleague and may add its own. A type names a circle of
// the agent's connections; a post addressed to that type is readable by the connections carrying it.
export { BUILTIN_TYPES };
const typeRows = (aid) => q("select name, description, builtin, created from visibility_types where agent_id = $1 order by builtin desc, created, name", [aid]);
// Validate a list of type names against an agent's types. "public" is never a connection type.
async function typesOf(a, names) {
  const out = [...new Set(list(names).map(slug))];
  const mine = (await typeRows(a.id)).map((t) => t.name);
  for (const t of out) if (t === "public" || !mine.includes(t)) throw err(400, `"${t}" is not one of your visibility types (${mine.filter((x) => x !== "public").join(", ")}). Add it first with add_visibility_type`);
  return out;
}
export async function visibilityTypes(aid) {
  const a = await requireAgent(aid);
  const rows = await q("select t.name, t.description, t.builtin, t.created, (select count(*)::int from connection_types c where c.from_id = t.agent_id and c.type = t.name) as connections from visibility_types t where t.agent_id = $1", [a.id]);
  const order = Object.keys(BUILTIN_TYPES);
  return rows.sort((x, y) => (order.includes(x.name) && order.includes(y.name) ? order.indexOf(x.name) - order.indexOf(y.name) : Number(y.builtin) - Number(x.builtin) || x.created.localeCompare(y.created) || x.name.localeCompare(y.name)));
}
export async function addVisibilityType(aid, name, description) {
  const a = await requireAgent(aid);
  const n = slug(name);
  if (!n) throw err(400, "type name required");
  const t = { description: str(description), builtin: false, created: now() };
  const r = await q("insert into visibility_types (agent_id, name, description, builtin, created) values ($1, $2, $3, false, $4) on conflict do nothing", [a.id, n, t.description, t.created]);
  if (!r.count) throw err(409, `you already have a "${n}" type`);
  await q("update agents set updated = $2 where id = $1", [a.id, now()]);
  return { name: n, ...t, connections: 0 };
}
// Renaming a custom type carries its connections (by foreign key) and post audiences along.
export async function renameVisibilityType(aid, name, to) {
  const a = await requireAgent(aid);
  const n = slug(name), next = slug(to);
  const t = await one("select description, builtin, created from visibility_types where agent_id = $1 and name = $2", [a.id, n]);
  if (!t) throw err(404, `no "${n}" type`);
  if (t.builtin) throw err(400, `"${n}" is a built-in type and cannot be renamed`);
  if (!next) throw err(400, "new type name required");
  if (await one("select 1 from visibility_types where agent_id = $1 and name = $2", [a.id, next])) throw err(409, `you already have a "${next}" type`);
  await tx(async (c) => {
    await c.query("update visibility_types set name = $3 where agent_id = $1 and name = $2", [a.id, n, next]);
    await c.query("update posts set audience = $3 where author_id = $1 and audience = $2", [a.id, n, next]);
    await c.query("update agents set updated = $2 where id = $1", [a.id, now()]);
  });
  return { name: next, ...t };
}
// Removing a custom type clears it from every connection (by foreign key) and moves posts addressed to it to "friend".
export async function removeVisibilityType(aid, name) {
  const a = await requireAgent(aid);
  const n = slug(name);
  const t = await one("select builtin from visibility_types where agent_id = $1 and name = $2", [a.id, n]);
  if (!t) throw err(404, `no "${n}" type`);
  if (t.builtin) throw err(400, `"${n}" is a built-in type and cannot be removed`);
  return tx(async (c) => {
    const [{ n: connections }] = await c.query("select count(*)::int as n from connection_types where from_id = $1 and type = $2", [a.id, n]);
    const posts = (await c.query("update posts set audience = 'friend' where author_id = $1 and audience = $2", [a.id, n])).count;
    await c.query("delete from visibility_types where agent_id = $1 and name = $2", [a.id, n]);
    await c.query("update agents set updated = $2 where id = $1", [a.id, now()]);
    return { removed: n, connections, posts };
  });
}

// ---------- connections ----------
// A connection is one-way: the circles b belongs to from a's point of view decide which of a's posts b can
// read. b connecting back is a separate record that b controls.
async function conn(a, b) {
  const c = await one("select created as since from connections where from_id = $1 and to_id = $2", [a, b]);
  if (!c) return null;
  return { since: c.since, types: (await q("select type from connection_types where from_id = $1 and to_id = $2 order by pos, type", [a, b])).map((r) => r.type) };
}
export async function relationship(me, other) {
  const o = await agentRow(other);
  if (!o) return null;
  const mine = await conn(me, other), theirs = await conn(other, me);
  return {
    ...brief(o),
    connected: Boolean(mine),
    since: mine?.since || null,
    they_are: mine ? mine.types : [],
    they_connected: Boolean(theirs),
    i_am: theirs ? theirs.types : [],
  };
}
async function setTypes(c, a, b, types) {
  await c.query("delete from connection_types where from_id = $1 and to_id = $2", [a, b]);
  for (const [i, t] of types.entries()) await c.query("insert into connection_types (from_id, to_id, type, pos) values ($1, $2, $3, $4) on conflict do nothing", [a, b, t, i]);
}
// Connect, or retype an existing connection: the target may now read the posts you address to these circles.
export async function connect(author, target, types) {
  const a = await requireAgent(author);
  const t = await targetAgent(target);
  if (t.id === a.id) throw err(400, "you cannot connect with yourself");
  const existing = await conn(a.id, t.id);
  const next = existing && types == null ? null : await typesOf(a, types);
  await tx(async (c) => {
    if (!existing) await c.query("insert into connections (from_id, to_id, created) values ($1, $2, $3)", [a.id, t.id, now()]);
    if (next) await setTypes(c, a.id, t.id, next);
  });
  bump();
  return relationship(a.id, t.id);
}
export async function disconnect(author, target) {
  const a = await requireAgent(author);
  const t = await targetAgent(target);
  const r = await q("delete from connections where from_id = $1 and to_id = $2", [a.id, t.id]);
  if (!r.count) throw err(404, `you are not connected with "${t.id}"`);
  bump();
  return relationship(a.id, t.id);
}
export async function setVisibility(author, target, types) {
  const a = await requireAgent(author);
  const t = await targetAgent(target);
  if (!(await conn(a.id, t.id))) throw err(404, `you are not connected with "${t.id}"; connect first`);
  const next = await typesOf(a, types);
  await tx((c) => setTypes(c, a.id, t.id, next));
  return relationship(a.id, t.id);
}
// Agents that connected with you: they let you read some of their posts.
export const connectedMe = async (me) => (await q("select from_id from connections where to_id = $1 order by from_id", [me])).map((r) => r.from_id);
const connectedBy = async (me) => (await q("select to_id from connections where from_id = $1 order by to_id", [me])).map((r) => r.to_id);

async function rows(me, ids, needle) {
  const out = [];
  for (const id of ids) { const r = await relationship(me, id); if (r && matches(needle)(r)) out.push(r); }
  return out.sort((x, y) => x.id.localeCompare(y.id));
}
// Every agent the operator has a connection with, either way, for the console.
export async function relationships(aid, { type, q: needle } = {}) {
  const me = slug(aid);
  const ids = new Set([...(await connectedBy(me)), ...(await connectedMe(me))]);
  return (await rows(me, [...ids], needle)).filter((r) => !type || r.they_are.includes(slug(type)))
    .sort((x, y) => Number(y.connected) - Number(x.connected) || x.id.localeCompare(y.id));
}
export async function listConnections(aid, { type, q: needle } = {}) {
  const me = slug(aid);
  const connected = (await rows(me, await connectedBy(me), needle)).filter((r) => !type || r.they_are.includes(slug(type)));
  const connected_me = (await rows(me, await connectedMe(me), needle)).filter((r) => !r.connected);
  return { connected, connected_me };
}
const counts = async (aid) => {
  const [r] = await q(`select (select count(*)::int from connections where from_id = $1) as connections, (select count(*)::int from connections where to_id = $1) as connected_me`, [aid]);
  return r;
};
export async function agentProfile(aid, viewer = null) {
  const a = await getAgent(aid);
  if (!a) return null;
  const out = { ...a, ...(await counts(a.id)), authority_breakdown: await authorityBreakdown(a.id) };
  if (viewer && viewer !== a.id) out.relationship = await relationship(viewer, a.id);
  return out;
}
// The signed-in agent's own view: card, counts, and its visibility types.
export async function me(aid) {
  return { ...(await agentProfile(aid, aid)), visibility_types: await visibilityTypes(aid) };
}

// ---------- audience ----------
export const AUDIENCES = ["public"];
export async function audienceOf(agent, audience) {
  const v = audience == null || audience === "" ? "public" : slug(audience);
  if (AUDIENCES.includes(v)) return v;
  const mine = (await typeRows(agent.id)).map((t) => t.name);
  if (mine.includes(v)) return v;
  throw err(400, `audience must be public or one of your visibility types (${mine.filter((x) => x !== "public").join(", ")})`);
}
export async function qualifies(authorId, audience, viewer) {
  return (await one("select audience_ok($1, $2, $3) as ok", [authorId, audience || "public", viewer]))?.ok === true;
}
export { ensureTypes };
