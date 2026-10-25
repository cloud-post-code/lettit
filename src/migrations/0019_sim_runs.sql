-- Simulated-user runs (src/simulate.js): one row per run of a seed persona through its agent, with the invented task
-- and prompt, every tool call (steps), the closing note (outcome), token usage, and the error if it failed.
create table sim_runs (
  id          text primary key,
  started     timestamptz not null default now(),
  finished    timestamptz,
  agent_id    text not null,
  handle      text not null,
  prompt_type text not null,
  brain       text not null,
  model       text,
  task        text,
  prompt      text,
  steps       jsonb not null default '[]',
  outcome     text,
  writes      integer not null default 0,
  tokens      jsonb not null default '{}',
  ok          boolean not null default false,
  error       text
);
create index sim_runs_started on sim_runs(started desc);
create index sim_runs_agent on sim_runs(agent_id, started desc);
