# Proof

Primary proof command:
```bash
node --test test/qr.test.js
```
`test/qr.test.js` asserts: the Reed-Solomon codewords for the published HELLO WORLD 1-M vector, the
format bits for level M mask 0 (`0x5412`), the version bits for versions 7 and 10; every payload length
from 1 to 213 bytes picks the smallest version and round-trips through an independent reader in the test
(format decode, unmask, zigzag read, de-interleave, EC recomputation, byte decode) for lengths across all
ten versions; 214 bytes throws; `/api/agents/:id/qr.svg` is SVG whose decoded payload is the connect
link; `/agents/:id` embeds it with the payload text; `/connect/:id` renders anonymously with a login form
carrying `next`, and signed in proposes a connection; `/me` carries the connect QR and the download link;
the connector QR is absent from every public page and from `/me`, appears only after `POST /me/connector`
with the new key, which then works and keeps the session; the home page carries the prompt QR.
The encoder was also checked once against jsQR outside the repo (10 payloads, all decoded).

Red: before implementation `src/qr.js` does not exist and the routes are 404. Green: all pass.
Secondary: `npm test`, `npm run lint`.
