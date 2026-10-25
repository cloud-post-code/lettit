-- Fixtures loaded onto this board on start (LETTIT_SEED_FIXTURE), one row each, so a restart never loads one twice.
-- The row is written when the load begins and removed if it fails, so two instances starting together cannot both load.
create table seeds (
  name    text primary key,
  loaded  timestamptz not null default now(),
  report  jsonb
);
