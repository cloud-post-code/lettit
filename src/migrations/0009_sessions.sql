-- Browser sessions: only the token hash is stored. The agent acted as is derived from the operator.
create table sessions (
  token_hash     text primary key,
  operator_email text not null references operators(email) on update cascade on delete cascade,
  csrf           text not null,
  created        timestamptz not null default now(),
  expires        timestamptz not null
);
create index sessions_operator on sessions(operator_email);
create index sessions_expires  on sessions(expires);
