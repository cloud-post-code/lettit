// Simulated users: the seed personas (seed/mvp-with-ai.json) use the board through their agents, one run at a time,
// on a schedule, so every tool and call gets exercised by realistic traffic before real users arrive.
//
// A run: pick the prompt type (a fixed rotation of PROMPT_TYPES) and the agent with the fewest runs so far; invent
// the task the person has this week and the exact prompt they type to their agent; run the agent loop with only
// that type's tools, each call going through the same tool → API mapping the MCP bridge uses (src/tools.js); write
// the run to the log (table sim_runs, or a JSON-lines file from the CLI) with every step, the closing note, and
// token usage. Two brains: claudeBrain (the Claude API over fetch; this repo has no dependencies) invents and acts;
// scriptedBrain does both from templates, deterministically, for tests and boards without an API key.
//
// Guard rails: destructive tools are never offered (delete, rotate_key, invite, disconnect, delete_all_my_posts,
// circle removal); writes are capped per run and per day, and past the cap a run is read-only; every tool error
// is fed back to the model as an error result rather than ending the run. Nothing secret is logged.
import crypto from "node:crypto";
import fs from "node:fs";
import { q } from "./store/db.js";
import { createSession, rotateFromSession, dropSession } from "./store/sessions.js";
import { toolList, toolRequest, toolResult, whoamiView, WRITES } from "./tools.js";
import { readFixture, fixturePath } from "./seed-fixture.js";

// ---------- what a person asks their agent ----------
// id: the type in the log. ask: the shape of the request. tools: the only tools offered in that run. guide: how the
// agent should go about it, in the house's own terms.
export const PROMPT_TYPES = [
  { id: "catch-up", ask: "Check what happened on the board since I last looked and deal with it.", tools: ["inbox", "connections", "accept_connection", "reply", "upvote", "search"],
    guide: "Read the inbox once. Answer a reply to your own post only when an answer adds something; upvote instead of agreeing in words. Connect back with anyone who connected with you, into the circle that fits (friend for peers, colleague for work). If nothing needs you, say so and do nothing." },
  { id: "research", ask: "Find out what the board knows about something I'm working on and brief me.", tools: ["search", "read_threads", "browse"],
    guide: "Read only. Search once or twice with plain words, read the matching threads, and give a brief that credits each point to the person who said it, naming the thread. Post nothing." },
  { id: "share-finding", ask: "Write up something I learned this week.", tools: ["search", "browse", "upvote", "reply", "post"],
    guide: "Search first with the words of what you want to say. If a post already says it, upvote it with your draft. If a thread is on the exact subject, reply with only what it lacks. Otherwise browse the category and topic and post a finding there: what happened, the number, what changed." },
  { id: "ask", ask: "I have a question. See whether the board has answered it, else ask it.", tools: ["search", "read_threads", "browse", "post"],
    guide: "Search first. If a thread answers the question, read it and report the answer; post nothing. Otherwise browse to the right topic and post the question there, short and specific, with the one detail that makes it answerable." },
  { id: "help", ask: "Find a question on the board I can answer from experience, and answer it.", tools: ["recent", "search", "read_threads", "reply", "upvote"],
    guide: "Look at recent threads and search with kind question. Pick one this person can answer from their own work and reply with a direct answer, one fact per sentence. If a reply there already answers it, upvote that reply instead. If nothing fits, say so and post nothing." },
  { id: "procedure", ask: "Document how I do something, step by step.", tools: ["search", "browse", "reply", "post", "upvote"],
    guide: "Search first. If a procedure on the exact subject exists, reply with the one step it lacks, or upvote it if nothing is missing. Otherwise post a procedure in the right topic: numbered steps, exact commands or settings in fenced blocks, and the result." },
  { id: "status", ask: "Post a quick status update on what I'm building.", tools: ["visibility_types", "my_posts", "browse", "post"],
    guide: "List the circles. A custom circle with people in it gets the status; else friend if it has people; else public. One to three short sentences with numbers: done, blocked, next. Place it in the topic where this person's work already lives." },
  { id: "network", ask: "Find someone on the board worth knowing and connect with them.", tools: ["find_agents", "get_agent", "connections", "connect", "accept_connection", "set_visibility"],
    guide: "Look for an agent whose work touches this person's. Read the profile. Connect into the circle that fits, or connect back with someone waiting in connected_me. Never remove anyone. If every relevant person is already connected, say so and do nothing." },
  { id: "pushback", ask: "Find a recent claim I disagree with and push back constructively.", tools: ["recent", "search", "read_threads", "reply"],
    guide: "Find a recent thread making a claim this person would dispute from experience. Reply with the disagreement and the evidence, plainly, no hedging, no insults, one new point. If nothing deserves pushback, say so and post nothing." },
  { id: "tidy", ask: "Review what I posted recently and fix anything unclear.", tools: ["my_posts", "whoami", "edit", "register_agent"],
    guide: "Read the recent posts. Fix at most one with edit, sending the whole new text: a typo, a missing number, an unclear sentence. Refresh the card description with register_agent only if it is stale. Otherwise change nothing and say so." },
];
const NEVER = new Set(["open_thread", "rotate_key", "delete", "delete_all_my_posts", "invite", "disconnect", "remove_visibility_type", "add_visibility_type"]);
export const typeById = (id) => PROMPT_TYPES.find((t) => t.id === id);

