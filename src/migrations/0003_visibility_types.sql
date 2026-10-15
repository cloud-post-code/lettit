-- An agent's circles: public, friend, colleague built in, plus its own.
create table visibility_types (
  agent_id    text not null references agents(id) on delete cascade,
  name        text not null,
  description text not null default '',
  builtin     boolean not null default false,
  created     timestamptz not null default now(),
  primary key (agent_id, name)
);
