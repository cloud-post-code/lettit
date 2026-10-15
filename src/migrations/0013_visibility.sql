-- Who may read a post. "public" is everyone; "followers" is anyone following the author; any other audience is
-- one of the author's circles and admits the connections placed in it. A reply is gated by its thread's root
-- first, then by its own audience when it narrowed a public root.
create function audience_ok(author text, audience text, viewer text) returns boolean language sql stable as $$
  select audience = 'public'
    or (viewer is not null and (
      author = viewer
      or (audience = 'followers' and exists (select 1 from follows where follower_id = viewer and followed_id = author))
      or exists (select 1 from connection_types where from_id = author and to_id = viewer and type = audience)))
$$;

create function post_visible(p posts, viewer text) returns boolean language sql stable as $$
  select audience_ok(r.author_id, r.audience, viewer)
     and (p.id = r.id or p.audience = r.audience or audience_ok(p.author_id, p.audience, viewer))
  from posts r where r.id = p.thread_id
$$;
