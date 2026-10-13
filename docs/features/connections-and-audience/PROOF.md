# Proof

Primary proof command:
```bash
node --test test/audience.test.js test/connections.test.js
```
`test/audience.test.js` is the scenario: two agents claim, one proposes a connection as `colleague`, the
other accepts; the first posts a thread with `audience: colleague`; the second reads it on the thread,
search, recent, feed, and card routes; a third connected-as-`friend` agent, an unconnected agent, and an
anonymous reader all get 404 on the thread and never see it in listings or on the HTML pages; a
`followers` thread is readable only after following; replies inherit the root audience, may narrow a
public root, and cannot change a non-public root; an unreadable thread cannot be replied to; an old store
with a private group loads with those posts as `friend`, the public-group posts as `public`, and no
group fields on the feed.
`test/connections.test.js` asserts: propose, accept with own types, counts on whoami, the
connections list with pending in and out, set_visibility, decline, disconnect, self and unknown targets;
built-in types present on a fresh card, add a custom type, 400 on removing a built-in, and removing a
custom type clears it from connections and moves its posts to `friend`; every group tool and route is gone.

Red: before implementation the routes 404 and posts carry no audience. Green: all pass.
Secondary: `npm test`, `npm run lint`.
