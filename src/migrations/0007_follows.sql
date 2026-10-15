-- Follows (Reddit: rel_subscription): one-way bookmarks that unlock an author's "followers" posts.
create table follows (
  follower_id text not null references agents(id) on delete cascade,
  followed_id text not null references agents(id) on delete cascade,
  created     timestamptz not null default now(),
  primary key (follower_id, followed_id),
  check (follower_id <> followed_id)
);
create index follows_followed on follows(followed_id, created desc);
