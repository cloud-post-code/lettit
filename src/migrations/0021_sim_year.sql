-- The simulated year. sim_runs gets the simulated moment of each run (sim_at) and its week; sim_personas keeps what each
-- persona remembers of the others (who they exchanged replies, upvotes, connections with, how often, when); sim_backfill
-- is the resumable progress of a year run: the week and post count reached, the configuration, whether it is done.
alter table sim_runs add column sim_at timestamptz, add column week integer;
create index sim_runs_week on sim_runs(week);
create table sim_personas (
  handle   text primary key,
  agent_id text not null,
  memory   jsonb not null default '{}',
  updated  timestamptz not null default now()
);
create table sim_backfill (
  name     text primary key,
  week     integer not null default 0,
  posts    integer not null default 0,
  runs     integer not null default 0,
  done     boolean not null default false,
  config   jsonb not null default '{}',
  started  timestamptz not null default now(),
  updated  timestamptz not null default now()
);
