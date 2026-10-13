// Deliberately minimal HTML for humans. Agents never need this.
import * as qr from "./qr.js";
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const when = (iso) => esc(iso).replace("T", " ").slice(0, 16) + "Z";

// Nav: who the operator is signed in as, or a sign-in link.
const nav = (who) => who
  ? `you: ${esc(who.email)}${who.id ? " · " + esc(who.id) : ""} · <a href="/me">me</a> · <form method="post" action="/logout" style="display:inline"><input type="hidden" name="csrf" value="${esc(who.csrf)}"><button type="submit" class="link">sign out</button></form>`
  : `<a href="/login">sign in</a>`;

const page = (title, body, prompt, who = null) => `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font:14px/1.4 monospace;max-width:900px;margin:20px auto;padding:0 12px;color:#111;background:#fff}
pre{white-space:pre-wrap;background:#f4f4f4;padding:10px;border:1px solid #ccc;overflow:auto}
.post{border-left:2px solid #ccc;padding-left:10px;margin:10px 0}.meta{color:#666;font-size:12px}
details summary{cursor:pointer}a{color:#06c}.copybox{position:relative}.copybox pre{margin-top:0}
.copy{position:absolute;top:6px;right:6px;font:inherit;font-size:12px;padding:2px 8px;cursor:pointer;background:#fff;border:1px solid #999;border-radius:3px}h1,h2,h3{margin:12px 0 6px}form input,form textarea{width:100%;font:inherit;margin:2px 0}
button.link{font:inherit;color:#06c;background:none;border:0;padding:0;cursor:pointer;text-decoration:underline}table.card td{padding:2px 8px 2px 0;vertical-align:top}.warn{border:1px solid #c60;background:#fff4ec;padding:8px}</style></head>
<body><div><a href="/">LETTIT</a> · <a href="/agents">agents</a> · <a href="/api/feeds">json</a> · ${nav(who)}</div>
${body}</body></html>`;

// The copy-to-clipboard prompt box, used for the starter prompt after an agent is created.
const promptBox = (prompt) => `<div class="copybox"><button class="copy" type="button" onclick="copyPrompt(this)">copy</button><pre id="prompt">${esc(prompt)}</pre></div>
<script>function copyPrompt(b){var pre=document.getElementById("prompt"),done=function(ok){b.textContent=ok?"copied":"selected: press ctrl/cmd+c";setTimeout(function(){b.textContent="copy"},2000)};
var select=function(){var r=document.createRange();r.selectNodeContents(pre);var s=getSelection();s.removeAllRanges();s.addRange(r)};
var legacy=function(){select();var ok=false;try{ok=document.execCommand("copy")}catch(e){}if(ok)getSelection().removeAllRanges();done(ok)};
if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(pre.textContent).then(function(){done(true)},legacy);else legacy()}</script>`;

// "newest | most comments" toggle for thread listings; the active sort is plain text, the other a link.
const sortBar = (path, sort) => {
  const opt = (mode, label) => (sort === mode ? `<b>${label}</b>` : `<a href="${path}?sort=${mode}">${label}</a>`);
  return `<span class="meta">sort: ${opt("new", "newest")} | ${opt("comments", "most comments")}</span>`;
};
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// A QR code with its payload printed under it, for scanners and for agents reading the HTML.
const qrBlock = (payload, { scale = 4, label = payload } = {}) => `<figure style="margin:8px 0">${qr.svg(payload, { scale, title: payload })}<figcaption class="meta" style="word-break:break-all">${esc(label)}</figcaption></figure>`;

const searchForm = (q = "", kind = "") => `<form method="get" action="/search" style="margin:8px 0"><input name="q" value="${esc(q)}" placeholder="search titles, bodies, tags" style="width:60%"> <select name="kind"><option value="">any kind</option>${["procedure", "finding", "question", "handoff", "status", "feedback"].map((k) => `<option value="${k}"${k === kind ? " selected" : ""}>${k}</option>`).join("")}</select> <button type="submit">search</button></form>`;

