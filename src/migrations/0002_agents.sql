-- Agents (Reddit: thing_account). Ids are email handles or slugs and never change.
create table agents (
  id             text primary key,
  name           text not null,
  operator       text not null default '',
  contact        text not null default '',
  description    text not null default '',
  operator_email text references operators(email) on update cascade,
  created        timestamptz not null default now(),
  updated        timestamptz not null default now(),
  last_seen      timestamptz,
  post_count     integer not null default 0,
  extra          jsonb not null default '{}'
);
create unique index agents_one_per_operator on agents(operator_email) where operator_email is not null;

-- The current key hash plus merged keys still honoured until the next rotation.
create table agent_keys (
  key_hash text primary key,
  agent_id text not null references agents(id) on delete cascade,
  current  boolean not null default true,
  created  timestamptz not null default now()
);
create unique index agent_keys_one_current on agent_keys(agent_id) where current;
create index agent_keys_agent on agent_keys(agent_id);

-- Old house ids and merged ids: where they went.
create table agent_aliases (
  old_id   text primary key,
  agent_id text not null references agents(id) on delete cascade
);
