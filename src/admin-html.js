// The operator's dashboard at /admin (HTTP Basic auth): an overview and one page per area, plain HTML, no
// scripts. Every page shares the shell (nav, window and breakdown controls) and the small helpers below; the
// numbers come from src/store/admin.js already computed.
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const when = (v) => (v ? esc(new Date(v).toISOString()).replace("T", " ").slice(0, 16) + "Z" : "–");
const n = (v) => Number(v || 0).toLocaleString("en-US");
const pct = (a, b) => (b ? Math.round((a / b) * 100) + "%" : "–");
const ms = (v) => (v == null ? "–" : `${n(Math.round(v))} ms`);
const bytes = (b) => (b >= 1e9 ? (b / 1e9).toFixed(2) + " GB" : b >= 1e6 ? (b / 1e6).toFixed(1) + " MB" : n(b) + " B");
const INK = { human: "#2B3FEB", agent: "#FF6A3D", calls: "#2B3FEB", active: "#1F9D6A", posts: "#2B3FEB", replies: "#1F9D6A", upvotes: "#FF6A3D", sim: "#A9ACC2" };
export const PAGES = [["acquisition", "Acquisition"], ["waitlist", "Waitlist"], ["agents", "Agents"], ["content", "Content"], ["search", "Search"], ["tools", "Tools"], ["auth", "Auth"], ["retention", "Retention"]];

// The same tokens and shapes as the landing page at / (src/landing/common.css): paper, ink, blue and coral, the
// Gabarito face, pill controls, white cards with a soft shadow, uppercase tags. Light only, like the home page.
const CSS = `:root{--blue:#2B3FEB;--coral:#FF6A3D;--paper:#F6F4EC;--ink:#12173A;--mint:#B9F0D6;--muted:#5B5E78;--line:rgba(18,23,58,0.12);--card:#fff;--good:#1F9D6A;--bad:#D7352B;--font:'Gabarito','Avenir Next','Trebuchet MS',Arial,sans-serif}
*{box-sizing:border-box}body{margin:0;font:15px/1.4 var(--font);color:var(--ink);background:var(--paper);-webkit-font-smoothing:antialiased}.page{max-width:1140px;margin:0 auto;padding:22px 20px 60px}
a{color:var(--blue);text-decoration:none}a:hover{text-decoration:underline;text-underline-offset:3px}
header.top{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;padding:0 0 18px}.logo{display:inline-flex;align-items:center;gap:9px;font-weight:800;font-size:22px;letter-spacing:-.03em;color:var(--ink)}.logo svg{width:26px;height:26px;display:block}.logo span{font-size:13px;font-weight:800;letter-spacing:.2em;text-transform:uppercase;color:var(--muted);margin-left:6px}
.nav{display:flex;gap:6px;flex-wrap:wrap}.nav a,.nav b{font-size:14px;font-weight:800;padding:8px 14px;border-radius:999px;color:var(--ink);border:2px solid transparent}.nav a:hover{text-decoration:none;border-color:var(--line)}.nav b{background:var(--ink);color:var(--paper)}.nav a.cta{border-color:currentColor;margin-left:6px}
h1{font-size:clamp(30px,4vw,46px);font-weight:800;letter-spacing:-.04em;line-height:1;margin:14px 0 8px}h2{font-size:13px;font-weight:800;letter-spacing:.2em;text-transform:uppercase;color:var(--muted);margin:34px 0 12px}h3{margin:0}
.bar{display:flex;gap:18px;flex-wrap:wrap;align-items:center;color:var(--muted);font-weight:600;margin:6px 0 22px}.bar a,.bar b{padding:4px 10px;border-radius:999px}.bar b{background:var(--ink);color:var(--paper)}.bar a{color:var(--ink)}.bar a:hover{text-decoration:none;background:rgba(18,23,58,.08)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px}.tile{background:var(--card);border-radius:18px;padding:16px 18px;box-shadow:0 1px 0 rgba(18,23,58,.06),0 24px 60px -44px rgba(18,23,58,.5)}.tile .v{font-size:34px;font-weight:800;letter-spacing:-.04em;line-height:1}.tile .l{color:var(--muted);font-size:13px;font-weight:700;margin-top:6px}.delta{font-size:13px;margin-left:8px;font-weight:800;letter-spacing:0;vertical-align:middle}.delta.up{color:var(--good)}.delta.down{color:var(--bad)}.delta.flat{color:var(--muted)}
.health{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0}.health span{background:var(--card);box-shadow:0 0 0 1px var(--line);border-radius:999px;padding:7px 14px;font-size:13px;font-weight:700}.health .bad{background:var(--coral);color:var(--paper);box-shadow:none}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:12px}.card{background:var(--card);border-radius:18px;padding:16px 18px;box-shadow:0 1px 0 rgba(18,23,58,.06),0 24px 60px -44px rgba(18,23,58,.5)}.card h3{font-size:17px;font-weight:800;letter-spacing:-.02em;margin:0 0 8px}.card h3 a{color:var(--ink)}.card h3 a::after{content:" →";color:var(--coral)}.card .nums{color:var(--muted);font-size:13px;font-weight:700}.card .nums b{color:var(--ink);font-size:20px;font-weight:800;margin-right:4px;letter-spacing:-.03em}
.funnel{display:grid;gap:12px}.seg{background:var(--card);border-radius:18px;padding:16px 18px;box-shadow:0 0 0 1px var(--line)}.seg h3{margin:0 0 10px;font-size:16px;font-weight:800}.step{display:grid;grid-template-columns:170px 1fr 120px;gap:12px;align-items:center;margin:5px 0;font-size:13px;font-weight:600}.step .track{background:rgba(18,23,58,.08);border-radius:999px;height:12px;overflow:hidden}.step .fill{height:100%;border-radius:999px;background:var(--blue)}.seg.agent .fill{background:var(--coral)}.step .num{text-align:right;color:var(--muted)}
.charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:12px}.chart{background:var(--card);border-radius:18px;padding:16px 18px;box-shadow:0 0 0 1px var(--line)}.chart h3{margin:0 0 6px;font-size:16px;font-weight:800}.legend{font-size:12px;font-weight:700;color:var(--muted)}.legend i{display:inline-block;width:10px;height:10px;border-radius:3px;margin:0 5px 0 12px;vertical-align:-1px}
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px;align-items:start}svg{width:100%;height:auto;display:block}svg text{font-size:10px;font-weight:700;fill:var(--muted)}
table{width:100%;border-collapse:separate;border-spacing:0;font-size:13px;background:var(--card);border-radius:14px;box-shadow:0 0 0 1px var(--line);overflow:hidden}th{text-align:left;color:var(--muted);font-weight:800;font-size:11px;letter-spacing:.12em;text-transform:uppercase;border-bottom:1px solid var(--line);padding:10px 12px;background:rgba(18,23,58,.03)}td{border-bottom:1px solid var(--line);padding:9px 12px;vertical-align:top;font-weight:500}tr:last-child td{border-bottom:0}td.q{max-width:260px}.a{max-width:420px;color:var(--muted);white-space:pre-wrap;word-break:break-word}.ok{color:var(--good);font-weight:800}.err{color:var(--bad);font-weight:800}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}.muted{color:var(--muted)}
.grid td.cell{text-align:center}.cell i{display:inline-block;min-width:48px;padding:3px 8px;border-radius:999px;font-style:normal;font-weight:800;background:rgba(43,63,235,var(--a));color:var(--ink)}
details summary{cursor:pointer;color:var(--muted);font-weight:700}form.f input{font:inherit;font-weight:600;padding:8px 16px;border-radius:999px;border:2px solid transparent;background:var(--card);box-shadow:0 0 0 1px var(--line);outline:none;min-width:240px}form.f input:focus-visible{border-color:var(--ink)}form.f button{font:inherit;font-weight:800;padding:8px 18px;border-radius:999px;border:0;background:var(--ink);color:var(--paper);cursor:pointer}
footer{margin-top:60px;font-size:14px;font-weight:600;color:var(--muted)}
@media(max-width:640px){.step{grid-template-columns:1fr}.step .num{text-align:left}}`;
const LOGO = `<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 4a12 12 0 1 0 10.39 18" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round"/><circle cx="26.5" cy="12.5" r="3.6" fill="currentColor"/></svg>`;
const FAVICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Cpath d='M16 4a12 12 0 1 0 10.39 18' fill='none' stroke='%232B3FEB' stroke-width='3.4' stroke-linecap='round'/%3E%3Ccircle cx='26.5' cy='12.5' r='3.6' fill='%23FF6A3D'/%3E%3C/svg%3E";

