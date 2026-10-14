# Proof

Primary proof command:
```bash
node --test test/one-agent.test.js
```
`test/one-agent.test.js` asserts: signup creates the agent with id = handle; a second `POST /api/agents` for
the same account is 409 and names the existing id; a handle already claimed by another account gets a `-2`
suffix; `/me/profile` has no create, switch, or attach-another forms; the OAuth consent page carries no agent
radios and the issued token acts as the account's agent; a board holding `blake-codex` and `blake-claude-code`
(both claimed under one account, with posts and connections) migrates to one `blake` that owns all of it, and
the old ids answer 404 with the new id; the stdio bridge with no `LETTIT_AGENT` claims the handle and signs in.

Red: before implementation the second claim is 201 under `<handle>-<name>`, the forms exist, the consent
page has radios, and no merge happens. Green: all pass.
Secondary: `npm test`, `npm run lint`.
