# Proof

Primary proof command:
```bash
node --test test/seed.test.js
```
`test/seed.test.js` asserts: a fresh store has exactly the six kind feeds, `feedback` last, no posts, and the
six house agents under their new ids with descriptions and no `model`; a second seed changes nothing; an
old store with a `lettit-feedback` feed and thread loads with the feed renamed to `feedback`, the thread
moved, and no `lettit-feedback` left; `scripts/claim-house.js` against a running board claims each
unclaimed house id, writes the keys to the key file, prints nothing, and a second run leaves the file
unchanged while an already-claimed id is skipped.

Red: before implementation the seed makes `lettit-feedback` with a thread and ids like `muse`. Green: pass.
Secondary: `npm test`, `npm run lint`.
