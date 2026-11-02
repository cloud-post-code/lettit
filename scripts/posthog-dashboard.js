#!/usr/bin/env node
// Creates or updates the "LETTIT journey" dashboard in PostHog from the events src/analytics.js sends.
// Usage: POSTHOG_PERSONAL_API_KEY=phx_... POSTHOG_PROJECT_ID=12345 node scripts/posthog-dashboard.js [--dry-run]
// POSTHOG_API_HOST defaults to https://us.posthog.com (EU: https://eu.posthog.com). Runs again safely: insights
// and the dashboard are found by name and updated in place. No dependency.
const HOST = (process.env.POSTHOG_API_HOST || "https://us.posthog.com").replace(/\/$/, "");
const TOKEN = process.env.POSTHOG_PERSONAL_API_KEY || "";
const PROJECT = process.env.POSTHOG_PROJECT_ID || "";
const DRY = process.argv.includes("--dry-run");

export const DASHBOARD = { name: "LETTIT journey", description: "Landing page → MCP connected → first use → back after a week → 50 uses a week, for humans and agents, plus every question and its answer." };
const STEPS = [["landing_viewed", "Sees landing page"], ["mcp_connected", "Connected to MCP"], ["tool_called", "First read or write"], ["retained_week_one", "Back after one week"], ["power_week", "50 uses in a week"]];
const steps = () => STEPS.map(([event, custom_name]) => ({ kind: "EventsNode", event, name: event, custom_name }));
const viz = (source) => ({ kind: "InsightVizNode", source });
const funnel = (breakdown, date_from = "-90d") => viz({
  kind: "FunnelsQuery", dateRange: { date_from }, series: steps(),
  funnelsFilter: { funnelVizType: "steps", funnelOrderType: "ordered", funnelWindowInterval: 30, funnelWindowIntervalUnit: "day", breakdownAttributionType: "first_touch" },
  ...(breakdown ? { breakdownFilter: { breakdown, breakdown_type: "event" } } : {}),
});
const trend = (event, { math = "total", breakdown, display = "ActionsLineGraph", interval = "day", date_from = "-30d", property } = {}) => viz({
  kind: "TrendsQuery", dateRange: { date_from }, interval, series: [{ kind: "EventsNode", event, name: event, math, ...(property ? { math_property: property } : {}) }],
  trendsFilter: { display }, ...(breakdown ? { breakdownFilter: { breakdown, breakdown_type: "event" } } : {}),
});

// Each tile: an insight (name, description, query) and its place on the 12-column grid.
export const TILES = [
  { text: `**How to read this.** One row per person: a person is an agent (one per account), and a browser visitor before sign-in. Steps: *Sees landing page* (\`landing_viewed\`, \`visitor\` = human or agent) → *Connected to MCP* (\`mcp_connected\`: hosted \`/mcp\` initialize or the stdio bridge) → *First read or write* (\`tool_called\`) → *Back after one week* (\`retained_week_one\`: a call 7+ days after the first) → *50 uses in a week* (\`power_week\`). Every \`tool_called\` carries \`query\`, \`input\`, and \`answer\`.`, layout: { x: 0, y: 0, w: 12, h: 2 } },
  { name: "Journey funnel: humans vs agents", description: "The five steps, broken down by who saw the landing page first (visitor = human or agent). 30-day conversion window.", query: funnel("visitor"), layout: { x: 0, y: 2, w: 8, h: 6 } },
  { name: "Journey funnel: by client", description: "The same five steps by the client that started the journey (Chrome, Claude, ChatGPT, curl, ...).", query: funnel("client"), layout: { x: 8, y: 2, w: 4, h: 6 } },
  { name: "Landing page visitors", description: "Unique visitors per day who saw the landing page, humans and agents apart.", query: trend("landing_viewed", { math: "dau", breakdown: "visitor" }), layout: { x: 0, y: 8, w: 6, h: 4 } },
  { name: "MCP connections", description: "Agents connecting per day, by transport (hosted /mcp or the stdio bridge).", query: trend("mcp_connected", { math: "dau", breakdown: "transport" }), layout: { x: 6, y: 8, w: 6, h: 4 } },
  { name: "Daily active agents", description: "Agents that called at least one tool that day.", query: trend("tool_called", { math: "dau" }), layout: { x: 0, y: 12, w: 4, h: 4 } },
  { name: "Tool calls by tool", description: "Which tools are used, last 30 days.", query: trend("tool_called", { breakdown: "tool", display: "ActionsBarValue" }), layout: { x: 4, y: 12, w: 4, h: 4 } },
  { name: "Milestones per week", description: "Agents reaching week one and 50 uses a week.", query: viz({ kind: "TrendsQuery", dateRange: { date_from: "-12w" }, interval: "week", series: [{ kind: "EventsNode", event: "retained_week_one", name: "retained_week_one", math: "dau", custom_name: "Back after one week" }, { kind: "EventsNode", event: "power_week", name: "power_week", math: "dau", custom_name: "50 uses in a week" }], trendsFilter: { display: "ActionsBar" } }), layout: { x: 8, y: 12, w: 4, h: 4 } },
  { name: "Weekly retention after connecting", description: "Of the agents that connected in a week, how many called a tool in each following week.", query: viz({ kind: "RetentionQuery", dateRange: { date_from: "-8w" }, retentionFilter: { targetEntity: { id: "mcp_connected", name: "mcp_connected", type: "events" }, returningEntity: { id: "tool_called", name: "tool_called", type: "events" }, retentionType: "retention_first_time", period: "Week", totalIntervals: 8 } }), layout: { x: 0, y: 16, w: 12, h: 5 } },
  { name: "Questions and answers", description: "Every search, read_threads, and find_agents call with the question asked and the answer given, newest first, with the agent that asked.", query: { kind: "DataTableNode", full: true, source: { kind: "EventsQuery", select: ["timestamp", "person", "properties.tool", "properties.query", "properties.answer", "properties.transport", "properties.client"], event: "tool_called", where: ["properties.query is not null"], orderBy: ["timestamp DESC"], limit: 100 } }, layout: { x: 0, y: 21, w: 12, h: 8 } },
];

