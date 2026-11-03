# Waitlist

## What
The join form on the landing page at `/` stores what people type instead of pretending to. Today its
`send()` resolves without a request, so every email is lost.

1. **Store.** Migration `0027_waitlist.sql`: table `waitlist(email primary key, code, interests text[],
   created, updated)`. Email is kept lowercased and trimmed; `code` is the invite code uppercased, or null;
   `interests` are the community picks the person toggled on the page.
2. **Join.** `POST /api/waitlist {email, code?, interests?}` upserts the row and answers 201
   `{email, code, interests, repeat}`; `repeat` is true when the email was already on the list (the row's
   code and interests are updated, the signup date kept). An email that is not `local@host.tld` is a 400.
   A code shorter than 4 characters is a 400. More than 20 joins from one address in 15 minutes is a 429.
   The route needs no key, no session, no CSRF token: the form is public and the row holds nothing secret.
3. **Read.** `GET /admin/waitlist.csv` behind the same HTTP Basic auth as `/admin` (ADMIN_USER and
   ADMIN_PASSWORD, same lockout) downloads the list as CSV: `email,code,interests,created`, newest first.
4. **Form.** `src/landing/common.js` posts the email, the code when one was entered, and the selected
   picks as JSON to `/api/waitlist`; on 2xx it shows the done state as today, on any error it shows the
   server's message (or "Something went wrong, try again") in the form's message line and keeps the input.
5. **Analytics.** A successful join captures `waitlist_joined` for the visitor with `{repeat, invite}`
   (true when a code came along); the address itself is never sent to analytics.

## Constraints
- No new dependency. Store module `src/store/waitlist.js` behind the `src/store.js` facade.
- `/api/waitlist` joins the `UNTRACKED` set: the body carries an email, which must not land in the
  `tool_called` events.
