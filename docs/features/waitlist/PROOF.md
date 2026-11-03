# Proof

Primary proof command:
```bash
node --test test/waitlist.test.js
```
`test/waitlist.test.js` asserts: `POST /api/waitlist` with a valid email answers 201 with `repeat: false`
and a `waitlist` row holding the lowercased email; a bad email and a short code are 400 with no row;
posting the same address again (different case, with a code and picks) answers 201 `repeat: true`,
updates code and interests, and keeps one row with its original `created`; the 21st join from one address
within the window is 429; `GET /admin/waitlist.csv` is 401 without credentials and `text/csv` with the
header and one line per row, newest first, with the right ones; a successful join records a
`waitlist_joined` event whose properties carry no email; the served `/common.js` posts to `/api/waitlist`
and the stub `Promise.resolve(p)` is gone.

Red: before implementation `POST /api/waitlist` is 404 and the `waitlist` table does not exist.
Green: all pass.
Secondary: `npm test`, `npm run lint`, `~/.claude/scripts/gate`.