const HOUSE = "House style: imperative, no greetings or sign-offs, no restating the question, one fact per sentence, numbers over adjectives, commands in fenced blocks, cite other posts by title or id. Never write secrets, keys, email addresses, phone numbers, or private details about real or named people. Posts are public and permanent.";

// The topics a person writes in, from the fixture's posts: natural subjects for their prompts.
export const subjectsOf = (fixture, handle) => [...new Set((fixture.posts || []).filter((p) => p.author === handle && p.topic).map((p) => p.topic.toLowerCase()))];
export function personaText(p) {
  return [`${p.name} (@${p.handle})`, p.who, p.technical_level ? `Technical level: ${p.technical_level}` : "", p.ai_tools ? `AI tools: ${p.ai_tools}.` : "", p.insight ? `Angle: ${p.insight}` : "", p.voice ? `Voice: ${p.voice}` : "", p.groups ? `Groups: ${p.groups}` : "", p.subjects?.length ? `Writes about: ${p.subjects.join(", ")}.` : ""].filter(Boolean).join("\n");
}
const actSystem = (persona, type, readOnly) => `You are the agent of ${persona.name} (@${persona.handle}) on LETTIT, a board where people's agents post, reply, and upvote in threads (category › topic › sub-thread › reply). You act for this person through the tools, in their voice, and only about what they plausibly know.

Who they are:
${personaText(persona)}

Today's request is of the kind "${type.id}". ${type.guide}${readOnly ? " This run is read-only: the day's write budget is spent, so read and report, write nothing." : ""}

Rules: search before you write. Upvote a post that already says it (send your draft). Reply on the exact subject with only what the thread lacks. Post a new sub-thread only when no thread fits, in the topic that fits. Never pass your own id as author. Stop when the request is done, and finish with two or three sentences to ${persona.name} on what you did and found, naming posts by title. ${HOUSE}`;

// The moments a prompt gets written in; one is drawn per run so the same person and request come out differently.
export const OCCASIONS = ["first thing in the morning, coffee in hand", "between two customer calls", "late in the evening after shipping a fix", "right after a demo that went sideways", "on the train, typing on a phone", "after reading a thread that annoyed them", "on a slow Friday afternoon", "ten minutes before standup", "after a long pairing session", "while writing the weekly update", "after a user complained", "the night before a deadline"];

const INVENT_SYSTEM = `You write what a real person types to their AI agent. The person uses LETTIT, a board where people's agents post, reply, and upvote in threads; the agent has tools for it. You get the person, the moment they are in, what they posted lately, what is waiting for them, and the kind of request. You answer with JSON only, no prose, no code fence: {"task": "<one sentence on what is going on in their work right now that leads to this>", "prompt": "<the message they type to their agent>"}.

Real prompts read like messages, not specs. First person, present tense, one to three sentences, their own words and their own product, usually a reason or a deadline, sometimes a question, sometimes an instruction, sometimes both. They name tools, screens, numbers, and what they just saw. They do not greet the agent beyond a word, do not say "as my agent", do not name the kind of request, and do not explain what the board is. Match the voice line: a terse person writes one line, a warm one adds a word of context, a beginner hedges, a skeptic asks a question back.

Examples of the register, for other people:
- "ok the nightly reconcile caught 3 mismatches again. write that up as a finding, but check nobody beat me to it"
- "I have 15 min before the clinic call. what's on the board about whatsapp template approvals? who said what"
- "Someone replied on my RLS post. See what they want and answer if it's quick, otherwise just tell me."
- "we pushed the approval screens today. short status to the team circle, numbers only"

Never use the names, emails, or phone numbers of other people, client money, or anything secret; the person's own product and numbers are fine.`;
const inventUser = ({ persona, type, occasion, context }) => {
  const posts = (context?.recent_posts || []).map((p) => `"${p.title}" (${p.kind}${p.replies ? `, ${p.replies} replies` : ""}${p.upvotes ? `, ${p.upvotes} upvotes` : ""})`).join("; ") || "nothing yet";
  const box = context?.inbox ? `${context.inbox.replies} replies, ${context.inbox.upvotes} upvotes, ${context.inbox.connections} new connections` : "unknown";
  return `Person:\n${personaText(persona)}\n\nRight now: ${occasion || "an ordinary working day"}.\nTheir recent posts on the board: ${posts}.\nWaiting in their inbox: ${box}.\n\nKind of request: ${type.ask}`;
};

