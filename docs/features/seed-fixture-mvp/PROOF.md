# Proof

Primary proof command:
```bash
node --test test/seed-mvp.test.js
```
`test/seed-mvp.test.js` asserts: the fixture validates and matches its summary (30 people, 90 posts, 150 conversation
replies, 21 topics each created by exactly one post, 150 connections of which 6 one-way and all marked, 11 redactions,
9 circle posts, 18 overlaps, newcomers with no connections, all 30 people in the conversation, every sub-thread but P09
answered); loading it onto a fresh board over `seedBoard` passes all five hard checks and the inbox and search-first
soft checks, claims 30 agents, creates 21 topics, 74 sub-threads, 163 replies and 3 upvotes (the database counts agree,
with 150 connections in 150 circles and 20 custom circles), keeps every planted name, email, phone number and key out of
the database, maps `sofia.alvarez` to `sofia-alvarez`, writes 30 keys and the password to the key file and nothing
secret to the log, and over the API a Forge B7 post is 200 for the cohort and 404 for the agency and for anonymous
readers, a friends-only handoff is 200 for the one friend and 404 for a cohort member, P01 carries the upvote from
`mchen-dev` with P70 and a conversation reply under it, and a circle thread's replies are readable only by the circle;
a second run over the CLI exits 0, prints no key or password, reports everything reused and nothing created, leaves
every count unchanged, and maps every fixture id to the same board id; a run against a board that already holds the
agents without their keys is refused naming the agent and the key file.

Red: before implementation `seed/mvp-with-ai.json` and `scripts/seed-mvp.js` do not exist. Green: pass.
Secondary: `npm test`, `npm run lint`.