const api = async (method, path, body) => {
  const r = await fetch(`${HOST}/api/projects/${PROJECT}${path}`, { method, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path}: HTTP ${r.status} ${JSON.stringify(data).slice(0, 300)}`);
  return data;
};
const byName = (rows, name) => (rows.results || rows).find((x) => x.name === name);

async function main() {
  if (DRY) { console.log(JSON.stringify({ dashboard: DASHBOARD, tiles: TILES }, null, 1)); return; }
  if (!TOKEN || !PROJECT) throw new Error("set POSTHOG_PERSONAL_API_KEY (a personal API key with insight and dashboard write scopes) and POSTHOG_PROJECT_ID");
  let dash = byName(await api("GET", `/dashboards/?search=${encodeURIComponent(DASHBOARD.name)}&limit=50`), DASHBOARD.name);
  dash = dash ? await api("PATCH", `/dashboards/${dash.id}/`, { description: DASHBOARD.description }) : await api("POST", "/dashboards/", DASHBOARD);
  console.log(`dashboard ${dash.id}: ${HOST}/project/${PROJECT}/dashboard/${dash.id}`);
  const placed = [];
  for (const t of TILES) {
    if (t.text) {
      const existing = (dash.tiles || []).find((x) => x.text);
      if (!existing) { dash = await api("PATCH", `/dashboards/${dash.id}/`, { tiles: [{ text: { body: t.text }, layouts: { sm: t.layout } }] }); }
      continue;
    }
    const found = byName(await api("GET", `/insights/?search=${encodeURIComponent(t.name)}&limit=50`), t.name);
    const body = { name: t.name, description: t.description, query: t.query, saved: true };
    const ins = found
      ? await api("PATCH", `/insights/${found.id}/`, { ...body, dashboards: [...new Set([...(found.dashboards || []), dash.id])] })
      : await api("POST", "/insights/", { ...body, dashboards: [dash.id] });
    console.log(`${found ? "updated" : "created"} insight ${ins.short_id}: ${t.name}`);
    placed.push({ insight: ins.id, layout: t.layout });
  }
  // Lay the tiles out on the 12-column grid.
  dash = await api("GET", `/dashboards/${dash.id}/`);
  const tiles = (dash.tiles || []).map((tile) => {
    const p = tile.insight ? placed.find((x) => x.insight === tile.insight.id) : { layout: TILES[0].layout };
    return p ? { id: tile.id, layouts: { sm: p.layout } } : null;
  }).filter(Boolean);
  await api("PATCH", `/dashboards/${dash.id}/`, { tiles });
  console.log(`laid out ${tiles.length} tiles`);
}

if (process.argv[1] && process.argv[1].endsWith("posthog-dashboard.js")) main().catch((e) => { console.error(e.message); process.exit(1); });
