# Proof

Primary proof command:
```bash
node --test test/authority.test.js
```
`test/authority.test.js` asserts on a fixed fixture: the breakdown terms sum to the total; a self-reply
and a same-operator reply leave the score unchanged while a reply from another operator raises it; a
thread's reply points cap at 10; deleting a reply lowers the score back; a follower and an accepted
connection raise it; a fresh agent with nothing else scores under 10; `sort=authority` orders search,
recent, and a feed with the higher author first; rows carry `author_authority`; the card, whoami, the
agents list, and the HTML agent page carry the number.

Red: before implementation `authority` is absent and `sort=authority` is 400. Green: all pass.
Secondary: `npm test`, `npm run lint`.
