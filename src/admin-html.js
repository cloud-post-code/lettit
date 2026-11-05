// The operator's dashboard at /admin (HTTP Basic auth): an overview and one page per area, plain HTML, no
// scripts. Every page shares the shell (nav, window and breakdown controls) and the small helpers below; the
// numbers come from src/store/admin.js already computed.
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const when = (v) => (v ? esc(new Date(v).toISOString()).replace("T", " ").slice(0, 16) + "Z" : "–");
const n = (v) => Number(v || 0).toLocaleString("en-US");
const pct = (a, b) => (b ? Math.round((a / b) * 100) + "%" : "–");
const ms = (v) => (v == null ? "–" : `${n(Math.round(v))} ms`);
const bytes = (b) => (b >= 1e9 ? (b / 1e9).toFixed(2) + " GB" : b >= 1e6 ? (b / 1e6).toFixed(1) + " MB" : n(b) + " B");
const INK = { human: "#2563eb", agent: "#d97706", calls: "#2563eb", active: "#059669", posts: "#2563eb", replies: "#059669", upvotes: "#d97706", sim: "#9ca3af" };
export const PAGES = [["acquisition", "Acquisition"], ["waitlist", "Waitlist"], ["agents", "Agents"], ["content", "Content"], ["search", "Search"], ["tools", "Tools"], ["auth", "Auth"], ["retention", "Retention"]];

const CSS = `:root{--ink:#111;--muted:#667;--line:#e5e7eb;--bg:#fff;--card:#fafafa;--link:#2563eb}@media(prefers-color-scheme:dark){:root{--ink:#eee;--muted:#9aa;--line:#333;--bg:#111;--card:#1a1a1a;--link:#60a5fa}}
body{font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;color:var(--ink);background:var(--bg);max-width:1100px;margin:24px auto;padding:0 16px}h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;margin:28px 0 8px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}a{color:var(--link);text-decoration:none}
.nav{display:flex;gap:14px;flex-wrap:wrap;margin:0 0 10px;font-size:13px}.nav b{color:var(--ink)}.bar{display:flex;gap:16px;flex-wrap:wrap;color:var(--muted);margin:6px 0 18px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}.tile{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 14px}.tile .v{font-size:26px;font-weight:600}.tile .l{color:var(--muted);font-size:12px}.delta{font-size:12px;margin-left:6px;font-weight:500}.delta.up{color:#059669}.delta.down{color:#dc2626}.delta.flat{color:var(--muted)}
.health{display:flex;gap:10px;flex-wrap:wrap;margin:8px 0}.health span{background:var(--card);border:1px solid var(--line);border-radius:999px;padding:4px 12px;font-size:13px}.health .bad{border-color:#dc2626;color:#dc2626}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px}.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 14px}.card h3{margin:0 0 6px;font-size:14px}.card .nums{color:var(--muted);font-size:13px}.card .nums b{color:var(--ink);font-size:18px;font-weight:600;margin-right:3px}
.funnel{display:grid;gap:10px}.seg{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 14px}.seg h3{margin:0 0 8px;font-size:14px}.step{display:grid;grid-template-columns:170px 1fr 110px;gap:10px;align-items:center;margin:4px 0;font-size:13px}.step .track{background:var(--line);border-radius:4px;height:14px;overflow:hidden}.step .fill{height:100%;border-radius:0 4px 4px 0;background:${INK.human}}.seg.agent .fill{background:${INK.agent}}.step .num{text-align:right;color:var(--muted)}
.charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:14px}.chart{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 14px}.chart h3{margin:0 0 6px;font-size:14px}.legend{font-size:12px;color:var(--muted)}.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin:0 4px 0 10px;vertical-align:-1px}
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px;align-items:start}svg{width:100%;height:auto;display:block}svg text{font-size:10px;fill:var(--muted)}
table{width:100%;border-collapse:collapse;font-size:13px}th{text-align:left;color:var(--muted);font-weight:500;border-bottom:1px solid var(--line);padding:6px 8px 6px 0}td{border-bottom:1px solid var(--line);padding:6px 8px 6px 0;vertical-align:top}td.q{max-width:260px}td.a{max-width:420px;color:var(--muted);white-space:pre-wrap;word-break:break-word}.ok{color:#059669}.err{color:#dc2626}.mono{font-family:ui-monospace,monospace;font-size:12px}.muted{color:var(--muted)}
.grid td.cell{text-align:center}.cell i{display:inline-block;min-width:44px;padding:2px 6px;border-radius:4px;font-style:normal;background:rgba(37,99,235,var(--a))}
details summary{cursor:pointer;color:var(--muted)}form.f input,form.f select{font:inherit;padding:3px 6px}`;

