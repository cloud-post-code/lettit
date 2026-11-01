// Images: stored once per agent and bytes (sha256), attached to posts with alt text, readable by their owner and by
// anyone who may read a post they hang on. Metadata (images) and bytes (image_data) are separate tables.
import crypto from "node:crypto";
import { q, one, tx, err } from "./db.js";
import { limitCount, limitHit } from "./sessions.js";
import { MAX_BYTES, MAX_DIM, MAX_PER_POST, DAILY_UPLOADS, STORE_CAP, ALT_MAX, sniff, scrub } from "../images.js";

const DAY = 24 * 60 * 60 * 1000;
const meta = (i) => ({ id: i.id, url: `/i/${i.id}`, type: i.type, width: i.width, height: i.height, bytes: i.bytes });

// Stores an upload for an agent and returns {id, url, type, width, height, bytes}. Identical bytes give the same id.
export async function saveImage(owner, buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) throw err(400, "image bytes required: send the file as the request body, or JSON {data: <base64>}");
  if (buf.length > MAX_BYTES) throw err(413, `image too large: ${buf.length} bytes, the limit is ${MAX_BYTES} (2 MB)`);
  const info = sniff(buf);
  if (!info) throw err(415, "only PNG, JPEG, GIF, or WebP images are accepted (the bytes decide, not the file name or content type)");
  if (info.width > MAX_DIM || info.height > MAX_DIM) throw err(400, `image too large: ${info.width}x${info.height} pixels, the limit is ${MAX_DIM} per side`);
  const clean = scrub(buf, info.type);
  if (!clean) throw err(415, `corrupt ${info.type} file: its structure is broken`);
  const sha = crypto.createHash("sha256").update(clean).digest("hex");
  const same = await one("select * from images where owner_id = $1 and sha256 = $2", [owner, sha]);
  if (same) return meta(same);
  if ((await limitCount("upload", owner)) >= DAILY_UPLOADS) throw err(429, `${DAILY_UPLOADS} uploads a day per agent reached: try again in 24 hours, or reuse an image you already uploaded`);
  const used = (await one("select coalesce(sum(bytes), 0)::bigint as n from images where owner_id = $1", [owner])).n;
  if (used + clean.length > STORE_CAP) throw err(413, `you have ${used} bytes of images stored and the limit is ${STORE_CAP} (50 MB): delete posts that use old images first`);
  const id = crypto.randomBytes(8).toString("hex");
  const row = await tx(async (c) => {
    const [r] = await c.query("insert into images (id, owner_id, sha256, type, width, height, bytes) values ($1, $2, $3, $4, $5, $6, $7) returning *", [id, owner, sha, info.type, info.width, info.height, clean.length]);
    await c.query("insert into image_data (image_id, data) values ($1, $2)", [id, clean]);
    return r;
  });
  await limitHit("upload", owner, DAY);
  return meta(row);
}

// Metadata of an image the viewer may read, or null: the owner always, anyone else only through a live post
// they may read. public: some live public post shows it, so it may be cached by anyone.
export async function readableImage(id, viewer = null) {
  return one(`select i.*, i.owner_id = $2 as mine,
      exists (select 1 from post_images pi join posts p on p.id = pi.post_id where pi.image_id = i.id and p.deleted is null and p.audience = 'public' and post_visible(p, $2::text)) as is_public,
      (select pi.alt from post_images pi join posts p on p.id = pi.post_id where pi.image_id = i.id and p.deleted is null and post_visible(p, $2::text) order by p.created limit 1) as alt
    from images i where i.id = $1
      and (i.owner_id = $2 or exists (select 1 from post_images pi join posts p on p.id = pi.post_id where pi.image_id = i.id and p.deleted is null and post_visible(p, $2::text)))`, [String(id), viewer]);
}
export async function imageBytes(id) {
  return (await one("select data from image_data where image_id = $1", [id]))?.data || null;
}

// ---------- on posts ----------
// Checks the list a post carries ({id, alt} up to 4, all the author's own) and writes it in order.
export async function attachImages(c, postId, author, images) {
  const list = checked(images);
  for (const [pos, im] of list.entries()) {
    const [owner] = await c.query("select owner_id from images where id = $1", [im.id]);
    if (!owner) throw err(404, `image "${im.id}" not found: upload it first`);
    if (owner.owner_id !== author) throw err(403, `image "${im.id}" is not yours: attach only your own uploads`);
    await c.query("insert into post_images (post_id, image_id, pos, alt) values ($1, $2, $3, $4)", [postId, im.id, pos, im.alt]);
  }
}
function checked(images) {
  if (images == null) return [];
  if (!Array.isArray(images)) throw err(400, "images must be a list of {id, alt}");
  if (images.length > MAX_PER_POST) throw err(400, `at most ${MAX_PER_POST} images per post (yours has ${images.length})`);
  const seen = new Set();
  return images.map((im) => {
    const id = String(im?.id || "").trim();
    const alt = String(im?.alt ?? "").trim();
    if (!id) throw err(400, "each image needs an id from upload_image");
    if (!alt || alt.length > ALT_MAX) throw err(400, `each image needs alt text of 1 to ${ALT_MAX} characters describing it`);
    if (seen.has(id)) throw err(400, `image "${id}" is listed twice`);
    seen.add(id);
    return { id, alt };
  });
}
// Ids of the images on these posts, to drop afterwards if nothing else uses them.
export async function imageIdsOf(c, postIds) {
  if (!postIds.length) return [];
  return (await c.query("select distinct image_id from post_images where post_id = any($1::text[])", [postIds])).map((r) => r.image_id);
}
// Removes images that no post uses any more (only among the ones just detached).
export async function dropOrphans(c, imageIds) {
  if (!imageIds.length) return;
  await c.query("delete from images i where i.id = any($1::text[]) and not exists (select 1 from post_images pi where pi.image_id = i.id)", [imageIds]);
}
export async function replaceImages(c, postId, author, images) {
  const before = await imageIdsOf(c, [postId]);
  await c.query("delete from post_images where post_id = $1", [postId]);
  await attachImages(c, postId, author, images);
  await dropOrphans(c, before);
}

// post id → [{id, url, alt, type, width, height}] in the order attached, for the posts that have any.
export async function imagesFor(postIds) {
  const out = new Map();
  if (!postIds.length) return out;
  const rows = await q(`select pi.post_id, pi.alt, i.id, i.type, i.width, i.height from post_images pi join images i on i.id = pi.image_id
    where pi.post_id = any($1::text[]) order by pi.post_id, pi.pos`, [postIds]);
  for (const r of rows) {
    if (!out.has(r.post_id)) out.set(r.post_id, []);
    out.get(r.post_id).push({ id: r.id, url: `/i/${r.id}`, alt: r.alt, type: r.type, width: r.width, height: r.height });
  }
  return out;
}
// The posts with an images field where they have any.
export async function withImages(posts) {
  const map = await imagesFor(posts.map((p) => p.id));
  return posts.map((p) => (map.has(p.id) ? { ...p, images: map.get(p.id) } : p));
}
