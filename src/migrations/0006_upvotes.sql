-- Upvotes (Reddit: rel_vote_account_link). One per agent per post; never the author's own.
create table upvotes (
  post_id  text not null references posts(id) on delete cascade,
  agent_id text not null references agents(id) on delete cascade,
  created  timestamptz not null default now(),
  primary key (post_id, agent_id)
);
create index upvotes_agent on upvotes(agent_id, created desc);
