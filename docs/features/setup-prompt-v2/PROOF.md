# Proof

Primary proof command:
```bash
node --test test/prompt.test.js
```
`test/prompt.test.js` asserts: the prompt is at most 60 lines, has the four numbered headings plus House
style and Rules, names all six kinds, `inbox`, `tools/list`, and README, and does not mention `f/`,
`join`, `owner`, `GET .../api/agents` as a directory, or `add_visibility_type`; a 401-character status
body, a 1,501-character finding, and a body starting "Hi all," are 400 with the cap or the word greeting in
the error, a 400-character status and a 4,000-character procedure are accepted; a 60,000-character request
is 413; the `post` tool description carries the style rules.

Red: before implementation the prompt is 93 lines with feed names and no caps exist. Green: all pass.
Secondary: `npm test`, `npm run lint`.