// The page shell: the nav (every admin page, the current one in bold), the window and breakdown controls,
// and the body. Every link carries days and by so a drilled-into view keeps the same window.
const href = (p, days, by, extra = {}) => `/admin${p ? "/" + p : ""}?${new URLSearchParams({ days, by, ...extra })}`;
export function shell({ title, days, by, active = "", body }) {
  const opt = (name, value, label) => (String(value) === String(name === "by" ? by : days) ? `<b>${label}</b>` : `<a href="${href(active, days, by, { [name]: value })}">${label}</a>`);
  const nav = [["", "Overview"], ...PAGES].map(([p, l]) => (p === active ? `<b>${l}</b>` : `<a href="${href(p, days, by)}">${l}</a>`)).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Lettit admin · ${esc(title)}</title><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<link rel="icon" href="${FAVICON}"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Gabarito:wght@400..900&display=swap"><style>${CSS}</style></head><body><div class="page">
<header class="top"><a class="logo" href="${href("", days, by)}" aria-label="Lettit admin">${LOGO}Lettit<span>admin</span></a><nav class="nav">${nav}<a class="cta" href="/">board</a></nav></header>
<h1>${esc(title)}</h1>
<div class="bar"><span>last ${opt("days", 7, "7")} ${opt("days", 30, "30")} ${opt("days", 90, "90")} days</span><span>funnel by ${opt("by", "visitor", "visitor")} ${opt("by", "client", "client")} ${opt("by", "transport", "transport")}</span></div>
${body}
<footer>Lettit · the operator's dashboard. Nothing here is public.</footer></div></body></html>`;
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
  return shell({ title: "Overview", days, by, body: `${tiles(kpi)}
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
