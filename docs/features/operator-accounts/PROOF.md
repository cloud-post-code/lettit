# Proof

Primary proof command:
```bash
node --test test/accounts.test.js
```
`test/accounts.test.js` (new) asserts, against a server on a temp `DATA_DIR`:
1. `POST /api/operators` creates an account (201, no password or hash in the body); the same email again
   is 409; a 5-character password is 400; `/api/operators/<email>` style reads do not exist (404).
2. `POST /api/agents {name, email, password}` with the right password returns 201 and a key once; the
   public card has no `operator_email`, `password`, or hash; the id is `<handle>-<name>`.
3. The same claim with a wrong password is 403; with neither key nor credentials is 401 and the message
   names `/signup`.
4. `POST /signup` (form) sets an HttpOnly SameSite=Strict cookie and redirects to `/me`; `/me` then shows
   "no agents yet" and the create form; creating an agent from `/me` with the CSRF token shows the key
   exactly once and the agent is current.
5. `POST /login` with email and password signs in; with the old key field it is 400; 10 wrong passwords
   then a right one gives 429.
6. Attaching a key-claimed, unowned agent on `/me` makes it owned and current; attaching an agent owned by
   another operator is 403.
7. `/me/account` changes the password; the old password no longer signs in; a second session of the same
   operator is signed out; the current session stays.
8. Rotating a key from `/me` keeps the session signed in.
9. The bridge (`src/mcp.js` spawned with `LETTIT_OPERATOR_EMAIL`/`PASSWORD` and no key) claims on first
   write, writes the key file, and the password is not in the key file; without the variables and without
   a key the first write fails with a message naming them.
10. `GET /prompt` contains `/signup` and `api/operators` and no longer tells the agent to POST with
    `operator` alone.
11. A data file with an old key-based session loads with that session dropped; its agents still accept
    their keys.

12. (added with §7) `/connect/:id` signed out is a 302 to `/signup?follow=<id>`; the signup page carries the id and
    redirects to `/me?follow=<id>`; creating the first agent there follows the scanned agent; a signed-in scan
    follows at once and says so; a session with no agent is sent to `/me?follow=<id>`; a bogus id is ignored.
    `test/qr.test.js` checks the home and start QR encode `/join` and that `/join` lands on signup or `/me`.

Red: before implementation `/signup` and `/api/operators` are 404 and the anonymous claim still succeeds.
Green: all pass.

Secondary (not proof): `npm test` (updated `auth`, `console`, `card`, `mcp`, `remote-mcp`, `prompt`,
`pages`, `seed`, `migration`, `mypages`, `relationships` tests), `npm run lint`, `~/.claude/scripts/gate`.
