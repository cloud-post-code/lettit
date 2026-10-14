import { test, before, after } from "node:test";
import { operator, credsOf } from "./_operators.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lettit-find-"));
const { server } = await import("../src/server.js");

let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => server.close());

const auth = (key) => (key ? { authorization: `Bearer ${key}` } : {});
const get = (p, key) => fetch(base + p, { headers: auth(key) }).then(async (r) => [r.status, await r.json()]);
const api = (p, b, key) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...auth(key) }, body: JSON.stringify(b) }).then(async (r) => [r.status, await r.json()]);
const claim = async (name, description = "") => (await api("/api/agents", { name, ...(await operator(base, credsOf(name))), description }))[1].key;

test("find_agents filters by text and ranks near_me by shared connections and tags", async () => {
  const me = await claim("Me", "builds railway deploys");
  const close = await claim("Close", "also railway");
  const far = await claim("Far", "gardening");
  const hub = await claim("Hub", "connects people");
  const [, byQ] = await get("/api/agents?q=railway");
  assert.deepEqual(byQ.map((a) => a.id).sort(), ["t-close", "t-me"]);
  assert.ok("authority" in byQ[0]);
  assert.equal((await get("/api/agents?near=1"))[0], 401);

  await api("/api/agents/t-hub/connect", {}, me); await api("/api/agents/t-me/accept", {}, hub);
  await api("/api/agents/t-hub/connect", {}, close); await api("/api/agents/t-close/accept", {}, hub);
  await api("/api/posts", { kind: "finding", body: "volumes", tags: ["Railway", "volumes"] }, me);
  await api("/api/posts", { kind: "finding", body: "mounts", tags: ["railway"] }, close);
  await api("/api/posts", { kind: "finding", body: "secret", tags: ["volumes"], audience: "friend" }, far);
  const [s, near] = await get("/api/agents?near=1", me);
  assert.equal(s, 200, near.error);
  assert.ok(!near.some((a) => a.id === "t-me"), "the caller is excluded");
  assert.equal(near[0].id, "t-close");
  assert.equal(near[0].shared_connections, 1);
  assert.equal(near[0].shared_tags, 1);
  const farRow = near.find((a) => a.id === "t-far");
  assert.equal(farRow.shared_tags, 0, "a tag on a post the caller cannot read does not count");
  const [, limited] = await get("/api/agents?near=1&limit=1", me);
  assert.equal(limited.length, 1);

  const rpc = (method, params) => fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json", ...auth(me) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((r) => r.json());
  const { result } = await rpc("tools/call", { name: "find_agents", arguments: { near_me: true } });
  assert.equal(result.isError, undefined, result.content[0].text);
  assert.equal(JSON.parse(result.content[0].text)[0].id, "t-close");
  const list = await rpc("tools/list", {});
  assert.ok(list.result.tools.find((t) => t.name === "find_agents").inputSchema.properties.near_me);
  const [, all] = await get("/api/agents");
  assert.ok(all.length >= 4);
  assert.ok(far);
});
