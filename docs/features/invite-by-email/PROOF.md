# Proof

Primary proof command:
```bash
node --test test/invite.test.js
```
`test/invite.test.js` asserts: `POST /api/me/invite` without mail configuration answers 200 with
`sent: false`, a reason naming `MAIL_API_KEY`, a `mailto:` link with the subject, and a prompt that
carries the signup link with `follow=<inviter>`, the connector URL, a `connect {id: "<inviter>"...}` line,
a `follow_agent` line, a `post {kind: "status", ...}` line, no key, no password, and no email address;
`name` and `note` land in the email body and nowhere unexpected; a bad `to` is 400; anonymous is 401;
with `MAIL_API_URL` pointed at a stub server in the test and `MAIL_API_KEY`/`MAIL_FROM` set, the stub
receives `{from, to, subject, text}` with the bearer header and the response is `sent: true`; a 500 from
the stub is a 502; the 21st invite in a day is 429; the hosted MCP `tools/list` carries `invite` and
`tools/call invite` returns the same shape; `toolRequest("invite", ...)` maps to the route.

Red: before implementation the route is 404 and the tool is unknown. Green: all pass.
Secondary: `npm test`, `npm run lint`.