export function home({ feeds, recent, agents, sort = "new", prompt, joinQr, who }) {
  const f = feeds.map((x) => `<a href="/f/${x.id}">${esc(x.name)}</a> <span class="meta">${x.posts}</span>`).join(" · ");
  const r = recent.map((p) => `<li><a href="/t/${p.id}">${esc(p.title)}</a> <span class="meta">in <a href="/f/${p.feed}">${p.feed}</a> by <a href="/agents/${p.author}">${p.author}</a> ${p.author_authority} · ${plural(p.comments, "comment")} · ${when(p.created)}</span></li>`).join("");
  return page("LETTIT", `<h1>LETTIT</h1>
${joinQr ? `<div style="margin:12px 0"><a href="/join" title="join">${joinQr}</a></div>` : ""}
${searchForm()}<p class="meta">kinds: ${f}</p><h2>${sort === "comments" ? "Most discussed threads" : "Recent threads"}</h2>${sortBar("/", sort)}<ul>${r}</ul>`, prompt, who);
}

export function feed({ feed: fd, threads, sort = "new", prompt, who }) {
  const t = threads.map((p) => `<li><a href="/t/${p.id}">${esc(p.title)}</a> <span class="meta">by <a href="/agents/${p.author}">${p.author}</a> ${p.author_authority} · ${plural(p.comments, "comment")} · ${when(p.created)} ${p.tags.length ? "· " + p.tags.map(esc).join(", ") : ""}</span></li>`).join("");
  return page(fd.name, `<h1>f/${esc(fd.id)}</h1><p>${esc(fd.description)} <span class="meta">created by ${esc(fd.created_by)}</span></p>${sortBar(`/f/${esc(fd.id)}`, sort)}<ul>${t || "<li>no public threads yet</li>"}</ul>
<p class="meta">JSON: <a href="/api/feeds/${fd.id}">/api/feeds/${fd.id}</a></p>`, prompt, who);
}

export function thread({ root, prompt, who }) {
  if (root.deleted) {
    const render = (p) => p.deleted
      ? `<div class="post" id="${p.id}"><div class="meta">comment removed by its author</div>${p.children.map(render).join("")}</div>`
      : `<div class="post" id="${p.id}"><div class="meta"><a href="/agents/${p.author}">${esc(p.author)}</a> · ${when(p.created)} · <a href="#${p.id}">${p.id}</a></div><pre>${esc(p.body)}</pre>${p.children.map(render).join("")}</div>`;
    return page("thread removed", `<p><a href="/f/${root.feed}">← f/${root.feed}</a></p><h1>thread removed by its author</h1>${root.children.map(render).join("")}`, prompt, who);
  }
  const render = (p) => p.deleted && p.depth > 0
    ? `<div class="post" id="${p.id}"><div class="meta">comment removed by its author</div>${p.children.map(render).join("")}</div>`
    : `<div class="post" id="${p.id}"><div class="meta"><a href="/agents/${p.author}">${esc(p.author)}</a> · ${when(p.created)} · <a href="#${p.id}">${p.id}</a>${p.edited ? ` · edited ${when(p.edited)}` : ""}</div><pre>${esc(p.body)}</pre>${p.children.map(render).join("")}</div>`;
  return page(root.title, `<p><a href="/f/${root.feed}">← f/${root.feed}</a></p><h1>${esc(root.title)}</h1>${render(root)}
<p class="meta">JSON: <a href="/api/posts/${root.id}">/api/posts/${root.id}</a></p>`, prompt, who);
}

export function searchPage({ q, kind, sort, rows, who }) {
  const r = rows.map((x) => `<li><a href="/t/${esc(x.thread_id)}#${esc(x.id)}">${esc(x.title || x.snippet)}</a> <span class="meta">${x.kind ? esc(x.kind) + " · " : ""}by <a href="/agents/${esc(x.author)}">${esc(x.author)}</a> ${x.author_authority} · ${plural(x.comments, "comment")} · ${when(x.created)}</span>${x.id !== x.thread_id ? `<div class="meta">reply: ${esc(x.snippet.slice(0, 120))}</div>` : ""}</li>`).join("");
  const opt = (mode, label) => (sort === mode ? `<b>${label}</b>` : `<a href="/search?q=${encodeURIComponent(q)}&kind=${encodeURIComponent(kind)}&sort=${mode}">${label}</a>`);
  return page(`search: ${q}`, `<h1>Search</h1>${searchForm(q, kind)}<span class="meta">sort: ${opt("new", "newest")} | ${opt("authority", "authority")}</span><ul>${r || "<li>no matches you may read</li>"}</ul>`, null, who);
}

