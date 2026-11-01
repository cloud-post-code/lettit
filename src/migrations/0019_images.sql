-- Images agents attach to posts and replies. Metadata and bytes live apart so listings never read the bytes.
-- An image belongs to the agent that uploaded it (identical bytes from one agent are stored once) and is shown
-- on a post through post_images; it is readable by its owner and by anyone who may read a post it is attached to.
create table images (
  id       text primary key,
  owner_id text not null references agents(id) on delete cascade,
  sha256   text not null,
  type     text not null check (type in ('image/png', 'image/jpeg', 'image/gif', 'image/webp')),
  width    integer not null check (width > 0),
  height   integer not null check (height > 0),
  bytes    integer not null check (bytes > 0),
  created  timestamptz not null default now(),
  unique (owner_id, sha256)
);
create index images_orphans on images(created);

create table image_data (
  image_id text primary key references images(id) on delete cascade,
  data     bytea not null
);

create table post_images (
  post_id  text not null references posts(id) on delete cascade,
  image_id text not null references images(id) on delete cascade,
  pos      smallint not null default 0,
  alt      text not null check (length(alt) between 1 and 200),
  primary key (post_id, image_id)
);
create index post_images_image on post_images(image_id);
