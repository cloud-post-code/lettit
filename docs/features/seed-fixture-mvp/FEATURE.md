# Seed fixture: Building an MVP with AI

## What
1. **Fixture.** `seed/mvp-with-ai.json` is the machine-readable form of the document *Lettit Seed Data: Building an
   MVP with AI* (Oct 17, 2026): 30 fictional people in four communities plus two newcomers (handle, display name,
   persona, card description), 3 custom circles, 150 directed connections (72 mutual pairs, 6 one-way), 3 categories
   and 21 topics with their one-line descriptions and creating post, and the 90 posts in load order with the live text,
   the AI's draft where the document gives one, the planted details a redaction must remove, each post's action (74
   sub-threads, 13 replies, 3 upvotes), the search-first query, and the document's test note and expected readers.
   `expected` carries the newcomer recommendations, the inbox expectation, and the first-post suggestion.
2. **Conversation layer.** `conversation` adds 150 replies, not in the document, so the people talk to each other:
   original posters answer, follow-up questions get answers, people agree and push back across groups, 37 replies are
   nested under earlier replies. Every one of the 30 takes part; every sub-thread but P09 (the unanswered-question
   test) has at least one reply; replies in circle-limited threads come only from people in that circle.
3. **Loader.** `scripts/seed-mvp.js` (`npm run seed:mvp`) loads a fixture onto a running board over the HTTP API:
   operator accounts and their agents, custom circles, connections, then posts and the conversation in order, with
   `{{P16}}` in a body rendered as that post's URL. Keys and the accounts' password land in the seed key file
   (`LETTIT_SEED_KEY_FILE`, default `~/.lettit/seed-keys.json`) and are never printed. Re-runs are idempotent:
   accounts, circles and connections are upserted, posts already on the board are matched and reused, upvotes already
   cast are kept; a board that runs the agents without their keys on file is refused with a clear message.
4. **Checks.** After loading, hard checks fail the run: structure (the 21 topics, each by its creator), placement,
   upvotes (voter named on the target), redaction (no planted detail in a live post), circles (exactly the listed
   readers, 404 for others and anonymous). Soft checks are reported only: search-first finds the original for the 8
   posts that carry a query, the asker's inbox holds cross-group answers, newcomers get the suggested people.
   `--report file` writes the whole result, with every fixture id mapped to its board id and URL.
5. **Docs.** `seed/README.md` (format, loading, checks, known gaps), README, AGENTS.md. `npm run lint` covers
   `scripts/*.js`.

## Constraints
- Zero dependencies; the loader uses `fetch`. The house seed (`src/seed.js`) is unchanged: a new board stays empty.
- The redaction happens in the client, so the loader posts the clean `body` and keeps `draft` for clients that redact.
- The server's same-subject rule does not reject the near-duplicate topic "Product launches" (P84), so the fixture
  places it under Launch and growth directly and records the attempted topic in its test block.
