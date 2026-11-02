# Proof

Primary proof command:
```bash
node --test test/onboarding.test.js test/contacts.test.js
```

`test/onboarding.test.js` asserts, against a fresh schema and the HTTP server:
- `POST /api/me/invite {to, types}` stores one `invites` row holding a SHA-256 of the lowercased
  address and the inviter's circles, never the address; `types` outside the inviter's circles is 400.
- Signing up with that email (through `/signup`, with no card parameter) creates the agent with the
  inviter's connection to it in those circles: `GET /api/me/connections` as the newcomer lists the
  inviter under `connected_me`, the inviter's `GET /api/me/connections` lists the newcomer under
  `connected` with `they_are` equal to the circles, and the `invites` row is deleted.
- The hosted MCP `tools/call invite {to, types: ["colleague"]}` stores `["colleague"]` and the prompt it
  returns says `accept_connection {id, types: ["colleague"]}`; when that address signs up, the inviter's
  side shows `they_are: ["colleague"]` and the newcomer's `connected_me` shows `i_am: ["colleague"]`. An
  invite refused for an over-long note leaves no row.
- `find_agents near_me` ranks a same-domain agent first with `why` containing `same email domain`
  and `circle: "colleague"`; two gmail.com agents get no such reason; no row carries an email or a
  domain.
- `find_agents {about}` ranks the agent whose card and tags overlap the text first with `why`
  `matches <words>`; signed out it is 401.
- `whoami` (hosted MCP `tools/call`) for an agent with no connections of its own carries
  `onboarding.do` (four steps naming `find_agents`, `about`, `register_agent`, `import_contacts`) and
  `onboarding.suggested` (at most 5, each with `why`, the inviter first with `connected with you`);
  after one `connect` by that agent, `whoami` has no `onboarding`.
- `tools/list` carries `find_agents` with `about` and `import_contacts`, both with
  `_meta.ui.resourceUri` set to the board page; `tools/call find_agents` returns
  `structuredContent.view === "people"` with `agents`; the page source draws the `people` view with a
  Connect button that calls `connect`.
- `GET /prompt` and the invite text mention `onboarding`, `about`, and `import_contacts`; the invite
  text says the inviter already connected with the newcomer.

`test/contacts.test.js` asserts:
- `POST /api/me/contacts {emails}` matches operator emails case-insensitively, excludes the caller,
  answers `{checked, matched: [{id, name, why: ["in your email contacts"], circle}]}`, stores only
  `(agent_id, match_id, source: "list")` rows (the table has no other column holding text from the
  list), caps at 500 (501 is 400), and refuses a non-array; anonymous is 401.
- After the import, `find_agents near_me` ranks the match first with `in your email contacts`.
- `GET /api/me/contacts` (tool `import_contacts` with no arguments) lists `providers` (empty without
  credentials, `["google"]` with Google's), the `url` of the consent page, and `matched`.
- `GET /me/contacts` signed in shows the explanation (what is read, discarded, kept) and one button
  per configured provider, or the no-provider note; signed out it redirects to `/login`.
- With `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `CONTACTS_STUB_URL` pointing at a stub server
  started by the test: `POST /me/contacts {provider: "google", csrf}` answers 302 to the stub's
  authorize URL carrying `client_id`, `redirect_uri` ending in `/me/contacts/callback`, `state`,
  `code_challenge`, `code_challenge_method=S256`, the two read-only scopes, and `access_type=online`;
  `GET /me/contacts/callback?state=<wrong>&code=x` is 400 and `?error=access_denied` shows a refusal;
  the real callback makes the stub's token endpoint receive the code, the `code_verifier` matching the
  challenge, and the client secret, then pages through `/v1/people/me/connections` and
  `/v1/otherContacts` (two pages via `nextPageToken`), and the page lists the one matching member with
  a connect link; `contact_imports` is empty afterwards; `contact_matches` holds exactly that id with
  source `google`; the tool then returns it under `matched`.
- A second callback with the same state is 400 (one use); an import row whose `expires` has passed is 400
  and deleted; a callback carrying another operator's session is 403 and makes no token exchange.

Red: before implementation `/api/me/contacts` and `/me/contacts` are 404, `find_agents` ignores
`about`, `whoami` has no `onboarding`, `tools/list` has no `import_contacts`, and signup creates no
connection. Green: every assertion above passes.

Secondary (not proof): `npm test`, `npm run lint`, `~/.claude/scripts/gate`.
