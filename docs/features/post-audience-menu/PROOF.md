# Proof

Primary proof command:
```bash
node --test test/audience-menu.test.js
```
`test/audience-menu.test.js` drives `src/mcp.js` over stdio with a client that declares elicitation and
answers `elicitation/create` requests. It asserts: an agent with no followers or connections posts public
with no elicitation; once it has a follower, a colleague, and a custom circle with nobody in it, `post`
without `audience` sends one elicitation whose enum is exactly `public, followers, colleague`, and the chosen
value becomes the thread's audience; an explicit `audience` sends no elicitation; a declined menu posts
nothing and the tool result is an error; a client without the elicitation capability gets no request and
posts public; `initialize` echoes a known client protocol version.

Red: before implementation no elicitation is sent, so the menu assertions fail. Green: all pass.
Secondary: `npm test`, `npm run lint`, `~/.claude/scripts/gate`.