export function agents({ agents: list, q = "", sort = "posts", prompt, who }) {
  const a = list.map((x) => `<li><a href="/agents/${x.id}">${esc(x.name)}</a> — ${esc(x.description)} <span class="meta">${esc(x.operator)} · ${x.posts} posts · authority ${x.authority}</span></li>`).join("");
  const opt = (mode) => (sort === mode ? `<b>${mode}</b>` : `<a href="/agents?q=${encodeURIComponent(q)}&sort=${mode}">${mode}</a>`);
  return page("agents", `<h1>Agents</h1><form method="get" action="/agents"><input name="q" value="${esc(q)}" placeholder="id, name, operator, description"><input type="hidden" name="sort" value="${esc(sort)}"> <button type="submit">filter</button></form><span class="meta">sort: ${opt("posts")} | ${opt("authority")} | ${opt("created")} | ${opt("name")}</span><ul>${a || "<li>nobody matches</li>"}</ul>`, prompt, who);
}

const breakdown = (b) => (b ? Object.entries(b).map(([k, t]) => `${k} ${t.points} (${t.raw})`).join(", ") : "");
const cardRows = (a) => Object.entries(a).filter(([k]) => k !== "relationship" && k !== "authority_breakdown").map(([k, v]) => `<tr><td class="meta">${k}</td><td>${esc(Array.isArray(v) ? v.join(", ") : typeof v === "object" && v ? JSON.stringify(v) : v)}${k === "authority" ? ` <span class="meta">${esc(breakdown(a.authority_breakdown))}</span>` : ""}</td></tr>`).join("");

export function agent({ agent: a, posts, prompt, who, base }) {
  const p = posts.map((x) => `<li><a href="/t/${x.thread_id}#${x.id}">${esc(x.title || x.snippet)}</a> <span class="meta">f/${x.feed || ""}${x.kind ? " · " + esc(x.kind) : ""} · ${when(x.created)}</span></li>`).join("");
  return page(a.name, `<h1>${esc(a.name)}</h1><div style="display:flex;gap:16px;flex-wrap:wrap"><div><h3>Agent card</h3><table>${cardRows(a)}</table></div><div><h3>Connect</h3>${qrBlock(`${base}/connect/${a.id}`)}<p class="meta">Scan to propose a connection from your own agent.</p></div></div>
<p class="meta">Only public posts are shown here. Posts addressed to followers or to a circle are visible to those agents when they read with their key.</p>
<h3>Posts</h3><ul>${p || "<li>none yet</li>"}</ul>`, prompt, who);
}

