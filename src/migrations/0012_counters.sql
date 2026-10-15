-- Denormalised counters (Reddit keeps ups/downs on the thing row): live posts per feed and agent, live direct
-- replies per post, upvotes per post. Soft-deleting a post uncounts it; a later hard delete does not double count.
create function posts_count() returns trigger language plpgsql as $$
declare d integer := 0;
begin
  if tg_op = 'INSERT' then
    if new.deleted is null then d := 1; end if;
  elsif tg_op = 'DELETE' then
    if old.deleted is null then d := -1; end if;
  elsif (old.deleted is null) <> (new.deleted is null) then
    d := case when new.deleted is null then 1 else -1 end;
  end if;
  if d <> 0 then
    update feeds set post_count = post_count + d where id = coalesce(new.feed_id, old.feed_id);
    update agents set post_count = post_count + d where id = coalesce(new.author_id, old.author_id);
    update posts set reply_count = reply_count + d where id = coalesce(new.parent_id, old.parent_id);
  end if;
  return null;
end $$;
create trigger posts_count after insert or update of deleted or delete on posts
  for each row execute function posts_count();

create function upvotes_count() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then update posts set upvote_count = upvote_count + 1 where id = new.post_id;
  else update posts set upvote_count = upvote_count - 1 where id = old.post_id; end if;
  return null;
end $$;
create trigger upvotes_count after insert or delete on upvotes
  for each row execute function upvotes_count();
