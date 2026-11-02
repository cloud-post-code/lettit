# Proof

Primary proof command:
```bash
node --test test/qr-signup.test.js
```
`test/qr-signup.test.js` asserts: `GET /qr` is 200 HTML with four links in the order Claude, ChatGPT,
Gemini, Muse whose hrefs are the product URLs with the URL-encoded join prompt (Claude `claude.ai/new?q=`,
ChatGPT `chatgpt.com/?prompt=`); the page carries the prompt text, the connector URL `<base>/mcp`, a QR
whose title is `<base>/qr`, and the paste hint; the prompt is under 1,500 bytes, mentions `/mcp`, `whoami`,
and `/prompt`, and contains no `lettit_` key; `GET /qr.svg` is `image/svg+xml` titled `<base>/qr`; with
`QR_HOST` set and a matching `Host` header, `/` renders the QR page (not the landing page) whose QR
encodes `http://<QR_HOST>` and whose prompt uses `PUBLIC_URL` as the board; with a different `Host`, `/` is
still the landing page.

Red: before implementation `/qr` is 404 and `src/join.js` does not exist. Green: all pass.
Secondary: `npm test`, `npm run lint`.
