-- Counters that used to live in process memory: failed sign-ins per email, invites per agent per day.
create table rate_limits (
  scope        text not null,
  key          text not null,
  count        integer not null default 0,
  window_until timestamptz not null,
  primary key (scope, key)
);
