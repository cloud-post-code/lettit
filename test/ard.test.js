import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Two fake ARD finders: one healthy, one that always fails. The healthy one returns a result the
// first test reviews (brave web-search) so the review overlay can be checked.
const upstream = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    if (req.url === "/bad") { res.writeHead(500); return res.end("boom"); }
    const { query } = JSON.parse(raw);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      results: [
        { identifier: "urn:air:github.com:brave:brave-search-skills:web-search", displayName: "Web Search", mediaType: "application/ai-skill", url: "https://github.com/brave/brave-search-skills/blob/main/skills/web-search/SKILL.md", description: `skill for ${query.text}`, score: 95 },
        { identifier: "urn:air:test:mcp:fetcher", displayName: "Fetcher", type: "application/mcp-server-card+json", url: "https://fetch.example/mcp", description: "fetch pages", score: 80 },
      ],
      referrals: [],
    }));
  });
});

let base, server;
before(async () => {
  await new Promise((r) => upstream.listen(0, r));
  const up = `http://localhost:${upstream.address().port}`;
  process.env.ARD_FINDERS = JSON.stringify([
    { id: "fake", name: "Fake Finder", identifier: "urn:air:fake:registry", search: `${up}/search` },
    { id: "broken", name: "Broken Finder", search: `${up}/bad` },
  ]);
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "agentboard-ard-"));
  ({ server } = await import("../src/server.js"));
  await new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); }));
});
after(() => { server.close(); upstream.close(); });

const get = (p) => fetch(base + p).then(async (r) => [r.status, await r.json()]);
const post = (p, b) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(async (r) => [r.status, await r.json()]);

test("federated search merges finders, tolerates a broken one, overlays reviews", async () => {
  const brave_id = "urn:air:github.com:brave:brave-search-skills:web-search";
  const [, rev] = await post("/api/ard/reviews", { identifier: brave_id, displayName: "Web Search", type: "application/ai-skill", url: "https://github.com/brave/brave-search-skills/blob/main/skills/web-search/SKILL.md", author: "dot", rating: 4, body: "Fast, good snippets. Needs a BRAVE_API_KEY." });
  await post("/api/ard/reviews", { parent_id: rev.id, author: "muse", body: "Returns no page body, so pair it with a fetch tool." });
  const [status, out] = await get("/api/ard/search?q=web%20search");
  assert.equal(status, 200);
  assert.deepEqual(out.finders.map((f) => [f.id, f.ok]), [["fake", true], ["broken", false]]);
  assert.match(out.finders[1].error, /HTTP 500/);
  const brave = out.results.find((r) => r.identifier.includes("brave"));
  assert.equal(brave.type, "application/ai-skill");
  assert.equal(brave.finder, "fake");
  assert.equal(brave.agentboard.reviews, 1);
  assert.equal(brave.agentboard.comments, 2);
  assert.equal(brave.agentboard.avg_rating, 4);
  assert.ok(brave.agentboard.thread_id);
  const fetcher = out.results.find((r) => r.identifier === "urn:air:test:mcp:fetcher");
  assert.equal(fetcher.agentboard.reviews, 0);
});

test("review a resource, reply in a sub-thread, aggregate rating", async () => {
  await post("/api/agents", { name: "Reviewer", model: "m", purpose: "p" });
  const [s1, rev] = await post("/api/ard/reviews", { identifier: "urn:air:test:mcp:fetcher", displayName: "Fetcher", type: "application/mcp-server-card+json", url: "https://fetch.example/mcp", author: "reviewer", rating: 2, body: "timed out on large pages" });
  assert.equal(s1, 201);
  assert.equal(rev.rating, 2);
  assert.equal(rev.depth, 1);
  assert.equal(rev.resource.reviews, 1);

  const [, reply] = await post("/api/ard/reviews", { parent_id: rev.id, author: "reviewer", body: "retry with smaller pages worked" });
  assert.equal(reply.depth, 2);
  const [, second] = await post("/api/ard/reviews", { identifier: "urn:air:test:mcp:fetcher", author: "reviewer", rating: 4, body: "better after update" });
  assert.equal(second.resource.avg_rating, 3);
  assert.equal(second.resource.reviews, 2);
  assert.equal(second.resource.comments, 3);

  const [, res] = await get("/api/ard/resources/" + encodeURIComponent("urn:air:test:mcp:fetcher"));
  assert.equal(res.thread.feed, "resources");
  assert.equal(res.thread.children.length, 2);
  assert.equal(res.thread.children[0].children[0].body, "retry with smaller pages worked");

  const [bad, err] = await post("/api/ard/reviews", { identifier: "urn:air:test:mcp:fetcher", author: "reviewer", rating: 9, body: "x" });
  assert.equal(bad, 400);
  assert.match(err.error, /rating/);
  const [noAuth] = await post("/api/ard/reviews", { identifier: "urn:air:test:x", author: "nobody", body: "x" });
  assert.equal(noAuth, 403);
});

test("serves a spec-compliant ARD discovery service", async () => {
  const [, wk] = await get("/.well-known/ard.json");
  assert.equal(wk.specVersion, "1.0");
  assert.equal(wk.entries[0].type, "application/ai-registry+json");
  assert.ok(wk.entries.some((e) => e.displayName === "Fake Finder"));

  const [, s] = await post("/search", { query: { text: "web search" }, pageSize: 5 });
  assert.ok(s.results.length >= 2);
  assert.equal(s.results[0].metadata.agentboard.finder, "fake");
  assert.ok(s.referrals.some((r) => r.url.endsWith("/search")));

  const [, local] = await post("/search", { query: { text: "" }, federation: "none" });
  assert.ok(local.results.every((r) => r.metadata.agentboard.reviews > 0));

  const [, ex] = await post("/explore", { resultType: { facets: [{ field: "type" }] } });
  assert.equal(ex.resultType, "facets");
  assert.ok(ex.facets.type.buckets.find((b) => b.value === "application/ai-skill"));

  const [, agents] = await get("/agents?pageSize=1");
  assert.equal(agents.results.length, 1);

  const html = await fetch(base + "/ard?q=web").then((r) => r.text());
  assert.match(html, /Indexes searched/);
  assert.match(html, /Fake Finder/);
});
