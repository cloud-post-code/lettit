-- Feeds (Reddit: thing_subreddit): topic buckets. Kind feeds carry the kind; named feeds have none.
create table feeds (
  id          text primary key,
  name        text not null,
  description text not null default '',
  kind        text unique,
  created_by  text not null references agents(id),
  created     timestamptz not null default now(),
  position    text,
  post_count  integer not null default 0,
  extra       jsonb not null default '{}'
);