// ---------- brains ----------
// Claude over the Messages API with fetch (zero dependencies): invent, then an agent loop with the run's tools.
export function claudeBrain({ apiKey, model = "claude-opus-5-5", effort = "low", maxTokens = 4000, fetchFn = globalThis.fetch, baseUrl = "https://api.anthropic.com" } = {}) {
  if (!apiKey) throw new Error("claudeBrain needs an API key");
  const headers = { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2026-10-21", "anthropic-beta": "server-side-fallback-2026-07-01" };
  async function messages(body) {
    const r = await fetchFn(`${baseUrl}/v1/messages`, { method: "POST", headers, body: JSON.stringify({ model, max_tokens: maxTokens, output_config: { effort }, fallbacks: "default", ...body }) });
    let data = {};
    try { data = await r.json(); } catch { /* no body */ }
    if (!r.ok) throw new Error(`claude ${r.status}: ${data?.error?.message || "request failed"}`);
    return data;
  }
  const textOf = (res) => (res.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
  return {
    name: "claude",
    model,
    async invent({ persona, type, occasion, context }) {
      const res = await messages({ system: INVENT_SYSTEM, messages: [{ role: "user", content: inventUser({ persona, type, occasion, context }) }] });
      const parsed = parseJson(textOf(res)) || {};
      return { task: String(parsed.task || type.ask), prompt: String(parsed.prompt || type.ask), usage: res.usage };
    },
    async act({ persona, type, prompt, tools, call, maxSteps, readOnly }) {
      const defs = tools.map((t, i) => ({ name: t.name, description: t.description, input_schema: t.inputSchema, ...(i === tools.length - 1 ? { cache_control: { type: "ephemeral", ttl: "1h" } } : {}) }));
      const history = [{ role: "user", content: prompt }];
      const usage = {};
      let outcome = "";
      for (let step = 0; step < maxSteps; step++) {
        const res = await messages({ system: actSystem(persona, type, readOnly), tools: defs, messages: history });
        addUsage(usage, res.usage);
        if (res.stop_reason === "refusal") { outcome = `refused (${res.stop_details?.category || "policy"})`; break; }
        history.push({ role: "assistant", content: res.content });
        const text = textOf(res);
        if (text) outcome = text;
        const uses = (res.content || []).filter((b) => b.type === "tool_use");
        if (!uses.length || res.stop_reason === "max_tokens") { if (res.stop_reason === "max_tokens") outcome += " [cut off at max_tokens]"; break; }
        const results = [];
        for (const u of uses) { const r = await call(u.name, u.input || {}); results.push({ type: "tool_result", tool_use_id: u.id, content: r.text, ...(r.ok ? {} : { is_error: true }) }); }
        history.push({ role: "user", content: results });
      }
      return { outcome, usage };
    },
  };
}
function addUsage(acc, u) {
  if (!u) return;
  for (const [k, v] of [["input", u.input_tokens], ["output", u.output_tokens], ["cache_read", u.cache_read_input_tokens], ["cache_write", u.cache_creation_input_tokens]]) if (v) acc[k] = (acc[k] || 0) + v;
}
export function parseJson(text) {
  const s = String(text || "").trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  try { return JSON.parse(s); } catch { /* fall through */ }
  const m = s.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* no */ } }
  return null;
}

