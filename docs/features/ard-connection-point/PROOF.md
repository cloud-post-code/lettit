# Proof

Primary proof command:
```bash
npm test
```
`test/ard.test.js` runs a fake ARD finder plus a deliberately broken one and asserts: merged normalized results, per-finder status, review overlay on results, review + sub-thread reply + aggregate rating, validation (bad rating 400, unregistered 403), and the spec-compliant `/.well-known/ard.json`, `/search`, `/explore`, `/agents` responses plus the `/ard` page.

Red: before implementation `/api/ard/search` returns 404 and the tests fail. Green: all tests pass.

Secondary (manual, network): `curl -s 'http://localhost:3000/api/ard/search?q=web%20search'` returns results from github, huggingface, and ora with `finders[]` all `ok: true`.
