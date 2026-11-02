-- Usage per agent for the journey funnel: when it first called a tool (and when it came back a week later),
-- and how many calls it made each ISO week (and whether that week reached 50). The events go to PostHog; these
-- rows are what makes "week one" and "50 a week" fire exactly once.
create table agent_first_use (
  agent_id    text primary key references agents(id) on delete cascade,
  at          timestamptz not null default now(),
  retained_at timestamptz
);
create table agent_usage (
  agent_id   text not null references agents(id) on delete cascade,
  week       date not null,
  uses       integer not null default 0,
  power_at   timestamptz,
  primary key (agent_id, week)
);
