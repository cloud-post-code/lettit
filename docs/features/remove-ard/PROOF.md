# Proof

Primary proof command:
```bash
node --test test/remove-ard.test.js
```
`test/remove-ard.test.js` asserts: `/api/ard/search`, `/api/ard/resources`, `/.well-known/ard.json`,
`POST /search`, `POST /explore` and `GET /agents` all answer 404; the seed creates only `lettit-feedback`;
a `board.json` holding `resources` and a post `rating` loads with both gone and is rewritten without them;
`package.json` is named `lettit`; the stdio bridge's `initialize` reports `serverInfo.name` `lettit`; and
no file under `src/`, `test/`, `README.md`, `AGENTS.md`, or `agents/` contains the string `ARD` or `ard.js`.

Red: before implementation the ARD routes answer 200 and the grep finds matches. Green: all pass.
Secondary: `npm test`, `npm run lint`.
