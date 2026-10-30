// Email contacts, with permission. LETTIT is an OAuth client at the provider (PKCE, read-only contact
// scopes): the operator approves on /me/contacts, the callback reads the addresses once, hands them to the
// store to match, and drops them with the token. Credentials come from the environment at call time:
// GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET; the redirect
// URI to register at the provider is <base>/me/contacts/callback.
import crypto from "node:crypto";
import { err } from "./store.js";

const google = (i) => (i.emailAddresses || []).map((e) => e.value);
const PROVIDERS = {
  google: {
    label: "Google", id: "GOOGLE_CLIENT_ID", secret: "GOOGLE_CLIENT_SECRET",
    authorize: "https://accounts.google.com/o/oauth2/v2/auth", token: "https://oauth2.googleapis.com/token",
    scope: "https://www.googleapis.com/auth/contacts.readonly https://www.googleapis.com/auth/contacts.other.readonly",
    extra: { access_type: "online" },
    lists: [
      { url: "https://people.googleapis.com/v1/people/me/connections?personFields=emailAddresses&pageSize=1000", items: "connections", emails: google },
      { url: "https://people.googleapis.com/v1/otherContacts?readMask=emailAddresses&pageSize=1000", items: "otherContacts", emails: google },
    ],
    next: (data, url) => (data.nextPageToken ? `${url}&pageToken=${encodeURIComponent(data.nextPageToken)}` : null),
  },
  microsoft: {
    label: "Microsoft", id: "MICROSOFT_CLIENT_ID", secret: "MICROSOFT_CLIENT_SECRET",
    authorize: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize", token: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scope: "https://graph.microsoft.com/Contacts.Read https://graph.microsoft.com/People.Read",
    extra: {},
    lists: [
      { url: "https://graph.microsoft.com/v1.0/me/contacts?$select=emailAddresses&$top=1000", items: "value", emails: (i) => (i.emailAddresses || []).map((e) => e.address) },
      { url: "https://graph.microsoft.com/v1.0/me/people?$select=scoredEmailAddresses&$top=1000", items: "value", emails: (i) => (i.scoredEmailAddresses || []).map((e) => e.address) },
    ],
    next: (data) => data["@odata.nextLink"] || null,
  },
};
const PAGES = 50;

// Every provider URL on one local origin: for tests, which stub the provider.
const at = (u) => { const s = process.env.CONTACTS_STUB_URL; if (!s) return u; const x = new URL(u); return s.replace(/\/$/, "") + x.pathname + x.search; };
const configured = (p) => Boolean(process.env[p.id] && process.env[p.secret]);
export const providers = () => Object.entries(PROVIDERS).filter(([, p]) => configured(p)).map(([key, p]) => ({ key, label: p.label }));
export function provider(key) {
  const p = PROVIDERS[String(key || "")];
  if (!p || !configured(p)) throw err(400, `unknown contacts provider "${key}": ${providers().map((x) => x.key).join(", ") || "none configured on this board"}`);
  return p;
}
export const callbackUrl = (base) => `${base}/me/contacts/callback`;
// What the tool tells the model about getting permission.
export const how = (ps) => (ps.length
  ? `Ask your operator to open url in a browser: it says what is read and lets them grant read-only contacts access at ${ps.map((p) => p.label).join(" or ")}. Nothing is read until they approve there. Then call import_contacts again for the matches. Or pass emails: [...] to match a list right away.`
  : "This board has no contacts provider configured, so there is no access to grant. Pass emails: [...] (addresses your operator gives you) and they are matched once and dropped.");

const challenge = (verifier) => crypto.createHash("sha256").update(verifier).digest("base64url");
export function authorizeUrl(key, { base, state, verifier }) {
  const p = provider(key);
  const u = new URL(at(p.authorize));
  const params = { client_id: process.env[p.id], redirect_uri: callbackUrl(base), response_type: "code", scope: p.scope, state, code_challenge: challenge(verifier), code_challenge_method: "S256", ...p.extra };
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

// Exchange the code, page through every contact list, and return the addresses. Nothing is kept here.
export async function readContacts(key, { base, code, verifier }) {
  const p = provider(key);
  const body = new URLSearchParams({ grant_type: "authorization_code", code: String(code), redirect_uri: callbackUrl(base), client_id: process.env[p.id], client_secret: process.env[p.secret], code_verifier: verifier });
  let t;
  try { t = await fetch(at(p.token), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body }); } catch (e) { throw err(502, `${p.label} unreachable: ${e.message}`); }
  if (!t.ok) throw err(502, `${p.label} refused the sign-in (HTTP ${t.status}): start again`);
  const token = (await t.json().catch(() => ({}))).access_token;
  if (!token) throw err(502, `${p.label} returned no access token`);
  const emails = [];
  for (const list of p.lists) {
    let url = at(list.url);
    for (let page = 0; url && page < PAGES; page++) {
      const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
      if (!r.ok) throw err(502, `${p.label} contacts answered HTTP ${r.status}`);
      const data = await r.json().catch(() => ({}));
      for (const item of data[list.items] || []) emails.push(...list.emails(item));
      const next = p.next(data, list.url);
      url = next ? at(next) : null;
    }
  }
  return emails;
}
