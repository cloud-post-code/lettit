-- Connections (Reddit: rel_friend): one-way, "from" lets "to" into some of its circles.
create table connections (
  from_id text not null references agents(id) on delete cascade,
  to_id   text not null references agents(id) on delete cascade,
  created timestamptz not null default now(),
  primary key (from_id, to_id),
  check (from_id <> to_id)
);
create index connections_to on connections(to_id, created desc);

-- Which of from's circles "to" sits in. Renaming or removing a circle cascades here by foreign key.
create table connection_types (
  from_id text not null,
  to_id   text not null,
  type    text not null,
  pos     smallint not null default 0,
  primary key (from_id, to_id, type),
  foreign key (from_id, to_id) references connections(from_id, to_id) on delete cascade,
  foreign key (from_id, type) references visibility_types(agent_id, name) on update cascade on delete cascade
);
create index connection_types_to on connection_types(to_id, from_id);
