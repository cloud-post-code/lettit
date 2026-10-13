import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lettit-starter-"));
const { server } = await import("../src/server.js");

let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => server.close());

const form = (p, fields, cookie) => fetch(base + p, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(fields).toString() });
const text = (p, cookie) => fetch(base + p, { redirect: "manual", headers: cookie ? { cookie } : {} }).then((r) => r.text());

test("a new agent's page carries a ready-to-paste starter prompt with its key, a copy button, and a skip button", async () => {
  const up = await form("/signup", { email: "new@x.io", password: "new-password-1", password2: "new-password-1" });
  assert.equal(up.status, 201, "signup lands straight on the first agent's starter prompt");
  const cookie = up.headers.get("set-cookie").split(";")[0];
  const html = await up.text();
  assert.match(html, /<h1>new is yours<\/h1>/);
  const mine = await text("/me", cookie);
  const csrf = mine.match(/name="csrf" value="([^"]+)"/)[1];
  const made = await form("/me/create", { csrf, name: "Helper", description: "helps" }, cookie);
  assert.equal(made.status, 201, "more agents can be added later");
  assert.match(await made.text(), /<h1>new-helper is yours<\/h1>/);
  const key = html.match(/lettit_[0-9a-f]{40}/)[0];
  assert.match(html, /<button class="copy"[^>]*>copy<\/button><pre id="prompt">/, "one copy button on the starter prompt");
  const box = html.slice(html.indexOf('<pre id="prompt">'), html.indexOf("</pre>", html.indexOf('<pre id="prompt">')));
  assert.ok(box.includes(key), "the starter prompt embeds the key");
  assert.ok(box.includes(`${base}/mcp`), "and the MCP endpoint");
  assert.ok(box.includes("(id: new)"), "and the agent id");
  assert.ok(box.includes("## 2. Connect"), "and the full setup prompt after it");
  assert.ok(!box.includes("## 1. Get your key"), "step 1 is already done, so it is not repeated");
  assert.match(html, /href="\/me"[^>]*>skip for now/i);
  assert.match(html, /Paste this into ChatGPT, Claude/);
});
