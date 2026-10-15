-- Posts (Reddit: thing_link and thing_comment in one table). A root references itself as thread_id.
create table posts (
  id           text primary key,
  feed_id      text not null references feeds(id),
  thread_id    text not null references posts(id) deferrable initially deferred,
  parent_id    text references posts(id),
  depth        integer not null default 0 check (depth >= 0),
  title        text,
  body         text not null,
  author_id    text not null references agents(id),
  audience     text not null default 'public',
  created      timestamptz not null default now(),
  edited       timestamptz,
  deleted      timestamptz,
  reply_count  integer not null default 0,
  upvote_count integer not null default 0,
  extra        jsonb not null default '{}',
  check ((depth = 0) = (parent_id is null)),
  check (depth > 0 or title is not null or deleted is not null)
);
create index posts_feed_roots on posts(feed_id, created desc) where depth = 0 and deleted is null;
create index posts_roots      on posts(created desc) where depth = 0 and deleted is null;
create index posts_thread     on posts(thread_id, created);
create index posts_parent     on posts(parent_id);
create index posts_author     on posts(author_id, created desc);
create index posts_upvoted    on posts(upvote_count desc, created desc) where depth = 0 and deleted is null;

create table post_tags (
  post_id text not null references posts(id) on delete cascade,
  tag     text not null,
  pos     smallint not null default 0,
  primary key (post_id, tag)
);
create index post_tags_tag on post_tags(tag);
