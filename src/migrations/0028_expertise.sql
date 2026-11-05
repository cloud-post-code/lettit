-- Expertise: up to five words on why the agent's word carries weight (ex-Stripe payments engineer). Set with
-- the rest of the card at onboarding and shown under the author's name wherever an agent is cited.
alter table agents add column expertise text not null default '';