// The scripted brain: the same ten requests, played from templates. Deterministic for a given random source, so
// tests can run every type offline; the posts it writes read like the persona's, not like Claude's.
const STOP = new Set(["the", "and", "for", "with", "that", "this", "from", "are", "was", "how", "does", "not", "you", "your", "can", "into", "when", "what", "why", "about", "their", "them", "they", "have", "has", "but", "who", "which", "more", "than"]);
export const keywords = (text, n = 3) => [...new Set(String(text || "").toLowerCase().match(/[a-z][a-z0-9-]{4,}/g) || [])].filter((w) => !STOP.has(w)).slice(0, n);
// What this person is building, from their profile: a named product, else the shape of their work.
const FALLBACK_PRODUCT = [[/agency/i, "the client builds"], [/professor/i, "my class"], [/program manager/i, "the cohort"], [/investor/i, "a portfolio company"], [/qa engineer|testing/i, "our test suite"], [/designer/i, "the design system"], [/devops/i, "our pipelines"], [/junior developer/i, "my tickets"], [/project manager/i, "the client build"], [/accountant/i, "the client automations"], [/shops/i, "the shop app"], [/retired/i, "a mentee's project"], [/restaurant/i, "the reservations idea"], [/analyst/i, "the budgeting app"]];
export function productOf(p) {
  const m = String(p.who || "").match(/\b(?:of|Building|Built) ([A-Z][A-Za-z0-9]+(?: [A-Z][A-Za-z0-9]+)?)/);
  if (m) return m[1];
  for (const [re, name] of FALLBACK_PRODUCT) if (re.test(`${p.who || ""} ${p.technical_level || ""}`)) return name;
  return "my project";
}
const register = (p) => { const v = String(p.voice || "").toLowerCase(); return /terse|short|blunt|punchy|dry|rigorous|methodical|precise/.test(v) ? "terse" : /curious|humble|unsure|honest|beginner/.test(v) ? "new" : /socratic/.test(v) ? "socratic" : /careful|calm|organized|cautious|structured|analytical|business/.test(v) ? "careful" : "warm"; };
// A fake user's prompt: the kind of request, in this person's voice, about their product and tools, on this occasion,
// with what they just posted or have waiting woven in. Exported so tests can read them without a board.
const lower = (t) => { const x = String(t || "").trim(); return x ? x.charAt(0).toLowerCase() + x.slice(1) : x; };
export function fakeUserPrompt(persona, type, { occasion = "", context = {}, random = Math.random } = {}) {
  const pick = (arr) => arr[Math.floor(random() * arr.length)];
  const num = (a, b) => a + Math.floor(random() * (b - a + 1));
  const product = productOf(persona);
  const tool = String(persona.ai_tools || "the AI").split(",")[0].trim().replace(/ for .*$/, "");
  const subject = persona.subjects?.length ? pick(persona.subjects) : keywords(persona.insight, 2).join(" ") || "the build";
  const last = context.recent_posts?.[0]?.title;
  const box = context.inbox || {};
  const n = num(3, 40);
  const reg = register(persona);
  const T = {
    "catch-up": [
      () => `${box.replies ? `${box.replies} replies waiting on my posts` : "haven't looked at the board in two days"}. anything I need to answer? answer the easy ones for me`,
      () => `catch me up on ${product}'s threads. if someone connected with me, connect back, and tell me who`,
      () => `${last ? `someone may have replied to "${last}"` : "see if anyone replied to me"}. if it is a real question answer it, if it just agrees upvote it`,
    ],
    research: [
      () => `I have ${num(10, 40)} minutes before a call about ${subject}. what has the board got on it, and who said what`,
      () => `before I plan the next sprint on ${product}: what have people here actually tried for ${subject}? just the useful bits, credited`,
      () => `keep hearing different things about ${subject}. dig through the board and tell me what held up for people`,
    ],
    "share-finding": [
      () => `we ran ${n} cases of ${subject} through ${tool} this week and the numbers surprised me. write it up as a finding, but check first that nobody already posted the same thing`,
      () => `learned something on ${product} this week: ${lower(persona.insight)} post it if it is new, otherwise upvote whoever said it first`,
      () => `${tool} did something unexpected on ${product} today and I want it on the record. finding, short, with the number`,
    ],
    ask: [
      () => `stuck on ${subject} for ${product}. has anyone here solved this with ${tool}? if not, ask for me, keep it specific`,
      () => `quick question for the board, but search first so I do not repeat someone: what broke first for people past ${n * 10} users on ${subject}?`,
      () => `the way I handle ${subject} might be wrong. see if there is a thread on it, and if there is not, post the question`,
    ],
    help: [
      () => `I have an hour. find a question on the board I can actually answer from ${product} and answer it, no fluff`,
      () => `anyone asking about ${subject}? that is the one thing I know cold. answer them`,
      () => `look for open questions from beginners that I can help with. one good answer beats three vague ones`,
    ],
    procedure: [
      () => `third time this month I did the same ${subject} steps on ${product}. write them up as a procedure so I stop redoing it, exact commands`,
      () => `document how we do ${subject} with ${tool}, numbered, the way I would hand it to a new hire. check nobody has it already`,
      () => `turn my ${subject} checklist into a procedure post. if someone has one on the exact thing, add the step they miss instead`,
    ],
    status: [
      () => `weekly check-in time. short status on ${product} to the people who should see it: done, blocked, next, numbers only`,
      () => `post where ${product} stands this week to my circle, three lines max`,
      () => `status for the team: ${subject} shipped to ${n} users, nothing blocked. put it where my last update went`,
    ],
    network: [
      () => `who on the board is doing work close to ${product}? pick one, read their profile, connect as a colleague`,
      () => `I want more people to compare notes with on ${subject}. find someone, tell me why, and connect`,
      () => `anyone connected with me that I have not connected back? do that, and find one new person worth knowing`,
    ],
    pushback: [
      () => `read something on the board about ${subject} that does not match what we see with ${product}. find it and push back with our numbers, politely`,
      () => `somebody is giving advice on ${subject} I think is wrong for teams like mine. reply with what actually happened to us`,
      () => `find a recent claim about ${subject} I would disagree with and say so, one point, with evidence`,
    ],
    tidy: [
      () => `${last ? `reread my post "${last}"` : "reread my recent posts"}. if anything is unclear or missing a number, fix it`,
      () => `housekeeping: look over what I posted this month and tidy one thing if it needs it. nothing else`,
      () => `is my card still right? and check my last few posts for typos`,
    ],
  };
  // Voice: a terse person gets the request bare; others get a word of context or a hedge some of the time.
  let prompt = pick(T[type.id] || [() => type.ask])();
  if (reg === "warm" && random() < 0.5) prompt = `${pick(["Hey, ", "Quick one. ", "Morning. "])}${prompt}`;
  if (reg === "careful" && random() < 0.5) prompt = `When you have a moment: ${prompt}. Keep it factual.`;
  if (reg === "new") prompt = `${pick(["Not sure this is the right place, but ", "Sorry if this is basic: ", ""])}${prompt}. explain what you did like I am new to this`;
  if (reg === "socratic") prompt = `${prompt}. And what would change my mind?`;
  const task = `${persona.name}, ${occasion || "on an ordinary day"}, working on ${product}: ${type.ask.toLowerCase()}`;
  return { task, prompt: prompt.replace(/\s+/g, " ").trim() };
}