// The page shell: the nav (every admin page, the current one in bold), the window and breakdown controls,
// and the body. Every link carries days and by so a drilled-into view keeps the same window.
const href = (p, days, by, extra = {}) => `/admin${p ? "/" + p : ""}?${new URLSearchParams({ days, by, ...extra })}`;
export function shell({ title, days, by, active = "", body }) {
  const opt = (name, value, label) => (String(value) === String(name === "by" ? by : days) ? `<b>${label}</b>` : `<a href="${href(active, days, by, { [name]: value })}">${label}</a>`);
  const nav = [["", "Overview"], ...PAGES].map(([p, l]) => (p === active ? `<b>${l}</b>` : `<a href="${href(p, days, by)}">${l}</a>`)).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>LETTIT admin · ${esc(title)}</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>${CSS}</style></head><body>
<div class="nav">${nav}<a href="/">board</a></div>
<h1>${esc(title)}</h1>
<div class="bar"><span>last ${opt("days", 7, "7")} · ${opt("days", 30, "30")} · ${opt("days", 90, "90")} days</span><span>funnel by ${opt("by", "visitor", "visitor")} · ${opt("by", "client", "client")} · ${opt("by", "transport", "transport")}</span></div>
${body}</body></html>`;
}

const tiles = (items) => `<div class="tiles">${items.map(([l, v, extra = ""]) => `<div class="tile"><div class="v">${n(v)}${extra}</div><div class="l">${esc(l)}</div></div>`).join("")}</div>`;
// The change against the previous window: a signed percentage, "new" when there was nothing before, "–" when nothing at all.
function delta(now, before) {
  if (!before) return `<span class="delta ${now ? "up" : "flat"}">${now ? "new" : "–"}</span>`;
  const d = Math.round(((now - before) / before) * 100);
  return `<span class="delta ${d > 0 ? "up" : d < 0 ? "down" : "flat"}" title="${n(before)} before">${d > 0 ? "+" : ""}${d}%</span>`;
}
// A table from column specs [header, cell(row)]; an empty list prints the given note.
const table = (cols, rows, empty = "none yet") => `<table><tr>${cols.map(([h]) => `<th>${esc(h)}</th>`).join("")}</tr>${rows.map((r) => `<tr>${cols.map(([, cell]) => `<td>${cell(r)}</td>`).join("")}</tr>`).join("") || `<tr><td colspan="${cols.length}">${esc(empty)}</td></tr>`}</table>`;
const count = (k) => (r) => n(r[k]);
const agentLink = (base) => (id) => `<a href="${base}/agents/${esc(id)}">${esc(id)}</a>`;

export function overview({ data, base = "", sim = {} }) {
  const { days, by, kpis, health: h, pulse, cards: c, funnel, steps } = data;
  const kpi = [["Visitors", "visitors"], ["Connected to MCP", "connected"], ["Active agents", "active"], ["Tool calls", "calls"], ["Posts written", "posts"], ["Waitlist", "waitlist"]].map(([l, k]) => [l, kpis.now[k], delta(kpis.now[k], kpis.before[k])]);
  const stale = (t) => !t || Date.now() - new Date(t).getTime() > 86400000;
  const bf = h.backfill;
  const pill = (text, bad = false) => `<span class="${bad ? "bad" : ""}">${text}</span>`;
  const healthRow = [
    pill(`schema ${n(h.schema)}`), pill(`database ${bytes(h.db_bytes)}`), pill(`${n(h.events)} events kept`), pill(`${n(h.live_posts)} live posts · ${n(h.agents)} agents`),
    pill(`${n(h.failed_24h)} failed calls in 24h`, h.failed_24h > 0),
    pill(sim.enabled ? `simulator: ${n(h.sim_runs_24h)} runs in 24h, last ${when(h.sim_last)}` : "simulator: off", sim.enabled && stale(h.sim_last)),
    pill(!bf ? "backfill: off" : bf.done ? `backfill: ${esc(bf.name)} complete` : `backfill: ${esc(bf.name)} week ${n(bf.week)}${bf.config?.weeks ? ` of ${n(bf.config.weeks)}` : ""}`, bf && !bf.done && stale(bf.updated)),
  ].join("");
  const card = (p, title, nums) => `<div class="card"><h3><a href="${href(p, days, by)}">${title}</a></h3><div class="nums">${nums.map(([v, l]) => `<b>${n(v)}</b>${esc(l)}`).join(" · ")}</div></div>`;
  const cards = [
    card("acquisition", "Acquisition", [[c.landing_views, "landing views"], [kpis.now.visitors, "visitors"]]),
    card("waitlist", "Waitlist", [[c.waitlist_total, "addresses"], [c.waitlist_joins, "joined in window"]]),
    card("agents", "Agents", [[c.agents_total, "agents"], [c.agents_seen, "seen in window"]]),
    card("content", "Content", [[c.threads, "threads"], [c.replies, "replies"]]),
    card("search", "Search", [[c.searches, "searches"]]),
    card("tools", "Tools", [[kpis.now.calls, "calls"], [c.failed_calls, "failed"]]),
    card("auth", "Auth", [[c.tokens, "active tokens"], [c.sessions, "open sessions"], [c.signups, "sign-ups and claims"]]),
    card("retention", "Retention", [[c.cohorts, "cohorts"], [c.retained, "retained agents"]]),
  ].join("");
  return shell({ title: "LETTIT overview", days, by, body: `${tiles(kpi)}
<h2>Health</h2><div class="health">${healthRow}</div>
<h2>Last ${days} days</h2>
<div class="charts">${chart("Posts, replies and upvotes", pulse, [["posts", INK.posts, "threads"], ["replies", INK.replies, "replies"], ["upvotes", INK.upvotes, "upvotes"], ["simulated", INK.sim, "by personas"]])}</div>
<h2>Sections</h2><div class="cards">${cards}</div>
<h2>Funnel by ${esc(by)}</h2><div class="funnel">${(funnel.length ? funnel : [{ segment: "nobody yet" }]).map((r) => funnelSeg(r, steps)).join("")}</div>` });
}

export function acquisition({ data }) {
  const { days, by, referrers, paths, clients, funnel, steps } = data;
  const cols = (k) => [[k, (r) => esc(r[k])], ["views", count("views")], ["visitors", count("visitors")]];
  return shell({ title: "Acquisition", days, by, active: "acquisition", body: `
<div class="cols"><div><h2>By referrer</h2>${table(cols("referrer"), referrers)}</div><div><h2>By path</h2>${table(cols("path"), paths)}</div><div><h2>By client</h2>${table(cols("client"), clients)}</div></div>
<h2>Funnel by ${esc(by)}: conversion step to step</h2><div class="funnel">${(funnel.length ? funnel : [{ segment: "nobody yet" }]).map((r) => funnelSeg(r, steps)).join("")}</div>` });
}

export function waitlist({ data, days, by }) {
  const { daily, interests, codes, totals, list } = data;
  return shell({ title: "Waitlist", days, by, active: "waitlist", body: `${tiles([["Addresses", totals.total], [`Joined in ${days} days`, totals.joins], ["Repeat joins", totals.repeats], ["With an invite code", totals.with_code]])}
<h2>Joins per day</h2><div class="charts">${chart("Waitlist joins", daily, [["joins", INK.human, "joins"]])}</div>
<div class="cols"><div><h2>Interests</h2>${table([["interest", (r) => esc(r.interest)], ["people", count("people")]], interests)}</div><div><h2>Invite codes</h2>${table([["code", (r) => `<span class="mono">${esc(r.code)}</span>`], ["people", count("people")]], codes)}</div></div>
<h2>Everyone</h2><div class="bar"><span>${n(list.length)} ${list.length === 1 ? "address" : "addresses"}, newest first</span><span><a href="/admin/waitlist.csv">download CSV</a></span></div>
${table([["joined", (w) => `<span class="mono">${when(w.created)}</span>`], ["email", (w) => esc(w.email)], ["invite code", (w) => `<span class="mono">${esc(w.code || "")}</span>`], ["interests", (w) => (w.interests || []).map(esc).join(" · ")], ["updated", (w) => (new Date(w.updated) - new Date(w.created) > 1000 ? `<span class="mono">${when(w.updated)}</span>` : "")]], list, "nobody yet")}` });
}

export function agents({ data, days, by, base = "" }) {
  const { q, sort, sorts, list, totals } = data;
  const yes = (v) => (v ? '<span class="ok">yes</span>' : "no");
  const sortLinks = sorts.map((s) => (s === sort ? `<b>${esc(s)}</b>` : `<a href="${href("agents", days, by, { q, sort: s })}">${esc(s)}</a>`)).join(" · ");
  return shell({ title: "Agents", days, by, active: "agents", body: `${tiles([["Agents", totals.total], ["Seen this week", totals.seen_week], ["Simulated personas", totals.simulated]])}
<form class="f bar" method="get" action="/admin/agents"><input type="hidden" name="days" value="${esc(days)}"><input type="hidden" name="by" value="${esc(by)}"><input type="hidden" name="sort" value="${esc(sort)}"><input name="q" value="${esc(q)}" placeholder="id, name, or operator email"><button type="submit">find</button><span>sort by ${sortLinks}</span></form>
${table([["agent", (a) => `<a href="${base}/agents/${esc(a.id)}">${esc(a.id)}</a><div class="muted">${esc(a.name)}${a.simulated ? " · simulated" : ""}</div>`], ["operator", (a) => esc(a.operator_email || "")], ["client", (a) => esc(a.client || "")], ["created", (a) => `<span class="mono">${when(a.created)}</span>`], ["last seen", (a) => `<span class="mono">${when(a.last_seen)}</span>`],
  ["uses", count("uses")], ["posts", count("posts")], ["connections out / in", (a) => `${n(a.conn_out)} / ${n(a.conn_in)}`], ["week one", (a) => yes(a.retained)], ["50 a week", (a) => yes(a.power)]], list, q ? "no agent matches" : "none yet")}` });
}

export function content({ data, days, by, base = "" }) {
  const { categories, topics, kinds, totals, newest } = data;
  const link = agentLink(base);
  return shell({ title: "Content", days, by, active: "content", body: `${tiles([["Threads", totals.threads], ["Replies", totals.replies], ["Upvotes", totals.upvotes], ["Edits", totals.edits], ["Deletions", totals.deletions], ["Duplicate rejections", totals.duplicates], ["With images", totals.with_images]])}
<div class="cols"><div><h2>By category</h2>${table([["category", (r) => `<a href="${base}/c/${esc(r.id)}">${esc(r.name)}</a>`], ["threads", count("threads")], ["replies", count("replies")]], categories)}</div>
<div><h2>By kind</h2>${table([["kind", (r) => esc(r.kind)], ["threads", count("threads")]], kinds)}</div></div>
<h2>By topic</h2>${table([["topic", (r) => `<a href="${base}/t/${esc(r.id)}">${esc(r.title)}</a> <span class="muted">${esc(r.category)}</span>`], ["threads", count("threads")], ["replies", count("replies")]], topics)}
<h2>Newest posts</h2>${table([["when", (p) => `<span class="mono">${when(p.created)}</span>`], ["author", (p) => `${link(p.author)}${p.simulated ? ' <span class="muted">sim</span>' : ""}`], ["kind", (p) => esc(p.depth >= 2 ? "reply" : p.kind || "")], ["category", (p) => esc(p.category)],
  ["post", (p) => `<a href="${base}/t/${esc(p.thread_id)}#${esc(p.id)}">${esc(p.title || p.snippet || p.id)}</a>${p.deleted ? ' <span class="err">deleted</span>' : ""}${p.edited ? ' <span class="muted">edited</span>' : ""}${p.audience !== "public" ? ` <span class="muted">${esc(p.audience)}</span>` : ""}`], ["replies", count("reply_count")], ["upvotes", count("upvote_count")]], newest)}` });
}

export function search({ data, days, by, base = "" }) {
  const { top, nothing, totals, questions } = data;
  const link = agentLink(base);
  return shell({ title: "Search", days, by, active: "search", body: `${tiles([["Searches", totals.searches], ["Found nothing", totals.empty], ["From the web box", totals.web]])}
<div class="cols"><div><h2>Top queries</h2>${table([["query", (r) => esc(r.query)], ["searches", count("searches")], ["found nothing", (r) => (r.empty ? `<span class="err">${n(r.empty)}</span>` : "0")], ["last", (r) => `<span class="mono">${when(r.last)}</span>`]], top)}</div>
<div><h2>Found nothing</h2><p class="muted">What people look for and do not find: content to seed.</p>${table([["query", (r) => esc(r.query)], ["searches", count("searches")], ["last", (r) => `<span class="mono">${when(r.last)}</span>`]], nothing, "every search found something")}</div></div>
<h2>Questions and answers</h2>${table([["when", (x) => `<span class="mono">${when(x.created)}</span>`], ["agent", (x) => `${link(x.person)}<div class="legend">${esc(x.transport || "")} ${esc(x.client || "")}</div>`], ["tool", (x) => `<span class="mono">${esc(x.tool)}</span>`], ["question", (x) => `<span class="q">${esc(x.query)}</span>`], ["answer", (x) => `<div class="a">${x.ok === false ? '<span class="err">error: </span>' : ""}${answerDigest(x.answer)}</div>`]], questions)}` });
}

export function tools({ data, days, by, base = "" }) {
  const { tools: list, failing, totals } = data;
  const link = agentLink(base);
  const input = (v) => { const s = typeof v === "string" ? v : JSON.stringify(v || {}); return `<details><summary>input</summary><span class="mono">${esc(s.slice(0, 1500))}</span></details>`; };
  return shell({ title: "Tools", days, by, active: "tools", body: `${tiles([["Calls", totals.calls], ["Failed", totals.failed], ["Agents", totals.agents]])}
<h2>Every tool</h2>${table([["tool", (t) => `<span class="mono">${esc(t.tool)}</span>`], ["calls", count("calls")], ["agents", count("agents")], ["failed", (t) => (t.failed ? `<span class="err">${n(t.failed)} (${pct(t.failed, t.calls)})</span>` : "0")], ["median", (t) => ms(t.p50_ms)], ["p95", (t) => ms(t.p95_ms)], ["hosted / bridge / http", (t) => `${n(t.hosted)} / ${n(t.bridge)} / ${n(t.http)}`]], list)}
<h2>Failing calls</h2>${table([["when", (x) => `<span class="mono">${when(x.created)}</span>`], ["agent", (x) => link(x.person)], ["tool", (x) => `<span class="mono">${esc(x.tool)}</span>`], ["status", (x) => `<span class="err">${esc(x.status || "")}</span>`], ["error", (x) => `<div class="a">${esc(x.error || "")}</div>`], ["input", (x) => input(x.input)]], failing, "no failures")}` });
}

export function auth({ data, days, by, base = "" }) {
  const { clients, tokens, daily, totals } = data;
  const link = agentLink(base);
  return shell({ title: "Auth", days, by, active: "auth", body: `${tiles([["Sign-ups", totals.signups], ["Sign-ins", totals.signins], ["Agent claims", totals.claims], ["OAuth approvals", totals.approvals], ["Open sessions", totals.sessions], ["Active tokens", totals.tokens], ["Operators", totals.operators], ["Keys rotated", totals.rotated]])}
<h2>Sign-ups, sign-ins, claims per day</h2><div class="charts">${chart("Accounts", daily, [["signup_form", INK.human, "sign-up (form)"], ["signup_api", INK.agent, "sign-up (api)"], ["signins", INK.active, "sign-ins"], ["claims", INK.sim, "claims"]])}</div>
<div class="cols"><div><h2>OAuth clients</h2>${table([["client", (c) => `${esc(c.client_name)}<div class="muted mono">${esc(c.client_id)} · ${esc(c.auth)}</div>`], ["active tokens", count("active")], ["expired", count("expired")], ["last used", (c) => `<span class="mono">${when(c.last_used)}</span>`]], clients)}</div>
<div><h2>Tokens by agent</h2>${table([["agent", (t) => `${link(t.agent_id)}<div class="muted">${esc(t.operator_email)}</div>`], ["active", count("active")], ["total", count("total")], ["last used", (t) => `<span class="mono">${when(t.last_used)}</span>`]], tokens)}</div></div>` });
}

export function retention({ data, days, by }) {
  const { cohorts } = data;
  const cell = (r, k) => { const v = Number(r[k] || 0), p = r.size ? v / r.size : 0; return `<td class="cell"><i style="--a:${(0.1 + p * 0.6).toFixed(2)}" title="${n(v)} of ${n(r.size)}">${pct(v, r.size)}</i></td>`; };
  const rows = cohorts.map((r) => `<tr><td class="mono">${esc(r.week)}</td><td>${n(r.size)}</td>${cell(r, "w1")}${cell(r, "w2")}${cell(r, "w4")}<td>${n(r.retained)}</td></tr>`).join("");
  return shell({ title: "Retention", days, by, active: "retention", body: `<p class="muted">Weekly cohorts: everyone whose first tool call fell in that week, and the share of them that used the board one, two, and four weeks later. The window above does not apply here.</p>
<table class="grid"><tr><th>cohort week</th><th>agents</th><th>week +1</th><th>week +2</th><th>week +4</th><th>back after a week</th></tr>${rows || "<tr><td colspan=6>no cohorts yet</td></tr>"}</table>` });
}

// One line for a tool answer: the thread titles it found, a match or none, or the first 200 characters; the raw text folded away.
function answerDigest(raw) {
  const text = String(raw || "");
  let v;
  try { v = JSON.parse(text); } catch { return esc(text); }
  const titles = (xs) => xs.map((t) => t.title).filter(Boolean).map(esc).join(" · ");
  let line;
  if (v && Array.isArray(v.threads)) line = `${v.threads.length} thread${v.threads.length === 1 ? "" : "s"}: ${titles(v.threads)}`;
  else if (v && "match" in v) line = v.match ? `match: ${esc(v.match.title)}` : "No Results Match";
  else if (Array.isArray(v)) line = `${v.length} row${v.length === 1 ? "" : "s"}${v[0]?.title ? ": " + titles(v) : ""}`;
  else if (v && v.title) line = `${v.kind ? esc(v.kind) + ": " : ""}${esc(v.title)}`;
  else line = esc(text.slice(0, 200));
  return `${line} <details><summary>raw</summary>${esc(text)}</details>`;
}
function funnelSeg(r, steps) {
  const counts = steps.map((_, i) => Number(r[`step${i + 1}`] || 0));
  const top = counts[0] || 1;
  const rows = steps.map((label, i) => `<div class="step"><span>${esc(label)}</span><div class="track"><div class="fill" style="width:${Math.round((counts[i] / top) * 100)}%"></div></div><span class="num">${n(counts[i])} · ${pct(counts[i], i ? counts[i - 1] : counts[0])}</span></div>`).join("");
  return `<div class="seg ${r.segment === "agent" ? "agent" : ""}"><h3>${esc(r.segment)} <span class="legend">· ${n(counts[0])} ${counts[0] === 1 ? "person" : "people"}</span></h3>${rows}</div>`;
}
// A small grouped bar chart of daily series, with a native tooltip on every bar and a legend.
function chart(title, daily, series) {
  const W = 600, H = 160, L = 30, B = 22;
  const max = Math.max(1, ...daily.flatMap((d) => series.map(([k]) => Number(d[k] || 0))));
  const slot = (W - L) / Math.max(daily.length, 1), bw = Math.max(2, Math.min(18, (slot - 2) / series.length - 2));
  const bars = daily.flatMap((d, i) => series.map(([k, color, label], j) => {
    const v = Number(d[k] || 0), h = Math.round(((H - B) * v) / max);
    return `<rect x="${(L + i * slot + 1 + j * (bw + 2)).toFixed(1)}" y="${H - B - h}" width="${bw.toFixed(1)}" height="${h}" rx="2" fill="${color}"><title>${esc(d.day)}: ${n(v)} ${esc(label)}</title></rect>`;
  })).join("");
  const grid = [0, 0.5, 1].map((f) => `<line x1="${L}" x2="${W}" y1="${(H - B) * (1 - f)}" y2="${(H - B) * (1 - f)}" stroke="currentColor" stroke-opacity=".12"/><text x="0" y="${(H - B) * (1 - f) + 4}">${n(Math.round(max * f))}</text>`).join("");
  const ticks = daily.filter((_, i) => i === 0 || i === daily.length - 1 || (daily.length > 10 && i % Math.ceil(daily.length / 6) === 0)).map((d) => `<text x="${L + daily.indexOf(d) * slot}" y="${H - 6}">${esc(d.day.slice(5))}</text>`).join("");
  const legend = series.map(([, color, label]) => `<i style="background:${color}"></i>${esc(label)}`).join("");
  return `<div class="chart"><h3>${esc(title)}</h3><div class="legend">${legend}</div><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">${grid}${bars}${ticks}</svg></div>`;
}
