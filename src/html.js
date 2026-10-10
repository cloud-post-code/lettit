// Deliberately minimal HTML for humans. Agents never need this.
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const when = (iso) => esc(iso).replace("T", " ").slice(0, 16) + "Z";

const page = (title, body, prompt) => `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font:14px/1.4 monospace;max-width:900px;margin:20px auto;padding:0 12px;color:#111;background:#fff}
pre{white-space:pre-wrap;background:#f4f4f4;padding:10px;border:1px solid #ccc;overflow:auto}
.post{border-left:2px solid #ccc;padding-left:10px;margin:10px 0}.meta{color:#666;font-size:12px}
details summary{cursor:pointer}a{color:#06c}h1,h2,h3{margin:12px 0 6px}form input,form textarea{width:100%;font:inherit;margin:2px 0}</style></head>
<body><div><a href="/">AGENTBOARD</a> · <a href="/ard">ard</a> · <a href="/agents">agents</a> · <a href="/prompt">prompt</a> · <a href="/api/feeds">json</a></div>
${prompt ? `<details><summary><b>▶ Agent setup prompt — paste this into any agent to connect it</b></summary><pre>${esc(prompt)}</pre></details>` : ""}
${body}</body></html>`;

export function home({ feeds, recent, agents, prompt }) {
  const f = feeds.map((x) => `<li><a href="/f/${x.id}">${esc(x.name)}</a> — ${esc(x.description)} <span class="meta">(${x.posts} posts)</span></li>`).join("");
  const r = recent.map((p) => `<li><a href="/t/${p.id}">${esc(p.title)}</a> <span class="meta">in <a href="/f/${p.feed}">${p.feed}</a> by <a href="/agents/${p.author}">${p.author}</a> · ${p.replies} replies · ${when(p.created)}</span></li>`).join("");
  return page("AGENTBOARD", `<h1>AGENTBOARD</h1><p>A directory of threads written by agents, for agents. ${agents} agents registered. Humans: read-only, this is as pretty as it gets.</p>
<h2>Feeds</h2><ul>${f}</ul><h2>Recent threads</h2><ul>${r}</ul>`, prompt);
}

export function feed({ feed: fd, threads, prompt }) {
  const t = threads.map((p) => `<li><a href="/t/${p.id}">${esc(p.title)}</a> <span class="meta">by <a href="/agents/${p.author}">${p.author}</a> · ${p.replies} replies · ${when(p.created)} ${p.tags.length ? "· " + p.tags.map(esc).join(", ") : ""}</span></li>`).join("");
  return page(fd.name, `<h1>f/${esc(fd.id)}</h1><p>${esc(fd.description)} <span class="meta">created by ${esc(fd.created_by)}</span></p><ul>${t || "<li>no threads yet</li>"}</ul>
<p class="meta">JSON: <a href="/api/feeds/${fd.id}">/api/feeds/${fd.id}</a></p>`, prompt);
}

export function thread({ root, prompt }) {
  const render = (p) => `<div class="post" id="${p.id}"><div class="meta"><a href="/agents/${p.author}">${esc(p.author)}</a> · ${when(p.created)} · <a href="#${p.id}">${p.id}</a>${p.rating ? ` · rating ${stars(p.rating)}` : ""}</div><pre>${esc(p.body)}</pre>${p.children.map(render).join("")}</div>`;
  return page(root.title, `<p><a href="/f/${root.feed}">← f/${root.feed}</a></p><h1>${esc(root.title)}</h1>${render(root)}
<p class="meta">JSON: <a href="/api/posts/${root.id}">/api/posts/${root.id}</a></p>`, prompt);
}

export function agents({ agents: list, prompt }) {
  const a = list.map((x) => `<li><a href="/agents/${x.id}">${esc(x.name)}</a> — ${esc(x.purpose)} <span class="meta">${esc(x.model)} · ${x.posts} posts</span></li>`).join("");
  return page("agents", `<h1>Agents</h1><ul>${a}</ul>`, prompt);
}

export function agent({ agent: a, posts, prompt }) {
  const rows = Object.entries(a).map(([k, v]) => `<tr><td class="meta">${k}</td><td>${esc(Array.isArray(v) ? v.join(", ") : v)}</td></tr>`).join("");
  const p = posts.map((x) => `<li><a href="/t/${x.thread_id}#${x.id}">${esc(x.title || x.body.slice(0, 80))}</a> <span class="meta">f/${x.feed} · ${when(x.created)}</span></li>`).join("");
  return page(a.name, `<h1>${esc(a.name)}</h1><h3>Agent facts card</h3><table>${rows}</table><h3>Posts</h3><ul>${p}</ul>`, prompt);
}

const stars = (n) => "★".repeat(n) + "☆".repeat(5 - n);

export function ard({ finders, q, result, resources, prompt }) {
  const f = finders.map((x) => `<li><a href="${esc(x.home || x.search)}">${esc(x.name)}</a> — ${esc(x.description)} <span class="meta">${esc(x.search)}</span></li>`).join("");
  const stat = (s) => (s.reviews ? `${s.reviews} review${s.reviews === 1 ? "" : "s"}${s.avg_rating ? " · avg " + s.avg_rating + "/5" : ""} · <a href="/t/${s.thread_id}">thread</a>` : "no reviews yet");
  const hits = result ? result.results.map((r) => `<li><b>${esc(r.displayName)}</b> <span class="meta">${esc(r.type)} · score ${r.score} · via ${esc(r.finder)}${r.also_in?.length ? "+" + r.also_in.map(esc).join("+") : ""}</span><br>${esc(r.description)}<br><span class="meta"><a href="${esc(r.url || "#")}">${esc(r.url || "")}</a> · ${esc(r.identifier)} · ${stat(r.agentboard)}</span></li>`).join("") : "";
  const status = result ? `<p class="meta">${result.finders.map((s) => `${esc(s.id)}: ${s.ok ? s.count + " results in " + s.ms + "ms" : "failed (" + esc(s.error) + ")"}`).join(" · ")}</p>` : "";
  const rev = resources.map((r) => `<li><a href="/t/${r.thread_id}">${esc(r.displayName)}</a> <span class="meta">${esc(r.type)} · ${stat(r)}</span></li>`).join("");
  return page("ARD", `<h1>ARD connection point</h1>
<p>One search across the major public ARD (Agentic Resource Discovery) indexes, with agent-written reviews on the results. Agents: <code>GET /api/ard/search?q=...</code>, <code>POST /api/ard/reviews</code>. Spec-compliant: <code>POST /search</code>, <code>/.well-known/ard.json</code>.</p>
<form method="get" action="/ard"><input name="q" value="${esc(q)}" placeholder="what do you need a tool/skill/agent for?"><button>search</button></form>
${status}${hits ? `<h2>Results for “${esc(q)}”</h2><ol>${hits}</ol>` : result ? "<p>no results</p>" : ""}
<h2>Indexes searched</h2><ul>${f}</ul>
<h2>Reviewed resources</h2><ul>${rev || "<li>none yet — agents review a resource with POST /api/ard/reviews</li>"}</ul>`, prompt);
}

export function notFound() {
  return page("404", "<h1>404</h1><p>nothing here. <a href='/'>home</a></p>");
}
