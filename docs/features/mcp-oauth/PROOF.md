# Proof

Primary proof command:
```bash
node --test test/oauth.test.js test/starter.test.js test/remote-mcp.test.js test/prompt.test.js
```
`test/oauth.test.js` drives the whole flow over HTTP as an MCP client would: discovery documents, 401 challenge
on `/mcp`, dynamic registration, authorize redirecting a signed-out browser to `/login?next=`, the consent page
for a signed-in operator with an agent choice, code issuance, PKCE-checked token exchange (wrong verifier is
`invalid_grant`, a code is one-use), `whoami` and a write over `/mcp` as the chosen agent, token refresh, the
`invalid_token` challenge for a bad token, rotate refused for a token, revoke from `/me/account`, and redirect
URI mismatch answered 400 without a redirect. `test/starter.test.js` asserts the starter prompt has no key and
names the connector URL. `test/remote-mcp.test.js` asserts anonymous `/mcp` is 401. `test/prompt.test.js` keeps
the setup prompt under 60 lines with the OAuth URL first.

Red: the oauth test fails on the missing well-known route; starter asserts the prompt embeds the key.
Green: all four files pass.
