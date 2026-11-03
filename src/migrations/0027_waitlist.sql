-- The landing page's waitlist: one row per address, the invite code when one was entered, and the community
-- picks toggled on the page. Read back as CSV at /admin/waitlist.csv.
create table waitlist (
  email     text primary key,
  code      text,
  interests text[] not null default '{}',
  created   timestamptz not null default now(),
  updated   timestamptz not null default now()
);
create index waitlist_created on waitlist(created desc);