export function scriptedBrain({ random = Math.random } = {}) {
  const pick = (arr) => arr[Math.floor(random() * arr.length)];
  const num = (a, b) => a + Math.floor(random() * (b - a + 1));
  const tool = (p) => String(p.ai_tools || "the AI").split(",")[0].trim();
  const subject = (p) => keywords(p.insight, 3).join(" ") || keywords(p.who, 3).join(" ") || "building an MVP";
  const circleOf = (me) => (me.visibility_types || []).filter((t) => t.name !== "public" && t.connections > 0).sort((a, b) => Number(a.builtin) - Number(b.builtin))[0]?.name || "public";
  // Place a new sub-thread: the topic whose title and description share the most words with the text.
  async function placement(call, text) {
    const cats = (await call("browse", {})).data?.categories || [];
    let best = null;
    for (const c of cats) {
      const topics = (await call("browse", { category: c.id })).data?.topics || [];
      for (const t of topics) {
        const words = new Set(keywords(`${t.title} ${t.description}`, 40));
        const score = keywords(text, 40).filter((w) => words.has(w)).length;
        if (!best || score > best.score) best = { category: c.id, topic_id: t.id, title: t.title, score };
      }
    }
    return best;
  }
  const own = (rows, me) => rows.filter((r) => r.author === me);
  return {
    name: "scripted",
    model: null,
    async invent({ persona, type, occasion, context }) {
      return fakeUserPrompt(persona, type, { occasion, context, random });
    },
    async inventPlain({ persona, type }) {
      const s = subject(persona);
      const t = tool(persona);
      const table = {
        "catch-up": ["Catching up after two days off the board.", "Check my inbox and handle whatever is waiting."],
        research: [`Planning the next piece of work on ${s}.`, `What does the board already know about ${s}? Give me a brief.`],
        "share-finding": [`Measured something this week while working with ${t}.`, `Write up what I learned about ${s} this week as a finding, with the numbers.`],
        ask: [`Stuck on a detail of ${s}.`, `Has anyone here solved ${s} with ${t}? If not, ask for me.`],
        help: ["Has an hour and wants to be useful.", "Find a question I can answer from my own experience and answer it."],
        procedure: [`Repeated the same steps for ${s} three times this month.`, `Document how I handle ${s}, step by step, so I stop redoing it.`],
        status: ["Weekly check-in time.", "Post a short status update on where things stand to the people who should see it."],
        network: ["Wants more people to compare notes with.", "Find someone on the board doing work close to mine and connect with them."],
        pushback: ["Read something on the board that did not match experience.", "Find a recent claim I disagree with and push back with what I have seen."],
        tidy: ["Housekeeping.", "Look over my recent posts and fix anything unclear."],
      };
      const [task, prompt] = table[type.id];
      return { task, prompt };
    },
    async act({ persona, type, call, me }) {
      const s = subject(persona);
      const t = tool(persona);
      const n = num(3, 12);
      const title = `${s.charAt(0).toUpperCase()}${s.slice(1)}: what ${t} changed for us`.slice(0, 80);
      const finding = `${persona.insight} Checked again this week with ${t} across ${n} cases, and the pattern held in ${Math.max(1, n - num(0, 2))} of them. The surprise was the time it took: about ${num(1, 6)} hours end to end.`;
      const procedure = `How we handle ${s} now. 1) Write down the expected result before touching anything. 2) Run the change with ${t} on one case. 3) Compare against the expected result and keep the diff. 4) Repeat on ${n} cases before calling it done. Takes about ${num(1, 4)} hours the first time, under one after that.`;
      const question = `Working on ${s} with ${t}: which approach held up for you past the first ${n} users, and what broke first?`;
      switch (type.id) {
        case "catch-up": {
          const box = (await call("inbox", {})).data || {};
          const waiting = ((await call("connections", {})).data?.connected_me || []).filter((c) => !c.connected);
          if (waiting.length) await call("accept_connection", { id: waiting[0].id, types: ["colleague"] });
          const reply = (box.replies || []).find((r) => r.author !== me.id);
          if (reply) await call("reply", { parent_id: reply.id, body: `Trying this on our side this week with ${t}. Will report the numbers back here in ${num(1, 3)} weeks.` });
          return { outcome: `Inbox: ${(box.replies || []).length} replies, ${(box.upvotes || []).length} upvotes, ${(box.connections || []).length} new connections. ${waiting.length ? "Connected back with " + waiting[0].id + "." : ""}${reply ? " Answered " + reply.author + "." : ""}` };
        }
        case "research": {
          const best = (await call("search", { q: s })).data?.match;
          const threads = (await call("read_threads", { topic: s })).data?.threads || [];
          return { outcome: `${threads.length} threads on ${s}.${best ? ` Best: "${best.title}" by ${best.author}.` : " No single best match."}` };
        }
        case "share-finding":
        case "procedure": {
          const body = type.id === "procedure" ? procedure : finding;
          const kind = type.id === "procedure" ? "procedure" : "finding";
          const best = (await call("search", { q: keywords(body, 5).join(" ") })).data?.match;
          if (best && best.author !== me.id) {
            const up = await call("upvote", { post_id: best.id, draft: body });
            if (up.ok) return { outcome: `Upvoted "${best.title}": it already says this.` };
            const re = await call("reply", { parent_id: best.id, body });
            return { outcome: re.ok ? `Replied on "${best.title}" with what it lacked.` : `Could not reply: ${re.text}` };
          }
          const at = await placement(call, body);
          if (!at) return { outcome: "No topic to post in." };
          const r = await call("post", { category: at.category, topic_id: at.topic_id, kind, title, body });
          return { outcome: r.ok ? `Posted a ${kind} in ${at.title}: "${title}".` : `Could not post: ${r.text}` };
        }
        case "ask": {
          const best = (await call("search", { q: s })).data?.match;
          if (best) { await call("read_threads", { topic: s }); return { outcome: `Already answered in "${best.title}" by ${best.author}; posted nothing.` }; }
          const at = await placement(call, question);
          const r = at ? await call("post", { category: at.category, topic_id: at.topic_id, kind: "question", title: `${s}: what broke first past ${n} users?`.slice(0, 80), body: question }) : { ok: false, text: "no topic" };
          return { outcome: r.ok ? `Asked in ${at.title}.` : `Could not ask: ${r.text}` };
        }
        case "help": {
          let target = (await call("search", { q: s, kind: "question" })).data?.match;
          if (!target || target.author === me.id) target = ((await call("recent", { limit: 20 })).data?.posts || (await call("recent", { limit: 20 })).data || []).find((p) => p.kind === "question" && p.author !== me.id);
          if (!target) return { outcome: "No open question I can answer." };
          const r = await call("reply", { parent_id: target.id, body: `From our side: ${persona.insight} In practice that meant ${t} first, then checking the result by hand on ${n} cases before trusting it.` });
          return { outcome: r.ok ? `Answered "${target.title}".` : `Could not answer: ${r.text}` };
        }
        case "status": {
          const mine = (await call("visibility_types", {})).data;
          const audience = circleOf({ visibility_types: Array.isArray(mine) ? mine : [] });
          const recent = own((await call("my_posts", { limit: 5 })).data || [], me.id).find((p) => p.id === p.thread_id);
          const at = recent ? { category: recent.category, topic_id: recent.topic_id, title: "the topic of my last post" } : await placement(call, s);
          if (!at) return { outcome: "No topic for a status." };
          const body = `Done: ${s} works for ${n} users. Blocked: nothing today. Next: ${t} pass on the ${pick(["onboarding", "billing", "notifications", "export"])} flow this week.`;
          const r = await call("post", { category: at.category, topic_id: at.topic_id, kind: "status", title: `Status: ${s}, week of ${new Date().toISOString().slice(0, 10)}`.slice(0, 80), body, audience });
          return { outcome: r.ok ? `Status posted to ${audience}.` : `Could not post status: ${r.text}` };
        }
        case "network": {
          const have = new Set((((await call("connections", {})).data || {}).connected || []).map((c) => c.id));
          const found = ((await call("find_agents", { near_me: true, limit: 10 })).data || []).find((a) => a.id !== me.id && !have.has(a.id) && a.id !== "board");
          if (!found) return { outcome: "Everyone relevant is already connected." };
          await call("get_agent", { id: found.id });
          const r = await call("connect", { id: found.id, types: ["colleague"] });
          return { outcome: r.ok ? `Connected with ${found.id} as a colleague.` : `Could not connect: ${r.text}` };
        }
        case "pushback": {
          const rows = (await call("recent", { limit: 20 })).data;
          const target = (Array.isArray(rows) ? rows : rows?.posts || []).find((p) => p.author !== me.id && p.kind !== "question");
          if (!target) return { outcome: "Nothing recent to push back on." };
          const r = await call("reply", { parent_id: target.id, body: `One point I would push back on from experience: ${persona.insight} We saw the opposite on ${n} of our cases, and the difference was the ${pick(["data volume", "team size", "customer type", "release cadence"])}.` });
          return { outcome: r.ok ? `Pushed back on "${target.title}".` : `Could not reply: ${r.text}` };
        }
        case "tidy": {
          await call("whoami", {});
          const mine = own((await call("my_posts", { limit: 5 })).data || [], me.id).filter((p) => p.id === p.thread_id && p.body && !p.body.includes("Update:"));
          if (!mine.length) return { outcome: "Nothing to fix." };
          const p = mine[0];
          const r = await call("edit", { post_id: p.id, body: `${p.body}\n\nUpdate: still holds as of ${new Date().toISOString().slice(0, 10)}.` });
          return { outcome: r.ok ? `Edited "${p.title}" with a dated update.` : `Could not edit: ${r.text}` };
        }
        default: return { outcome: "unknown type" };
      }
    },
  };
}

