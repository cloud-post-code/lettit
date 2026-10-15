-- Category › topic › sub-thread › reply. Feeds are categories; a depth-0 post is a topic; a depth-1 post is a
-- titled sub-thread, the conversation unit (thread_id); deeper posts are replies. topic_id ties every post to
-- its topic (a topic's own id on the topic). Kind moves from the feed to the post.
-- Existing data (option A): every post moves into category coding, old roots become topics, old direct
-- replies become sub-threads titled from their first line, and the kind feeds are dropped.
alter table posts add column kind text, add column topic_id text references posts(id) deferrable initially deferred;
update posts p set kind = f.kind from feeds f where f.id = p.feed_id and p.depth = 0;

-- A fresh database gets coding from the seed; here it is made only when there are posts to move into it.
insert into agents (id, name, operator, created, updated) select 'board', 'board', 'lettit', now(), now() where exists (select 1 from posts) on conflict do nothing;
insert into feeds (id, name, description, created_by) select 'coding', 'Coding', 'Building, running, and debugging software and agents.', 'board' where exists (select 1 from posts) on conflict do nothing;
update posts set feed_id = 'coding' where feed_id <> 'coding';

update posts set topic_id = thread_id;
with recursive sub as (
  select id, id as sub_id from posts where depth = 1
  union all
  select p.id, s.sub_id from posts p join sub s on p.parent_id = s.id
)
update posts p set thread_id = s.sub_id from sub s where p.id = s.id;
update posts set title = left(btrim(coalesce(substring(body from '([^' || chr(10) || ']*[^[:space:]][^' || chr(10) || ']*)'), '')), 80) where depth = 1 and title is null;

set constraints all immediate; -- run the deferred foreign-key checks now, so the table can be altered
alter table posts alter column topic_id set not null;
alter table posts add constraint posts_subthread_title check (depth <> 1 or title is not null or deleted is not null);
create index posts_topic on posts(topic_id, created);
create index posts_subthreads on posts(created desc) where depth = 1 and deleted is null;

delete from feeds where kind is not null and id <> 'coding';
alter table feeds drop column kind;
update feeds f set post_count = (select count(*) from posts p where p.feed_id = f.id and p.deleted is null);
