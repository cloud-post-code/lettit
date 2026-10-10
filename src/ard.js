// ARD (Agentic Resource Discovery) connection point.
// Fans one search out to several public ARD finders, normalizes the entries, and merges them.
// Spec: https://agenticresourcediscovery.org/spec/  (POST /search → {results, referrals, pageToken})

export const DEFAULT_FINDERS = [
  {
    id: "github",
    name: "GitHub Agent Finder",
    identifier: "urn:air:github.com:registry:agentfinder",
    description: "GitHub's curated public catalog of MCP servers, skills, and tools.",
    search: "https://agentfinder.github.com/api/v1/search",
    mcp: "https://agentfinder.github.com/api/v1/mcp",
    home: "https://github.com/agentfinder",
  },
  {
    id: "huggingface",
    name: "Hugging Face Discover",
    identifier: "urn:air:huggingface.co:registry:discover",
    description: "Hugging Face skills, Space skills, and MCP-enabled Spaces.",
    search: "https://huggingface-hf-discover.hf.space/search",
    mcp: "https://huggingface-hf-discover.hf.space/mcp",
    home: "https://github.com/huggingface/hf-discover",
  },
  {
    id: "ora",
    name: "Ora Directory",
    identifier: "urn:air:ora.ai:registry:public",
    description: "Ora's agent-readiness scored directory of products and MCP servers.",
    search: "https://ora.ai/api/ard/search",
    explore: "https://ora.ai/api/ard/explore",
    mcp: "https://ora.ai/api/mcp",
    home: "https://ora.directory",
  },
];

export const TIMEOUT_MS = Number(process.env.ARD_TIMEOUT_MS || 8000);

// ARD_FINDERS may hold a JSON array to replace the list (used by tests and by operators).
export function finders() {
  const raw = process.env.ARD_FINDERS;
  if (!raw) return DEFAULT_FINDERS;
  const list = JSON.parse(raw);
  if (!Array.isArray(list) || !list.length) throw new Error("ARD_FINDERS must be a non-empty JSON array");
  return list;
}

// Normalize one upstream result into a plain ARD entry plus which finder returned it.
export function normalize(r, finder) {
  if (!r || !r.identifier) return null;
  return {
    identifier: String(r.identifier),
    displayName: String(r.displayName || r.identifier),
    type: String(r.type || r.mediaType || ""),
    url: r.url || null,
    description: String(r.description || ""),
    tags: arr(r.tags),
    capabilities: arr(r.capabilities),
    representativeQueries: arr(r.representativeQueries),
    score: clamp(r.score),
    finder: finder.id,
    source: r.source || finder.search,
    trustManifest: r.trustManifest || undefined,
  };
}

async function queryFinder(finder, body) {
  const started = Date.now();
  const status = { id: finder.id, name: finder.name, ok: false, count: 0, ms: 0 };
  try {
    const res = await fetch(finder.search, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const results = (data.results || []).map((r) => normalize(r, finder)).filter(Boolean);
    status.ok = true;
    status.count = results.length;
    status.ms = Date.now() - started;
    return { status, results, referrals: arr(data.referrals) };
  } catch (e) {
    status.error = e.name === "TimeoutError" ? `timeout after ${TIMEOUT_MS}ms` : e.message;
    status.ms = Date.now() - started;
    return { status, results: [], referrals: [] };
  }
}

// Search every finder in parallel, merge by identifier (then url), highest score wins.
export async function federatedSearch({ text, type, pageSize = 10, only } = {}) {
  const q = String(text || "").trim();
  if (!q) throw Object.assign(new Error("text required"), { status: 400 });
  const size = Math.min(Math.max(Number(pageSize) || 10, 1), 100);
  const body = { query: { text: q }, pageSize: size, federation: "none" };
  if (type) body.query.filter = { type: arr(type) };
  const wanted = finders().filter((f) => !only || arr(only).includes(f.id));
  const outcomes = await Promise.all(wanted.map((f) => queryFinder(f, body)));
  const merged = new Map();
  const seenUrl = new Map();
  for (const { results } of outcomes) {
    for (const r of results) {
      const dupKey = merged.has(r.identifier) ? r.identifier : r.url && seenUrl.get(r.url);
      const prev = dupKey ? merged.get(dupKey) : null;
      if (prev) {
        prev.also_in = uniq([...(prev.also_in || []), r.finder]);
        if (r.score > prev.score) Object.assign(prev, r, { also_in: prev.also_in });
        continue;
      }
      merged.set(r.identifier, { ...r, also_in: [] });
      if (r.url) seenUrl.set(r.url, r.identifier);
    }
  }
  const results = [...merged.values()].sort((a, b) => b.score - a.score || a.displayName.localeCompare(b.displayName)).slice(0, size);
  return { query: q, results, finders: outcomes.map((o) => o.status), referrals: outcomes.flatMap((o) => o.referrals) };
}

// Referral entries for our own ARD responses: each upstream finder as a registry entry.
export const referrals = () =>
  finders().map((f) => ({ identifier: f.identifier || `urn:air:${f.id}:registry`, displayName: f.name, type: "application/ai-registry+json", url: f.search, description: f.description || "" }));

const arr = (v) => (Array.isArray(v) ? v.map(String) : v == null || v === "" ? [] : [String(v)]);
const uniq = (a) => [...new Set(a)];
const clamp = (n) => Math.min(100, Math.max(0, Math.round(Number(n) || 0)));
