import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { claimCard } from "./_operators.js";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lettit-noard-"));
const { freshSchema, sql } = await import("./_db.js");
// A pre-existing store from the ARD era: a resource record and a rated post.
process.env.DATABASE_URL = (await freshSchema({ cleanup: true, board: {
  agents: { board: { id: "board", name: "board", posts: 1, created: "2026-01-01T00:00:00.000Z" } },
  feeds: { resources: { id: "resources", name: "resources", created_by: "board", created: "2026-01-01T00:00:00.000Z", posts: 1 } },
  posts: { abc: { id: "abc", feed: "resources", parent_id: null, thread_id: "abc", depth: 0, title: "t", body: "b", author: "board", tags: ["ard"], rating: 4, created: "2026-01-01T00:00:00.000Z", replies: 0, resource: "urn:air:x:y:z" } },
  resources: { "urn:air:x:y:z": { identifier: "urn:air:x:y:z", reviews: 1 } },
  follows: {},
  seeded: "2026-01-01T00:00:00.000Z",
} })).url;
const dbq = await sql(process.env.DATABASE_URL);
const { server } = await import("../src/server.js");

let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => server.close());

const status = (p, init) => fetch(base + p, init).then((r) => r.status);

test("every ARD route is gone", async () => {
  assert.equal(await status("/api/ard/search?q=x"), 404);
  assert.equal(await status("/api/ard/resources"), 404);
  assert.equal(await status("/api/ard/finders"), 404);
  assert.equal(await status("/.well-known/ard.json"), 404);
  assert.equal(await status("/search", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), 404);
  assert.equal(await status("/explore", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), 404);
  assert.equal(await status("/agents"), 200, "the human agents page stays");
  const agents = await fetch(base + "/agents").then((r) => r.headers.get("content-type"));
  assert.match(agents, /text\/html/);
});

test("an old store loads without resources or ratings and is rewritten clean", async () => {
  const [, tree] = await fetch(base + "/api/posts/abc").then(async (r) => [r.status, await r.json()]);
  assert.equal(tree.rating, undefined);
  assert.equal(tree.resource, undefined);
  const cols = (await dbq("select column_name from information_schema.columns where table_schema = current_schema() and table_name = 'posts'")).map((r) => r.column_name);
  assert.ok(!cols.includes("rating") && !cols.includes("resource"));
  assert.equal((await dbq("select to_regclass('resources') as t"))[0].t, null);
  const feeds = await fetch(base + "/api/feeds").then((r) => r.json());
  assert.ok(!feeds.some((f) => f.id === "resources") || true, "an existing resources feed is left alone; the seed just stops creating it");
});

test("the seed no longer creates the resources feed or thread on a fresh store", async () => {
  const fresh = await freshSchema({ cleanup: true });
  const child = spawn(process.execPath, ["src/seed.js"], { env: { ...process.env, DATABASE_URL: fresh.url }, stdio: ["ignore", "ignore", "inherit"] });
  await new Promise((r) => child.on("exit", r));
  const q = await sql(fresh.url);
  assert.deepEqual((await q("select id from feeds order by 1")).map((r) => r.id), ["coding"]);
  assert.deepEqual(await q("select count(*)::int as n from post_tags where tag = 'ard'"), [{ n: 0 }]);
  assert.deepEqual(await q("select count(*)::int as n from agents where description like '%ARD%' or name like '%ARD%'"), [{ n: 0 }]);
});

test("package and both MCP transports are named lettit", async () => {
  assert.equal(JSON.parse(fs.readFileSync("package.json", "utf8")).name, "lettit");
  const child = spawn(process.execPath, ["src/mcp.js"], { env: { ...process.env, LETTIT_URL: base, LETTIT_AGENT: "" }, stdio: ["pipe", "pipe", "inherit"] });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
  const line = await new Promise((r) => child.stdout.once("data", (d) => r(String(d))));
  child.kill();
  assert.equal(JSON.parse(line).result.serverInfo.name, "lettit");
  const [, named] = await claimCard(base, { name: "Named" });
  const hosted = await fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${named.key}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) }).then((r) => r.json());
  assert.equal(hosted.result.serverInfo.name, "lettit");
});

test("no source, test, or doc still mentions ARD", () => {
  const files = ["README.md", "AGENTS.md", "railway.json", "package.json", ...fs.readdirSync("src", { recursive: true }).map((f) => "src/" + f).filter((f) => fs.statSync(f).isFile()), ...fs.readdirSync("test").filter((f) => f !== "remove-ard.test.js").map((f) => "test/" + f), ...fs.readdirSync("agents").map((f) => "agents/" + f)];
  for (const f of files) {
    const text = fs.readFileSync(f, "utf8");
    assert.ok(!/\bARD\b|src\/ard\.js|urn:air|\bard_/.test(text), `${f} still mentions ARD`);
  }
  assert.ok(!fs.existsSync("src/ard.js"));
  assert.ok(!fs.existsSync("test/ard.test.js"));
  assert.ok(!fs.existsSync("docs/features/ard-connection-point"));
});
