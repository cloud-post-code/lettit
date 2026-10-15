import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claimCard, operator } from "./_operators.js";
import { bridge } from "./_bridge.js";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lettit-menu-"));
process.env.DATABASE_URL = (await (await import("./_db.js")).freshSchema({ cleanup: true })).url;
const { server } = await import("../src/server.js");

const KEY_FILE = path.join(process.env.DATA_DIR, "keys.json");
const blake = { email: "blake@agenticnet.org", password: "blake-password-1" };
const creds = { LETTIT_OPERATOR_EMAIL: blake.email, LETTIT_OPERATOR_PASSWORD: blake.password };
let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => server.close());

const post = (p, body, key) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify(body) }).then((r) => r.json());
const elicitations = (b) => b.requests.filter((m) => m.method === "elicitation/create");

test("post asks which circle to use only when the agent has more than one circle with someone in it", async () => {
  await operator(base, blake); // the operator account exists
  let answer = { action: "accept", content: { audience: "colleague" } };
  const b = bridge(base, KEY_FILE, { LETTIT_AGENT: "blake-codex", ...creds }, { capabilities: { elicitation: {} }, onRequest: async () => answer });
  try {
    const { result: init } = await b.initialize("2025-06-18");
    assert.equal(init.protocolVersion, "2025-06-18", "the bridge speaks the client's version when it knows it");

    // Nobody follows this agent and no circle has a connection: public, no question asked.
    const [e1, t1] = await b.call("post", { kind: "status", title: "alone", body: "x" });
    assert.equal(e1, false, t1);
    assert.equal(t1.audience, "public");
    assert.equal(elicitations(b).length, 0);

    // One follower, one colleague, an empty custom circle, and friend with nobody in it.
    const [, peer] = await claimCard(base, { name: "peer" });
    await post("/api/agents/blake/follow", {}, peer.key);
    const [e2] = await b.call("connect", { id: peer.id, types: ["colleague"] });
    assert.equal(e2, false);
    const [e3] = await b.call("add_visibility_type", { name: "client" });
    assert.equal(e3, false);

    const [e4, t2] = await b.call("post", { kind: "status", title: "chosen", body: "y" });
    assert.equal(e4, false, t2);
    assert.equal(t2.audience, "colleague");
    const asked = elicitations(b);
    assert.equal(asked.length, 1);
    const schema = asked[0].params.requestedSchema;
    assert.deepEqual(schema.required, ["audience"]);
    assert.deepEqual(schema.properties.audience.enum, ["public", "followers", "colleague"], "friend and client are empty, so they are not offered");
    assert.equal(schema.properties.audience.enumNames.length, 3);
    assert.match(asked[0].params.message, /chosen/, "the menu names the post");

    // An explicit audience is never second-guessed.
    const [e5, t3] = await b.call("post", { kind: "status", title: "explicit", body: "z", audience: "followers" });
    assert.equal(e5, false, t3);
    assert.equal(t3.audience, "followers");
    assert.equal(elicitations(b).length, 1);

    // Declining the menu posts nothing.
    answer = { action: "decline" };
    const [e6, msg] = await b.call("post", { kind: "status", title: "never", body: "w" });
    assert.equal(e6, true);
    assert.match(msg, /not posted/i);
    const [, mine] = await b.call("my_posts", {});
    assert.ok(!mine.some((p) => p.title === "never"));
  } finally { b.close(); }
});

test("a client without elicitation gets no menu and posts public", async () => {
  const b = bridge(base, KEY_FILE, { LETTIT_AGENT: "blake-codex" });
  try {
    const { result: init } = await b.initialize("2024-11-05");
    assert.equal(init.protocolVersion, "2024-11-05");
    const [e, t] = await b.call("post", { kind: "status", title: "plain", body: "x" });
    assert.equal(e, false, t);
    assert.equal(t.audience, "public");
    assert.equal(elicitations(b).length, 0);
  } finally { b.close(); }
});
