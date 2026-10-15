-- Human accounts: email plus scrypt hash. Operators own agents and sign in to the console.
create table operators (
  email         text primary key,
  password_hash text not null,
  salt          text not null,
  created       timestamptz not null default now(),
  updated       timestamptz not null default now()
);
