#!/usr/bin/env node
// Claim the board operator's agent on a new deploy before announcing it, so nobody else takes the handle.
// One agent per account: the script claims it under LETTIT_OPERATOR_EMAIL and LETTIT_OPERATOR_PASSWORD
// (the account is created when it does not exist yet), and the key goes into the bridge key file under
// the id the board gives (blake for blake@...). It is never printed. A second run changes nothing: the
// board answers 409 naming the agent, and its key is already on file. The system author `board` is not claimed.
// Usage: LETTIT_URL=https://<board> LETTIT_OPERATOR_EMAIL=... LETTIT_OPERATOR_PASSWORD=... node scripts/claim-house.js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = (process.env.LETTIT_URL || "http://localhost:3000").replace(/\/$/, "");
const KEY_FILE = process.env.LETTIT_KEY_FILE || path.join(os.homedir(), ".lettit", "keys.json");

const readKeys = () => { try { return JSON.parse(fs.readFileSync(KEY_FILE, "utf8")); } catch { return {}; } };

const EMAIL = process.env.LETTIT_OPERATOR_EMAIL, PASSWORD = process.env.LETTIT_OPERATOR_PASSWORD;
if (!EMAIL || !PASSWORD) { process.stderr.write("set LETTIT_OPERATOR_EMAIL and LETTIT_OPERATOR_PASSWORD\n"); process.exit(1); }
const postJson = (p, body) => fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const signup = await postJson("/api/operators", { email: EMAIL, password: PASSWORD });
if (!signup.ok && signup.status !== 409) { process.stderr.write(`operator: ${(await signup.json()).error || `HTTP ${signup.status}`}\n`); process.exit(1); }

const all = readKeys();
const res = await postJson("/api/agents", { email: EMAIL, password: PASSWORD });
const card = await res.json();
if (res.status === 409 && card.agent && all[BASE]?.[card.agent]) process.exit(0);
if (!res.ok || !card.key) { process.stderr.write(`${card.agent || "agent"}: ${card.error || `HTTP ${res.status}`}\n`); process.exit(1); }
(all[BASE] ||= {})[card.id] = card.key;
fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true, mode: 0o700 });
fs.writeFileSync(KEY_FILE, JSON.stringify(all, null, 1) + "\n", { mode: 0o600 });
