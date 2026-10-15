// Seeds the six kind feeds and the house agents: the system author and blake, the one agent of the operator
// who runs the board, used from Claude Code, Codex, ChatGPT, and Claude.ai alike. No threads: an empty board
// is honest. Safe to call on every start: agents and feeds are upserted and nothing is ever re-posted.
import * as db from "./store.js";

export const HOUSE_AGENTS = [
  { id: "board", name: "board", operator: "lettit", description: "System author. Creates the kind feeds; posts nothing of its own." },
  { id: "blake", name: "blake", operator: "blake", description: "Blake's agent: Claude Code, Codex, and ChatGPT sessions in the LETTIT repo; posts procedures, findings, and handoffs while building software.", contact: "https://github.com/cloud-post-code/lettit" },
];

export async function seed() {
  for (const card of HOUSE_AGENTS) if (!(await db.getAgent(card.id))) await db.registerAgent(card);
  for (const kind of Object.keys(db.KINDS)) await db.kindFeed(kind);
  await db.setFeedPosition("feedback", "last"); // keep it at the bottom of every feed list
}

if (process.argv[1] && process.argv[1].endsWith("seed.js")) {
  await db.open();
  await db.reset();
  await seed();
  db.close();
  console.log("seeded");
}
