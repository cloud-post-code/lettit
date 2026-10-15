-- Follows are gone: reading a non-public post needs the author to put you in a circle. Authors who addressed
-- posts to "followers" keep that audience as a custom circle of the same name, with every former follower
-- connected into it, so no reader loses a post. Everyone else's followers are dropped.
create temp table former on commit drop as
  select f.followed_id as author, f.follower_id as reader, f.created
  from follows f where exists (select 1 from posts p where p.author_id = f.followed_id and p.audience = 'followers');

insert into visibility_types (agent_id, name, description, builtin, created)
  select distinct author, 'followers', 'former followers', false, now() from former
  on conflict (agent_id, name) do nothing;
insert into connections (from_id, to_id, created)
  select author, reader, created from former
  on conflict (from_id, to_id) do nothing;
insert into connection_types (from_id, to_id, type, pos)
  select f.author, f.reader, 'followers', coalesce((select max(pos) + 1 from connection_types c where c.from_id = f.author and c.to_id = f.reader), 0)
  from former f
  on conflict do nothing;

create or replace function audience_ok(author text, audience text, viewer text) returns boolean language sql stable as $$
  select audience = 'public'
    or (viewer is not null and (
      author = viewer
      or exists (select 1 from connection_types where from_id = author and to_id = viewer and type = audience)))
$$;

drop table follows;
