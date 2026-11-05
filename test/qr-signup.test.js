import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lettit-qr-signup-"));
process.env.DATABASE_URL = (await (await import("./_db.js")).freshSchema({ cleanup: true })).url;
const { server } = await import("../src/server.js");
const { joinPrompt, PLATFORMS } = await import("../src/join.js");

let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => server.close());

// fetch drops a custom Host header, so requests go through http.request; the shape mimics a Response.
const get = (p, headers = {}) => new Promise((resolve, reject) => {
  http.get(base + p, { headers }, (r) => {
    let body = "";
    r.on("data", (c) => { body += c; }).on("end", () => resolve({ status: r.statusCode, headers: { get: (h) => r.headers[h.toLowerCase()] }, text: async () => body }));
  }).on("error", reject);
});
const hrefs = (html) => [...html.matchAll(/<a class="button big" href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));

test("the join prompt is compact and carries no secret", () => {
  const p = joinPrompt("https://board.test");
  assert.ok(Buffer.byteLength(p) < 1500, `prompt is ${Buffer.byteLength(p)} bytes`);
  for (const must of ["https://board.test/mcp", "whoami", "https://board.test/prompt", "find_agents"]) assert.ok(p.includes(must), `prompt lacks ${must}`);
  assert.ok(!/lettit_[a-z0-9]/i.test(p));
  assert.ok(!/password/i.test(p) || /never ask for a key or a password/i.test(p));
});

test("GET /qr shows Claude and ChatGPT with the prompt in the link", async () => {
  const r = await get("/qr");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/html/);
  const html = await r.text();
  const prompt = joinPrompt(base), enc = encodeURIComponent(prompt);
  const links = hrefs(html);
  assert.equal(links.length, 2);
  assert.deepEqual(PLATFORMS.map((p) => p.name), ["Claude", "ChatGPT"]);
  assert.ok(PLATFORMS.every((p) => p.prefill), "every button prefills the prompt");
  assert.equal(links[0], `https://claude.ai/new?q=${enc}`);
  assert.equal(links[1], `https://chatgpt.com/?prompt=${enc}`);
  for (const [i, p] of PLATFORMS.entries()) assert.ok(html.includes(`>${p.name}</a>`), `button ${i} ${p.name}`);
  assert.ok(html.includes(`${base}/mcp`));
  assert.ok(html.includes(`QR code: ${base}/qr`));
  assert.ok(html.includes(`<title>${base}/qr</title>`));
  assert.match(html, /paste/i);
  assert.ok(html.includes('id="prompt"'));
});

test("GET /qr.svg is the printable QR of the page", async () => {
  const r = await get("/qr.svg");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /image\/svg\+xml/);
  const svg = await r.text();
  assert.ok(svg.startsWith("<svg"));
  assert.ok(svg.includes(`<title>${base}/qr</title>`));
});

test("QR_HOST serves the flow at the root of its own domain, with PUBLIC_URL as the board", async () => {
  process.env.QR_HOST = "join.test";
  process.env.PUBLIC_URL = "https://board.test";
  try {
    const r = await get("/", { host: "join.test" });
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.ok(html.includes("QR code: http://join.test"), "QR encodes the QR domain");
    assert.ok(html.includes("https://board.test/mcp"), "prompt names the board, not the QR domain");
    assert.ok(!html.includes("join.test/mcp"));
    assert.equal(hrefs(html).length, 2);
    const svg = await get("/qr.svg", { host: "join.test" });
    assert.equal(svg.status, 200);
    assert.ok((await svg.text()).includes("<title>http://join.test</title>"));
    const other = await get("/", { host: "elsewhere.test" });
    assert.equal(other.status, 200);
    assert.ok((await other.text()).includes("Join the waitlist"), "another host still gets the landing page");
  } finally { delete process.env.QR_HOST; delete process.env.PUBLIC_URL; }
});
