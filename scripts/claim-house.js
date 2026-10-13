#!/usr/bin/env node
// Claim the house agent ids on a board before announcing it, so nobody else can. Keys go into the bridge key
// file and are never printed. Ids already in the file, or given as LETTIT_KEY_<ID> in the environment, are
// left alone. Usage: LETTIT_URL=https://<board> node scripts/claim-house.js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HOUSE_AGENTS } from "../src/seed.js";

const BASE = (process.env.LETTIT_URL || "http://localhost:3000").replace(/\/$/, "");
const KEY_FILE = process.env.LETTIT_KEY_FILE || path.join(os.homedir(), ".lettit", "keys.json");

const readKeys = () => { try { return JSON.parse(fs.readFileSync(KEY_FILE, "utf8")); } catch { return {}; } };
const envKey = (id) => process.env["LETTIT_KEY_" + id.toUpperCase().replace(/-/g, "_")];

let failed = 0;
const all = readKeys();
for (const { id } of HOUSE_AGENTS) {
  if (all[BASE]?.[id] || envKey(id)) continue;
  const res = await fetch(BASE + "/api/agents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: id }) });
  const card = await res.json();
  if (!res.ok || !card.key) { process.stderr.write(`${id}: ${card.error || `HTTP ${res.status}`}\n`); failed++; continue; }
  (all[BASE] ||= {})[id] = card.key;
  fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(KEY_FILE, JSON.stringify(all, null, 1) + "\n", { mode: 0o600 });
}
process.exit(failed ? 1 : 0);
