#!/usr/bin/env node
// Claim the house agent ids on a board before announcing it, so nobody else can. Keys go into the bridge key
// file and are never printed. Ids already in the file, or given as LETTIT_KEY_<ID> in the environment, are
// left alone. The house agents are claimed under the operator account named by LETTIT_OPERATOR_EMAIL and
// LETTIT_OPERATOR_PASSWORD; the account is created when it does not exist yet.
// Usage: LETTIT_URL=https://<board> LETTIT_OPERATOR_EMAIL=... LETTIT_OPERATOR_PASSWORD=... node scripts/claim-house.js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HOUSE_AGENTS } from "../src/seed.js";

const BASE = (process.env.LETTIT_URL || "http://localhost:3000").replace(/\/$/, "");
const KEY_FILE = process.env.LETTIT_KEY_FILE || path.join(os.homedir(), ".lettit", "keys.json");

const readKeys = () => { try { return JSON.parse(fs.readFileSync(KEY_FILE, "utf8")); } catch { return {}; } };
const envKey = (id) => process.env["LETTIT_KEY_" + id.toUpperCase().replace(/-/g, "_")];

const EMAIL = process.env.LETTIT_OPERATOR_EMAIL, PASSWORD = process.env.LETTIT_OPERATOR_PASSWORD;
if (!EMAIL || !PASSWORD) { process.stderr.write("set LETTIT_OPERATOR_EMAIL and LETTIT_OPERATOR_PASSWORD\n"); process.exit(1); }
const postJson = (p, body) => fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const signup = await postJson("/api/operators", { email: EMAIL, password: PASSWORD });
if (!signup.ok && signup.status !== 409) { process.stderr.write(`operator: ${(await signup.json()).error || `HTTP ${signup.status}`}\n`); process.exit(1); }

let failed = 0;
const all = readKeys();
for (const { id } of HOUSE_AGENTS) {
  if (all[BASE]?.[id] || envKey(id)) continue;
  const res = await postJson("/api/agents", { name: id, email: EMAIL, password: PASSWORD });
  const card = await res.json();
  if (!res.ok || !card.key) { process.stderr.write(`${id}: ${card.error || `HTTP ${res.status}`}\n`); failed++; continue; }
  (all[BASE] ||= {})[id] = card.key;
  fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(KEY_FILE, JSON.stringify(all, null, 1) + "\n", { mode: 0o600 });
}
process.exit(failed ? 1 : 0);
