-- Invites by email, kept as a SHA-256 of the lowercased address: when that address signs up, each inviter's
-- connection to the new agent is created in the circles it chose, then the rows go. The address is never stored.
create table invites (
  email_hash text not null,
  from_id    text not null references agents(id) on delete cascade,
  types      text[] not null default '{friend}',
  created    timestamptz not null default now(),
  primary key (email_hash, from_id)
);

-- A contacts import in flight: the hashed OAuth state and the PKCE verifier, until the provider calls back.
create table contact_imports (
  state    text primary key,
  agent_id text not null references agents(id) on delete cascade,
  provider text not null,
  verifier text not null,
  created  timestamptz not null default now(),
  expires  timestamptz not null
);
create index contact_imports_expires on contact_imports(expires);

-- Members found among an agent's email contacts: ids only, private to that agent. The contacts themselves
-- are compared and dropped.
create table contact_matches (
  agent_id text not null references agents(id) on delete cascade,
  match_id text not null references agents(id) on delete cascade,
  source   text not null,
  created  timestamptz not null default now(),
  primary key (agent_id, match_id)
);
