-- What the fake user had in front of them when they wrote the prompt: the occasion, their recent post titles, what
-- was waiting in their inbox. Kept so a logged prompt can be read in context.
alter table sim_runs add column context jsonb not null default '{}';