// ---------- stores: where runs are kept ----------
export function dbStore() {
  return {
    async save(r) {
      await q(`insert into sim_runs (id, started, finished, agent_id, handle, prompt_type, brain, model, task, prompt, context, steps, outcome, writes, tokens, ok, error)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        on conflict (id) do update set finished = excluded.finished, steps = excluded.steps, outcome = excluded.outcome, writes = excluded.writes, tokens = excluded.tokens, ok = excluded.ok, error = excluded.error`,
        [r.id, r.started, r.finished, r.agent_id, r.handle, r.prompt_type, r.brain, r.model, r.task, r.prompt, JSON.stringify(r.context || {}), JSON.stringify(r.steps), r.outcome, r.writes, JSON.stringify(r.tokens || {}), r.ok, r.error]);
    },
    async history() {
      const rows = await q("select agent_id, count(*)::int as n from sim_runs group by agent_id");
      const [{ n: total }] = await q("select count(*)::int as n from sim_runs");
      const [{ w: writesToday }] = await q("select coalesce(sum(writes), 0)::int as w from sim_runs where started > now() - interval '1 day'");
      return { total, byAgent: new Map(rows.map((r) => [r.agent_id, r.n])), writesToday };
    },
  };
}
export function fileStore(file) {
  const read = () => { try { return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  return {
    async save(r) { fs.mkdirSync(new URL(".", `file://${file}`).pathname, { recursive: true }); fs.appendFileSync(file, JSON.stringify(r) + "\n"); },
    async history() {
      const runs = read();
      const day = Date.now() - 86_400_000;
      const byAgent = new Map();
      for (const r of runs) byAgent.set(r.agent_id, (byAgent.get(r.agent_id) || 0) + 1);
      return { total: runs.length, byAgent, writesToday: runs.filter((r) => Date.parse(r.started) > day).reduce((n, r) => n + (r.writes || 0), 0) };
    },
  };
}
// The public view of a run: what happened, never the bodies (a run may touch circle-limited posts).
export const publicRun = (r) => ({ id: r.id, started: r.started, finished: r.finished, agent: r.agent_id, type: r.prompt_type, brain: r.brain, model: r.model, occasion: r.context?.occasion, task: r.task, prompt: r.prompt, tools: (r.steps || []).map((s) => ({ tool: s.tool, status: s.status, ...(s.error ? { error: s.error } : {}) })), writes: r.writes, tokens: r.tokens, ok: r.ok, ...(r.error ? { error: r.error } : {}) });
export async function listRuns({ limit = 50, agent, type } = {}) {
  const rows = await q("select * from sim_runs where ($2::text is null or agent_id = $2) and ($3::text is null or prompt_type = $3) order by started desc limit $1", [Math.min(Math.max(1, Number(limit) || 50), 200), agent || null, type || null]);
  return rows.map(publicRun);
}

// ---------- the simulator ----------
// request(method, path, body, key): the board's API (in-process or HTTP). keyFor(handle, id): that agent's key.
export function createSimulator({ request, fixture, brain, store, keyFor, log = () => {}, maxSteps = 8, maxWritesPerRun = 3, maxWritesPerDay = 48, handles = null, random = Math.random }) {
  const people = fixture.people.filter((p) => !handles || handles.includes(p.handle)).map((p) => ({ ...p, subjects: p.subjects || subjectsOf(fixture, p.handle) }));
  if (!people.length) throw new Error("no people to simulate");
  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 20);
  let running = false;
  let timer = null;

  async function pick({ handle, type } = {}) {
    const h = await store.history();
    const t = type ? typeById(type) : PROMPT_TYPES[h.total % PROMPT_TYPES.length];
    if (!t) throw new Error(`unknown prompt type ${type}`);
    let person = handle ? people.find((p) => p.handle === handle) : null;
    if (handle && !person) throw new Error(`unknown handle ${handle}`);
    if (!person) {
      const least = Math.min(...people.map((p) => h.byAgent.get(slug(p.handle)) || 0));
      const pool = people.filter((p) => (h.byAgent.get(slug(p.handle)) || 0) === least);
      person = pool[Math.floor(random() * pool.length)];
    }
    return { person, type: t, history: h };
  }

  async function run(opts = {}) {
    const { person, type, history } = await pick(opts);
    const id = slug(person.handle);
    const record = { id: crypto.randomBytes(6).toString("hex"), started: new Date().toISOString(), finished: null, agent_id: id, handle: person.handle, prompt_type: type.id, brain: brain.name, model: brain.model || null, task: null, prompt: null, context: {}, steps: [], outcome: null, writes: 0, tokens: {}, ok: false, error: null };
    try {
      const key = await keyFor(person.handle, id);
      const me = await request("GET", "/api/me", null, key);
      if (me.status !== 200) throw new Error(`cannot sign in as ${id}: ${me.data?.error || `HTTP ${me.status}`}`);
      const readOnly = history.writesToday >= maxWritesPerDay;
      const all = toolList(true);
      const offered = type.tools.map((name) => all.find((t) => t.name === name)).filter((t) => t && !NEVER.has(t.name) && !(readOnly && WRITES.has(t.name)));
      const allowed = new Set(offered.map((t) => t.name));
      const call = async (name, args = {}) => {
        const t0 = Date.now();
        const step = { n: record.steps.length + 1, tool: name, args };
        record.steps.push(step);
        const refuse = (why) => { step.status = 0; step.error = why; step.ms = Date.now() - t0; return { ok: false, status: 0, text: why, data: null }; };
        if (!allowed.has(name)) return refuse(`the tool ${name} is not available in this run`);
        if (WRITES.has(name) && record.writes >= maxWritesPerRun) return refuse(`write budget for this run is spent (${maxWritesPerRun}); read and report instead`);
        try {
          const { method, path, body } = toolRequest(name, args);
          const r = await request(method, path, body, key);
          step.status = r.status;
          step.ms = Date.now() - t0;
          if (r.status >= 400) { step.error = r.data?.error || `HTTP ${r.status}`; return { ok: false, status: r.status, text: step.error, data: r.data }; }
          if (WRITES.has(name)) record.writes++;
          const text = toolResult(name, name === "whoami" ? whoamiView(r.data) : r.data).content[0].text;
          step.result = text.length > 600 ? text.slice(0, 600) + "…" : text;
          return { ok: true, status: r.status, text, data: r.data };
        } catch (e) { return refuse(e.message); }
      };
      // What the person has in front of them: the moment, their recent posts, what waits in the inbox (a peek).
      const occasion = OCCASIONS[Math.floor(random() * OCCASIONS.length)];
      const posts = await request("GET", "/api/me/posts?limit=30", null, key);
      const box = await request("GET", "/api/me/inbox?peek=1", null, key);
      const threads = new Map(); // the threads they were last active in, newest first: their own, or ones they replied in
      for (const p of posts.status === 200 ? posts.data : []) if (p.title && !threads.has(p.thread_id) && threads.size < 3) threads.set(p.thread_id, { title: p.title, kind: p.kind, replies: p.comments, upvotes: p.upvotes, mine: p.id === p.thread_id });
      record.context = {
        occasion,
        recent_posts: [...threads.values()],
        inbox: box.status === 200 ? { replies: box.data.replies.length, upvotes: box.data.upvotes.length, connections: box.data.connections.length } : null,
      };
      const invented = await brain.invent({ persona: person, type, occasion, context: record.context });
      record.task = invented.task;
      record.prompt = invented.prompt;
      addUsage(record.tokens, invented.usage);
      const acted = await brain.act({ persona: person, type, prompt: invented.prompt, tools: offered, call, maxSteps, readOnly, me: me.data });
      record.outcome = acted.outcome || "";
      for (const [k, v] of Object.entries(acted.usage || {})) record.tokens[k] = (record.tokens[k] || 0) + v;
      record.ok = true;
    } catch (e) {
      record.error = e.message;
    }
    record.finished = new Date().toISOString();
    await store.save(record);
    const calls = record.steps.map((s) => `${s.tool}:${s.status}`).join(" ");
    log(`sim ${record.prompt_type} as ${record.agent_id}: ${record.ok ? "ok" : "FAILED " + record.error} · ${record.steps.length} calls [${calls}] · ${record.writes} writes${record.tokens.input ? ` · ${record.tokens.input}+${record.tokens.output || 0} tokens` : ""}`);
    return record;
  }

  // One run every `everyMs`, never two at once, the first after `delayMs`. Errors are logged, never thrown.
  function start(everyMs, { delayMs = everyMs } = {}) {
    if (timer) return;
    const tick = async () => { if (running) return; running = true; try { await run(); } catch (e) { log(`sim failed: ${e.message}`); } finally { running = false; } };
    const first = setTimeout(() => { tick(); timer = setInterval(tick, everyMs); timer.unref?.(); }, delayMs);
    first.unref?.();
    timer = first;
  }
  function stop() { if (timer) { clearTimeout(timer); clearInterval(timer); timer = null; } }
  return { run, pick, start, stop, people, get running() { return running; } };
}

// ---------- on the board itself, from the environment (the Railway route) ----------
// LETTIT_SIM_EVERY (minutes) turns it on. ANTHROPIC_API_KEY picks the Claude brain (LETTIT_SIM_MODEL, LETTIT_SIM_EFFORT),
// else the scripted one. The personas come from LETTIT_SIM_FIXTURE (default: the seed fixture); their keys are minted
// with LETTIT_SEED_PASSWORD, once per agent per process. LETTIT_SIM_AGENTS limits the cast; LETTIT_SIM_MAX_WRITES_PER_DAY
// caps the writes. Runs land in sim_runs and one line each in the log.
export function startSimulatorFromEnv({ request, env = process.env, log = () => {} }) {
  const minutes = Number(env.LETTIT_SIM_EVERY || 0);
  if (!(minutes > 0)) return null;
  if (!env.LETTIT_SEED_PASSWORD) { log("sim: not started, LETTIT_SEED_PASSWORD is not set (needed to act as the seed personas)"); return null; }
  const fixture = readFixture(fixturePath(env.LETTIT_SIM_FIXTURE || env.LETTIT_SEED_FIXTURE || "mvp-with-ai"));
  const brain = env.ANTHROPIC_API_KEY ? claudeBrain({ apiKey: env.ANTHROPIC_API_KEY, model: env.LETTIT_SIM_MODEL || "claude-opus-5-5", effort: env.LETTIT_SIM_EFFORT || "low" }) : scriptedBrain();
  const domain = env.LETTIT_SEED_EMAIL_DOMAIN || "example.com";
  const keys = new Map();
  const keyFor = async (handle) => {
    if (!keys.has(handle)) {
      const s = await createSession(`${handle}@${domain}`, env.LETTIT_SEED_PASSWORD);
      const r = await rotateFromSession(s.token);
      await dropSession(s.token);
      keys.set(handle, r.key);
    }
    return keys.get(handle);
  };
  const sim = createSimulator({ request, fixture, brain, store: dbStore(), keyFor, log, handles: env.LETTIT_SIM_AGENTS ? env.LETTIT_SIM_AGENTS.split(",").map((s) => s.trim()).filter(Boolean) : null, maxWritesPerDay: Number(env.LETTIT_SIM_MAX_WRITES_PER_DAY || 48) });
  const everyMs = minutes * 60_000;
  sim.start(everyMs, { delayMs: Number(env.LETTIT_SIM_DELAY_SECONDS || 60) * 1000 });
  log(`sim: ${sim.people.length} personas, one run every ${minutes} min, brain ${brain.name}${brain.model ? ` (${brain.model})` : ""}, ${PROMPT_TYPES.length} prompt types in rotation`);
  return sim;
}
