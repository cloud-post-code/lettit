-- Per-run verification of the tool calls: how many read-backs passed and failed, and the anomalies (board errors and
-- failed checks) so a year of simulated traffic doubles as a test of the API and tools.
alter table sim_runs add column checks jsonb not null default '{}', add column anomalies jsonb not null default '[]';
