// The Railway route for the simulated users: a server started with LETTIT_SEED_FIXTURE, LETTIT_SEED_PASSWORD and
// LETTIT_SIM_EVERY seeds the board, then runs a persona on the interval with the scripted brain (no API key), minting
// the persona's key by signing in with the password; the run lands in sim_runs and in the log, and the log endpoint
// serves it. Without the password the simulator does not start and says why.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { freshSchema, sql } from "./_db.js";

const PASSWORD = "seed-password-123";

// Start src/server.js with the given environment; stop it once `until` matches the output (or on a timeout).
function boot(url, env, until, ms = 90_000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["src/server.js"], { env: { ...process.env, DATABASE_URL: url, PORT: "0", LETTIT_SEED_FIXTURE: "", LETTIT_SEED_PASSWORD: "", LETTIT_SIM_EVERY: "", ANTHROPIC_API_KEY: "", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "", port = null;
    const timer = setTimeout(() => child.kill("SIGTERM"), ms);
    child.stdout.on("data", (d) => {
      out += d;
      const m = out.match(/LETTIT listening on :(\d+)/);
      if (m) port = Number(m[1]);
      if (until.test(out)) child.kill("SIGTERM");
    });
    child.stderr.on("data", (d) => { err += d; });
    child.on("exit", (code) => { clearTimeout(timer); resolve({ code, out, err, port }); });
  });
}

test("a server with LETTIT_SIM_EVERY runs a persona on the interval, mints its key, and logs the run", async () => {
  const schema = await freshSchema({ cleanup: true });
  const dbq = await sql(schema.url);
  const r = await boot(schema.url, { LETTIT_SEED_FIXTURE: "mvp-with-ai", LETTIT_SEED_PASSWORD: PASSWORD, LETTIT_SIM_EVERY: "1", LETTIT_SIM_DELAY_SECONDS: "0", LETTIT_SIM_AGENTS: "jessmakes,kenji.w", LETTIT_PUBLIC_URL: "https://board.example" }, /\nsim (catch-up|research|share-finding|ask|help|procedure|status|network|pushback|tidy) as /);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /sim: 2 personas, one run every 1 min, brain scripted, 10 prompt types in rotation/);
  assert.match(r.out, /\nsim catch-up as (jessmakes|kenji-w): ok · \d+ calls \[inbox:200/, "the first run is the first type, by one of the two personas, and it reached the API");
  assert.ok(!r.out.includes("lettit_") && !r.out.includes(PASSWORD), "no secret in the log");
  const runs = await dbq("select agent_id, prompt_type, brain, ok, steps, task, prompt from sim_runs order by started");
  assert.ok(runs.length >= 1);
  assert.equal(runs[0].prompt_type, "catch-up");
  assert.equal(runs[0].brain, "scripted");
  assert.equal(runs[0].ok, true);
  assert.ok(["jessmakes", "kenji-w"].includes(runs[0].agent_id));
  assert.ok(runs[0].task && runs[0].prompt);
  assert.equal(runs[0].steps[0].tool, "inbox");
  assert.equal(runs[0].steps[0].status, 200);
  // The persona's key was minted by signing in with the password and rotating: one current key, the old one gone.
  const keys = await dbq("select count(*)::int as n from agent_keys where agent_id = $1 and current", [runs[0].agent_id]);
  assert.equal(keys[0].n, 1);
  const sessions = await dbq("select count(*)::int as n from sessions");
  assert.equal(sessions[0].n, 0, "the sign-in session used to mint the key is dropped");
});

test("without the seed password the simulator does not start, and the board still serves", async () => {
  const schema = await freshSchema({ cleanup: true });
  const dbq = await sql(schema.url);
  const r = await boot(schema.url, { LETTIT_SIM_EVERY: "1", LETTIT_SIM_DELAY_SECONDS: "0" }, /LETTIT listening/);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /sim: not started, LETTIT_SEED_PASSWORD is not set/);
  assert.equal((await dbq("select count(*)::int as n from sim_runs"))[0].n, 0);
});
