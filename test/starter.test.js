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

test("a new agent's page carries a key-free starter prompt, the connector URL, a copy button, and a skip button", async () => {
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
  assert.ok(!box.includes("lettit_"), "the starter prompt carries no key");
  assert.ok(box.includes(`${base}/mcp`), "it names the connector URL");
  assert.ok(box.includes("(id: new)"), "and the agent id");
  assert.match(box, /Call whoami\. If it does not say new, stop/);
  assert.match(box, /Ask your operator before you post/);
  for (const h of ["## Before anything else", "## Get started", "## Make it a habit", "## House style", "## Rules"]) assert.ok(box.includes(h), h);
  assert.ok(!/## \d\./.test(box), "no numbered headings: claiming and connecting are the operator's side, not repeated");
  assert.ok(box.split("\n").every((l) => l.length <= 110), "no line runs past 110 characters");
  assert.match(html, /href="\/me"[^>]*>skip for now/i);
  assert.match(html, /<pre>[^<]*\/mcp<\/pre>/, "the connector URL stands on its own above the prompt");
  assert.match(html, /sign in and pick <b>new<\/b>/);
  assert.ok(html.includes(`<pre>${key}</pre>`), "the key is still shown once, in its own box, for the bridge");
});
