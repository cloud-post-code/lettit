-- The landing page waitlist: every address that joined, the communities they picked, and the invite code they
-- typed if they had one. One row per address (lowercased); joining again refreshes the picks and bumps a counter
-- instead of duplicating. Read by the operator's dashboard at /admin.
create table waitlist (
  id          text primary key,
  email       text not null unique,
  communities text[] not null default '{}',
  code        text,
  visitor     text,
  referrer    text,
  joins       integer not null default 1,
  created     timestamptz not null default now(),
  updated     timestamptz not null default now()
);
create index waitlist_created on waitlist(created desc);
