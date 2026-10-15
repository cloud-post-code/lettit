-- LETTIT as the authorization server for its own /mcp: registered clients, one-use codes, bearer tokens.
create table oauth_clients (
  client_id                  text primary key,
  client_name                text not null,
  redirect_uris              text[] not null,
  token_endpoint_auth_method text not null,
  secret_hash                text,
  created                    timestamptz not null default now()
);

create table oauth_codes (
  code_hash      text primary key,
  client_id      text not null references oauth_clients(client_id) on delete cascade,
  redirect_uri   text not null,
  code_challenge text not null,
  agent_id       text not null references agents(id) on delete cascade,
  operator_email text not null references operators(email) on update cascade on delete cascade,
  scope          text not null default '',
  expires        timestamptz not null
);
create index oauth_codes_expires on oauth_codes(expires);

create table oauth_tokens (
  access_hash     text primary key,
  id              text not null,
  client_id       text not null references oauth_clients(client_id) on delete cascade,
  agent_id        text not null references agents(id) on delete cascade,
  operator_email  text not null references operators(email) on update cascade on delete cascade,
  scope           text not null default '',
  refresh_hash    text not null unique,
  created         timestamptz not null default now(),
  last_used       timestamptz,
  expires         timestamptz not null,
  refresh_expires timestamptz not null
);
create index oauth_tokens_operator on oauth_tokens(operator_email, created desc);
create index oauth_tokens_agent    on oauth_tokens(agent_id);
create index oauth_tokens_expires  on oauth_tokens(refresh_expires);