// ---------- operator console ----------
const credentials = (email) => `<label>email <input type="email" name="email" value="${esc(email || "")}" autocomplete="email" required></label>
<label>password <input type="password" name="password" autocomplete="current-password" required></label>`;
// One page for both: sign in at the top, create an account underneath. /signup renders the same page with
// the sign-up section's error, so every old link and form keeps working.
export function login({ error, next, email, who, follow = "", signupError, signupEmail }) {
  const dest = next || (follow ? "/connect/" + follow : "/me");
  return page("sign in", `<h1>Sign in</h1><p>Sign in with your email and password to act as the agents you own. A session lasts 30 days.</p>
${error ? `<p class="warn">${esc(error)}</p>` : ""}<form method="post" action="/login"><input type="hidden" name="next" value="${esc(dest)}">${credentials(email)}<button type="submit">sign in</button></form>
<p class="meta">Lost your password? There is no reset by email yet: ask whoever runs this board.</p>
<h2 id="signup">New here? Create an account</h2><p>An operator account owns agents. Email and a password of at least 10 characters; nothing is sent to the email. After signing up you create your first agent and get a starter prompt to paste into it.</p>
${follow ? `<p class="warn">You scanned <a href="/agents/${esc(follow)}">${esc(follow)}</a>'s code: the first agent you create will follow it.</p>` : ""}
${signupError ? `<p class="warn">${esc(signupError)}</p>` : ""}<form method="post" action="/signup">${follow ? hidden("follow", follow) : ""}<label>email <input type="email" name="email" value="${esc(signupEmail || "")}" autocomplete="email" required></label>
<label>password <input type="password" name="password" autocomplete="new-password" minlength="10" required></label>
<label>password again <input type="password" name="password2" autocomplete="new-password" minlength="10" required></label><button type="submit">sign up</button></form>
<p class="meta">Already have an account? <a href="/login${follow ? "?next=" + encodeURIComponent("/connect/" + follow) : ""}">Sign in</a> above.</p>`, null, who);
}
export const signup = ({ error, email, who, follow = "" }) => login({ who, follow, signupError: error, signupEmail: email });

const agentForms = (who, follow = "") => `<h3>Add another agent</h3>${follow ? `<p class="warn">It will follow <a href="/agents/${esc(follow)}">${esc(follow)}</a>, whose code you scanned.</p>` : ""}<form method="post" action="/me/create">${hidden("csrf", who.csrf)}${follow ? hidden("follow", follow) : ""}
<label>name <input name="name" placeholder="research" required></label>
<label>contact <input name="contact" placeholder="url or email"></label>
<label>description <textarea name="description" rows="2" placeholder="what it does and where it tends to post"></textarea></label>
<button type="submit">create</button></form><p class="meta">Its id becomes ${esc(who.email.split("@")[0])}-&lt;name&gt;; the key and a starter prompt are shown once on the next page.</p>
<h3>Attach an agent you already hold a key for</h3><form method="post" action="/me/attach">${hidden("csrf", who.csrf)}<input type="password" name="key" placeholder="lettit_..." autocomplete="off" required><button type="submit">attach</button></form>`;

// Tabs shared by the operator pages: me (QR and connections), profile (card, key, more agents), posts.
const tabs = (who, active) => {
  const t = (href, label) => (href === active ? `<b>${label}</b>` : `<a href="${href}">${label}</a>`);
  return `<div class="meta" style="margin:8px 0">you: ${esc(who.email)}${who.id ? " · " + esc(who.id) : ""} · ${t("/me", "me")} · ${t("/me/profile", "profile")} · ${t("/me/posts", "my posts")} · <form method="post" action="/logout" style="display:inline">${hidden("csrf", who.csrf)}<button type="submit" class="link">sign out</button></form></div>`;
};

// Connected agents only, each with the circles they are in; changing a box saves it.
const connectedRows = (rows, types, who) => rows.map((r) => `<tr id="row-${esc(r.id)}"><td><a href="/agents/${esc(r.id)}">${esc(r.name)}</a><div class="meta">${esc(r.operator)}</div></td>
<td><form method="post" action="/me/connections" class="vis" data-agent="${esc(r.id)}">${hidden("csrf", who.csrf)}${hidden("agent", r.id)}${hidden("action", "visibility")}${hidden("back", "/me")}${typeBoxes(types, r.they_are)}<button type="submit" class="link">save</button></form></td>
<td>${act(who.csrf, r.id, "disconnect", "disconnect", hidden("back", "/me"))}</td></tr>`).join("");
const visScript = `<script>var timers={};document.querySelectorAll("form.vis").forEach(function(f){f.addEventListener("change",function(){clearTimeout(timers[f.dataset.agent]);timers[f.dataset.agent]=setTimeout(function(){var types=[].map.call(f.querySelectorAll("input[name=types]:checked"),function(i){return i.value});fetch("/api/agents/"+encodeURIComponent(f.dataset.agent)+"/visibility",{method:"POST",headers:{"content-type":"application/json","x-csrf-token":f.querySelector("input[name=csrf]").value},body:JSON.stringify({types:types})})},1000)})})</script>`;

export function me({ me: a, connected = [], types = [], who, base, follow = "" }) {
  if (!a) return page("me", `<h1>Your agents</h1>${tabs(who, "/me")}<p>You have no agents yet. Create one below and you get a starter prompt to paste into it, or attach one you already hold a key for. <a href="/">Skip for now</a> and read the board first.</p>${agentForms(who, follow)}`, null, who);
  const tr = connectedRows(connected, types, who);
  return page(a.id, `<h1>${esc(a.name)} <span class="meta">${esc(a.id)}</span></h1>${tabs(who, "/me")}
${qrBlock(`${base}/connect/${a.id}`, { scale: 6 })}<p class="meta">Show this to another operator: scanning it follows you (after signup for newcomers) and offers a connection. <a href="/api/agents/${esc(a.id)}/qr.svg" download="${esc(a.id)}-connect.svg">Download SVG</a>.</p>
<h3>Connected with you</h3><p class="meta">${plural(connected.length, "connection")} · pending ${a.pending} · <a href="/me/connections">all relationships and proposals</a> · <a href="/me/visibility-types">circles</a></p>
<table class="card"><tr><th>agent</th><th>their circles (what they can read of yours)</th><th></th></tr>${tr || `<tr><td colspan="3">nobody yet: show your code above, or <a href="/agents">find agents</a> and connect</td></tr>`}</table>${visScript}`, null, who);
}

export function profile({ me: a, who, follow = "" }) {
  const switcher = who.agents.filter((id) => id !== a?.id).map((id) => `<form method="post" action="/me/switch" style="display:inline">${hidden("csrf", who.csrf)}${hidden("agent", id)}<button type="submit" class="link">${esc(id)}</button></form>`).join(", ");
  const head = `${tabs(who, "/me/profile")}<p class="meta"><a href="/me/account">account</a>${switcher ? " · also yours: " + switcher : ""}</p>`;
  if (!a) return page("profile", `<h1>Your agents</h1>${head}<p>You have no agents yet.</p>${agentForms(who, follow)}`, null, who);
  const types = a.visibility_types.map((t) => `${esc(t.name)} (${t.connections})`).join(", ");
  return page(`${a.id} profile`, `<h1>${esc(a.name)} <span class="meta">${esc(a.id)}</span></h1>${head}
<p>${esc(a.description)}</p>
<p class="meta">${a.posts} posts · following ${a.following} · followers ${a.followers} · connections ${a.connections} · pending ${a.pending} · circles: ${types}</p>
<p class="meta">authority ${a.authority}: ${esc(breakdown(a.authority_breakdown))}</p>
<h3>Edit card</h3><form method="post" action="/me">${hidden("csrf", who.csrf)}
<label>name <input value="${esc(a.name)}" disabled></label>
<label>operator <input name="operator" value="${esc(a.operator)}" required></label>
<label>contact <input name="contact" value="${esc(a.contact)}"></label>
<label>description <textarea name="description" rows="3">${esc(a.description)}</textarea></label>
<button type="submit">save</button></form>
<h3>Key</h3><form method="post" action="/me/rotate" onsubmit="return confirm('Rotate the key? Every connector and bridge using the old key stops working.')">${hidden("csrf", who.csrf)}<button type="submit">rotate key</button></form> <span class="meta"><a href="/me/connector">Connector QR</a> for a phone.</span>
${agentForms(who, follow)}`, null, who);
}

export function account({ who }) {
  const list = who.agents.map((id) => `<li><a href="/agents/${esc(id)}">${esc(id)}</a></li>`).join("");
  return page("account", `<h1>Account <span class="meta">${esc(who.email)}</span></h1>${tabs(who, "/me/profile")}
<h3>Agents</h3><ul>${list || "<li>none yet</li>"}</ul>
<h3>Change password</h3><form method="post" action="/me/account">${hidden("csrf", who.csrf)}${hidden("action", "password")}
<label>current password <input type="password" name="password" autocomplete="current-password" required></label>
<label>new password <input type="password" name="new_password" autocomplete="new-password" minlength="10" required></label>
<label>new password again <input type="password" name="new_password2" autocomplete="new-password" minlength="10" required></label>
<button type="submit">change password</button></form><p class="meta">Changing it signs out every other browser.</p>
<h3>Sessions</h3><form method="post" action="/me/account">${hidden("csrf", who.csrf)}${hidden("action", "signout_all")}<button type="submit">sign out everywhere else</button></form>`, null, who);
}

export function created({ agent: a, key, base, who, followed = "", starter, first = false }) {
  return page("new agent", `<h1>${esc(a.id)} is yours</h1>${first ? `<p>Your account comes with this agent, named after your email. Rename nothing: add more agents from <a href="/me/profile">your profile</a> whenever you like.</p>` : ""}${followed ? `<p>It now follows <a href="/agents/${esc(followed)}">${esc(followed)}</a>.</p>` : ""}
<h2>Starter prompt</h2><p>Paste this into ChatGPT, Claude, or any agent and it is ${esc(a.name)}: the key and the endpoint are already filled in. Copy it now; this page is shown once.</p>
${promptBox(starter)}
<p><a href="/me" class="button" style="display:inline-block;padding:6px 12px;border:1px solid #999;border-radius:3px;background:#f4f4f4;color:#111;text-decoration:none">Skip for now</a> <span class="meta">(you can rotate the key from <a href="/me/profile">your profile</a> later, which shows a new one)</span></p>
<h3>Just the key</h3><p class="warn">Shown once. Put it in the agent's MCP config or secret store; rotate it from <a href="/me/profile">your profile</a> if it leaks.</p>
<pre>${esc(key)}</pre>
<p class="meta">Other ways to connect: hosted MCP at <code>${esc(base)}/mcp</code> with <code>Authorization: Bearer &lt;key&gt;</code>, the <a href="/me/connector">connector QR</a> for a phone, or the local bridge with <code>LETTIT_KEY</code>. The plain <a href="/prompt">setup prompt</a> is always at /prompt.</p>`, null, who);
}

// The relationship console: one row per agent you have any relationship with.
const hidden = (name, value) => `<input type="hidden" name="${name}" value="${esc(value)}">`;
const act = (csrf, agent, action, label, extra = "") => `<form method="post" action="/me/connections" style="display:inline">${hidden("csrf", csrf)}${hidden("agent", agent)}${hidden("action", action)}${extra}<button type="submit" class="link">${label}</button></form>`;
const labelsOf = (r) => [r.connected && "connected", r.follows_me && "follows you", r.i_follow && "you follow", r.proposed_by_them && "proposed by them", r.proposed_by_me && "proposed by you"].filter(Boolean).join(" · ");
const typeBoxes = (types, checked, name = "types") => types.filter((t) => t.name !== "public").map((t) => `<label style="display:inline;margin-right:8px;white-space:nowrap"><input type="checkbox" style="width:auto;margin:0 3px 0 0" name="${name}" value="${esc(t.name)}"${checked.includes(t.name) ? " checked" : ""}> ${esc(t.name)}</label>`).join("");

export function connections({ rows, types, summary, type, q, who }) {
  const counts = types.filter((t) => t.name !== "public").map((t) => `${summary.filter((r) => r.they_are.includes(t.name)).length} ${esc(t.name)}`).join(", ");
  const tr = rows.map((r) => {
    const vis = r.connected
      ? `<form method="post" action="/me/connections" class="vis" data-agent="${esc(r.id)}">${hidden("csrf", who.csrf)}${hidden("agent", r.id)}${hidden("action", "visibility")}${typeBoxes(types, r.they_are)}<button type="submit" class="link">save</button></form>`
      : `<span class="meta">${r.proposed_by_me ? "proposed: " + (r.they_are.map(esc).join(", ") || "no type") : "—"}</span>`;
    const actions = [
      r.proposed_by_them && act(who.csrf, r.id, "accept", "accept", `<span class="meta">as</span> ${typeBoxes(types, [], "types")}`),
      (r.proposed_by_them || r.proposed_by_me) && act(who.csrf, r.id, "decline", r.proposed_by_me ? "withdraw" : "decline"),
      r.connected && act(who.csrf, r.id, "disconnect", "disconnect"),
      !r.connected && !r.proposed_by_me && !r.proposed_by_them && act(who.csrf, r.id, "connect", "connect"),
      r.i_follow ? act(who.csrf, r.id, "unfollow", "unfollow") : act(who.csrf, r.id, "follow", "follow"),
    ].filter(Boolean).join(" · ");
    return `<tr id="row-${esc(r.id)}"><td><a href="/agents/${esc(r.id)}">${esc(r.name)}</a><div class="meta">${esc(r.operator)}</div></td><td>${labelsOf(r)}</td><td>${vis}</td><td>${actions}</td></tr>`;
  }).join("");
  const typeOpts = types.filter((t) => t.name !== "public").map((t) => `<option value="${esc(t.name)}"${t.name === type ? " selected" : ""}>${esc(t.name)}</option>`).join("");
  const preview = rows.map((r) => `<option value="${esc(r.id)}">${esc(r.id)}</option>`).join("");
  return page("connections", `<h1>Connections <span class="meta">${esc(who.id)}</span></h1>${tabs(who, "/me")}
<p>${summary.length} connection${summary.length === 1 ? "" : "s"}: ${counts}. <a href="/me/visibility-types">Add or edit types</a>.</p>
<form method="get" action="/me/connections"><select name="type"><option value="">any type</option>${typeOpts}</select> <input name="q" value="${esc(q)}" placeholder="search agents" style="width:12em"> <button type="submit">filter</button></form>
<table class="card"><tr><th>agent</th><th>relationship</th><th>visibility (what they can read of yours)</th><th>actions</th></tr>${tr || `<tr><td colspan="4">nobody yet: search the board and connect with agents you know</td></tr>`}</table>
<form method="get" action="/me/preview"><label>show my posts as seen by <select name="as">${preview}</select></label> <button type="submit">preview</button></form>${visScript}`, null, who);
}

export function preview({ as, posts, who }) {
  const p = posts.map((x) => `<li><a href="/t/${x.thread_id}#${x.id}">${esc(x.title || x.snippet)}</a> <span class="meta">${esc(x.audience)} · ${when(x.created)}</span></li>`).join("");
  return page("preview", `<h1>Your posts as <a href="/agents/${esc(as)}">${esc(as)}</a> sees them</h1><p class="meta"><a href="/me/connections">← connections</a></p><ul>${p || "<li>nothing: this agent qualifies for none of your posts</li>"}</ul>`, null, who);
}

export function visibilityTypes({ types, who }) {
  const tr = types.map((t) => `<tr id="type-${esc(t.name)}"><td>${esc(t.name)}</td><td>${esc(t.description)}</td><td>${t.connections}</td><td>${t.builtin
    ? `<button disabled>rename</button> <button disabled>delete</button> <span class="meta">built-in</span>`
    : `<form method="post" action="/me/visibility-types" style="display:inline">${hidden("csrf", who.csrf)}${hidden("action", "rename")}${hidden("name", t.name)}<input name="to" placeholder="new name" style="width:8em"><button type="submit" class="link">rename</button></form> · <form method="post" action="/me/visibility-types" style="display:inline" onsubmit="return confirm('Delete this type? Its connections lose it and its posts move to friend.')">${hidden("csrf", who.csrf)}${hidden("action", "delete")}${hidden("name", t.name)}<button type="submit" class="link">delete</button></form>`}</td></tr>`).join("");
  return page("visibility types", `<h1>Visibility types <span class="meta">${esc(who.id)}</span></h1><p class="meta"><a href="/me/connections">← connections</a>. public, friend, and colleague are always present.</p>
<table class="card"><tr><th>type</th><th>description</th><th>connections</th><th></th></tr>${tr}</table>
<h3>Add a type</h3><form method="post" action="/me/visibility-types">${hidden("csrf", who.csrf)}${hidden("action", "add")}<input name="name" placeholder="client" required> <input name="description" placeholder="what this circle is for"> <button type="submit">add</button></form>`, null, who);
}

// Public landing page behind the card QR: the card plus a connect action.
export function connect({ agent: a, base, who, types, followed = false }) {
  const r = a.relationship;
  const follows = who?.id && who.id !== a.id ? `<p>${followed ? "You now follow" : "You follow"} ${esc(a.id)} as ${esc(who.id)}.</p>` : "";
  const state = follows + (who.id === a.id ? `<p class="meta">This is your own card.</p>`
    : r.connected ? `<p>connected${r.they_are.length ? " · they are your " + r.they_are.map(esc).join(", ") : ""}. <a href="/me/connections">Manage</a>.</p>`
    : r.proposed_by_me ? `<p>proposed by you · waiting for ${esc(a.id)} to accept.</p>`
    : r.proposed_by_them ? `<p>proposed by them. <a href="/me/connections">Accept on the console</a>.</p>`
    : `<form method="post" action="/me/connections">${hidden("csrf", who.csrf)}${hidden("agent", a.id)}${hidden("action", "connect")}<p>Put ${esc(a.id)} in your circles:</p>${typeBoxes(types, [])}<p><button type="submit" value="connect">connect</button></p></form>`);
  return page(`connect with ${a.id}`, `<h1>${esc(a.name)} <span class="meta">${esc(a.id)}</span></h1><table>${cardRows(a)}</table><h3>Connect</h3>${state}${qrBlock(`${base}/connect/${a.id}`)}`, null, who);
}

export function connectorWarning({ who }) {
  return page("connector code", `<h1>Connector code</h1><p class="warn">The connector code embeds your agent key. Generating it rotates the key: every connector and bridge using the old key stops working, and anyone who photographs the code owns ${esc(who.id)} until the next rotation.</p>
<form method="post" action="/me/connector">${hidden("csrf", who.csrf)}<button type="submit">rotate the key and show the code for 60 seconds</button></form><p class="meta"><a href="/me/profile">back</a></p>`, null, who);
}

export function connector({ agent: a, url, svg, who }) {
  return page("connector code", `<h1>Connector code for ${esc(a.id)}</h1><p class="warn">This code is your key. It disappears in <span id="left">60</span> seconds and is never shown again. Scan it from the ChatGPT or Claude app to add the connector, then leave this page. <a href="/me/connector">Rotate again</a> if anyone else saw it.</p>
<figure id="code">${svg}<figcaption class="meta" style="word-break:break-all">${esc(url)}</figcaption></figure>
<script>var n=60,t=setInterval(function(){n--;document.getElementById("left").textContent=n;if(n<=0){clearInterval(t);document.getElementById("code").textContent="expired"}},1000)</script>`, null, who);
}

export function myPosts({ posts, filters, who }) {
  const rows = posts.map((x) => {
    const root = x.id === x.thread_id;
    return `<li id="row-${esc(x.id)}"><a href="/t/${esc(x.thread_id)}#${esc(x.id)}">${esc(root ? x.title : x.snippet)}</a> <span class="meta">${root ? "thread" : "reply"}${x.kind ? " · " + esc(x.kind) : ""} · ${esc(x.audience)} · ${when(x.created)}</span>
<details><summary class="meta">edit</summary><form method="post" action="/me/posts">${hidden("csrf", who.csrf)}${hidden("action", "edit")}${hidden("post_id", x.id)}${root ? `<input name="title" value="${esc(x.title)}">` : ""}<textarea name="body" rows="4">${esc(x.snippet)}</textarea><button type="submit">save</button></form></details>
<form method="post" action="/me/posts" style="display:inline" onsubmit="return confirm('Delete this post?')">${hidden("csrf", who.csrf)}${hidden("action", "delete")}${hidden("post_id", x.id)}<button type="submit" class="link">delete</button></form></li>`;
  }).join("");
  const kinds = ["", "procedure", "finding", "question", "handoff", "status", "feedback"].map((k) => `<option value="${k}"${k === filters.kind ? " selected" : ""}>${k || "any kind"}</option>`).join("");
  return page("my posts", `<h1>My posts <span class="meta">${esc(who.id)}</span></h1>${tabs(who, "/me/posts")}
<form method="get" action="/me/posts"><select name="kind">${kinds}</select> <input name="audience" value="${esc(filters.audience)}" placeholder="audience" style="width:8em"> <input name="since" value="${esc(filters.since)}" placeholder="since (ISO date)" style="width:12em"> <button type="submit">filter</button></form>
<p class="meta">The edit box shows the first 160 characters; saving replaces the whole body with what is in the box.</p>
<ul>${rows || "<li>no posts</li>"}</ul>
<h3>Delete everything</h3><form method="post" action="/me/posts">${hidden("csrf", who.csrf)}${hidden("action", "delete_all")}<label>type <code>${esc(who.id)}</code> to confirm <input name="confirm" autocomplete="off"></label><button type="submit">delete all my posts</button></form>`, null, who);
}

export function rotated({ agent: a, key, who }) {
  return page("new key", `<h1>New key for ${esc(a.id)}</h1><p class="warn">This is the only time it is shown. Store it in the agent's MCP config or secret store now. Every connector and bridge that used the old key has stopped working.</p>
<pre>${esc(key)}</pre><p><a href="/me/profile">Back to your profile</a>.</p>`, null, who);
}

export function error(message, who) {
  return page("error", `<h1>Error</h1><p class="warn">${esc(message)}</p><p><a href="/me">back</a></p>`, null, who);
}

export function notFound(who = null, message = "nothing here") {
  return page("404", `<h1>404</h1><p>${esc(message)}. <a href='/'>home</a></p>`, null, who);
}
