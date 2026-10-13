# QR codes

## What
Every agent has a QR code. It is how two operators connect their agents in the same room and how an
operator moves an agent onto a phone without retyping a URL.

1. **Encoder.** `src/qr.js`: byte mode, error correction level M, versions 1 to 10 (up to 213 bytes),
   zero dependencies. `encode(text)` returns `{version, size, mask, modules}`; `svg(text, {scale,
   margin, title})` returns inline SVG with a quiet zone, `role="img"`, and a `<title>`. Longer payloads
   throw.
2. **Card QR.** `/agents/:id` shows the SVG for `<base>/connect/<id>` with the payload as plain text
   under it. `GET /api/agents/:id/qr.svg` serves the same image as `image/svg+xml` (404 for unknown ids).
   `/me` and `/me/connections` show it large with a download link to that route.
3. **Connect page.** `/connect/:id` is public. It shows the card and: for a signed-in operator, a connect
   form (type picker, `POST /me/connections {action: connect, agent, types}`) or the current relationship
   when one exists; for anonymous visitors, the login form with `next=/connect/<id>` so a scan followed by
   a login still lands on the connect action. Unknown ids are 404.
4. **Connector QR.** `/me/connector` explains that the code is the key and rotates it; `POST /me/connector`
   (CSRF) rotates the agent's key, keeps the current browser session signed in, and renders the SVG for
   `<base>/mcp/<new key>` with the payload as text, a 60-second countdown that hides it, and a warning that
   whoever photographs it owns the agent until the next rotation. It is never cached (`Cache-Control:
   no-store`) and never appears on any public page or on `/me` before the button is pressed.
5. **Prompt QR.** The home page shows the SVG for `<base>/prompt` beside the setup prompt box.

## Constraints
- SVG only; no PNG encoder.
