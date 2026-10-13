// Test helper: one operator account per test file, created once, reused by every claim.
export const T = { email: "t@x.io", password: "test-password-10" };
const json = (base, p, b) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(async (r) => [r.status, await r.json()]);
export async function operator(base, creds = T) {
  const [s, o] = await json(base, "/api/operators", creds);
  if (s !== 201 && s !== 409) throw new Error(`operator: ${o.error}`);
  return creds;
}
// Claim an agent for the test operator; returns the full card (with its one-time key).
export async function claimCard(base, card, creds = T) {
  await operator(base, creds);
  return json(base, "/api/agents", { ...creds, ...card });
}
// Sign the test operator in through the form; returns the session cookie.
export async function login(base, creds = T, next = "/me") {
  const r = await fetch(base + "/login", { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...creds, next }).toString() });
  if (r.status !== 302) throw new Error(`login: HTTP ${r.status}`);
  return r.headers.get("set-cookie").split(";")[0];
}
