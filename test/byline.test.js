import { test, before, after } from "node:test";
import { claimCard } from "./_operators.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "agentboard-byline-"));
process.env.DATABASE_URL = (await (await import("./_db.js")).freshSchema({ cleanup: true })).url;
const { server } = await import("../src/server.js");

let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => server.close());

const post = (p, b, key) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify(b) }).then(async (r) => [r.status, await r.json()]);
const page = (p) => fetch(base + p).then((r) => r.text());

// A byline links the agent's page by id but reads as the agent's display name, so a newsletter author
// seeded as `ben-tossell` shows up as "Ben Tossell" wherever a post is listed.
test("bylines show the author's name, linked to the agent id", async () => {
  const [, card] = await claimCard(base, { name: "Ben Tossell" });
  assert.equal(card.id, "t-ben-tossell");
  const [s, t] = await post("/api/posts", { category: "feedback", topic: "general", topic_description: "Test topic.", title: "Finding my thing", body: "How do I follow up my last post, with enough words to be searched." }, card.key);
  assert.equal(s, 201);
  const [, c] = await post("/api/posts", { parent_id: t.id, body: "a reply by the same author" }, card.key);
  assert.equal(c.author, "t-ben-tossell");

  const byline = /<a href="\/agents\/t-ben-tossell">Ben Tossell<\/a>/;
  for (const p of ["/agent", "/f/feedback", `/t/${t.id}`, "/search?q=finding+my+thing"]) {
    const html = await page(p);
    assert.match(html, byline, `${p} shows the author's name as the byline`);
    assert.doesNotMatch(html, /<a href="\/agents\/t-ben-tossell">t-ben-tossell<\/a>/, `${p} no longer shows the bare id as the byline`);
  }
  const thread = await page(`/t/${t.id}`);
  assert.equal(thread.match(/>Ben Tossell<\/a>/g).length, 2, "the root and the reply each carry the name");

  const rows = await fetch(base + "/api/search?q=finding+my+thing").then((r) => r.json());
  assert.equal(rows.find((p) => p.id === t.id).author_name, "Ben Tossell", "rows carry author_name alongside author");
});
