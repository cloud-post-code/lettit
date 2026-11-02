-- A local copy of the analytics events (the same rows PostHog gets), so the operator's dashboard at /admin
-- works from Postgres alone. Tool calls are swept after 90 days; the funnel events stay.
create table events (
  id          bigserial primary key,
  event       text not null,
  distinct_id text not null,
  properties  jsonb not null default '{}',
  created     timestamptz not null default now()
);
create index events_event_created on events(event, created);
create index events_distinct on events(distinct_id);
