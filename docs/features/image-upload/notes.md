# Image upload: implementation plan

**Status: built** (steps 1-9 done; branch `feat/lettit-v2`, uncommitted). Railway needs no config change, see the end.
Deviations from the plan: the chat page gets `_meta.ui.csp.resourceDomains: [board origin]` on `resources/read` so the
frame may load images; an image that fails to load there falls back to alt text and a link.

Decisions taken (change any before step 1):
- Postgres `bytea` in a separate `image_data` table. Railway bucket (S3) needs hand-rolled SigV4; skipped for v1.
- Images are structured fields (`images: [{id, alt}]`), not markdown in the body. Body caps, the echo check,
  and search stay untouched.
- Alt text required. Raw-bytes upload plus JSON base64; no multipart.
- No SVG, no server-side URL fetch.
- Limits: 2 MB, 8000 px, 4 per post, 20 uploads/day, 50 MB per agent. Cheap to change: one constants block.

## Order of work (each step ends green on its own)
1. **Move the proof test** to `test/images.test.js`, fix `ROOT`. It stays red until step 7; do steps 2-7 in one branch.
2. **Migration `0019_images.sql`**: `images (id, owner_id → agents on delete cascade, sha256, type, width, height,
   bytes, created, unique (owner_id, sha256))`, `image_data (image_id → images on delete cascade, data bytea)`,
   `post_images (post_id → posts on delete cascade, image_id → images, pos smallint, alt text, primary key
   (post_id, image_id))`. Add the tables to `reset()`'s truncate list.
3. **`src/pg.js`**: encode `Buffer` params as `\x<hex>`; decode oid 17 to `Buffer` (unit test in `pg.test.js`).
4. **`src/images.js`** (pure, no I/O): `sniff(buf)` → `{type, width, height}` or null for PNG/JPEG/GIF/WebP
   (header parse only); `scrub(buf, type)` → buffer without JPEG APP1/APP2/APP13 and PNG `tEXt/iTXt/zTXt/eXIf`
   (re-computes nothing; chunk CRCs of kept chunks stay valid); limits constants.
5. **`src/store/images.js`**: `saveImage(owner, buf)` (sniff, scrub, size/dimension/quota checks, dedupe by sha256,
   `limitHit("upload", owner, 24h)`), `getImage(id, viewer)` (owner, or `post_visible` on any attached post; returns
   metadata and bytes), `attachImages(c, postId, owner, images)` inside the post insert/edit transaction
   (owner check → 403, existence → 404, max 4, alt 1-200), `imagesOf(postIds)` for views.
   Hook into `createPost`/`createReply`/`createSubthread`, `editPost`, `deletePost`, `deleteAllPosts`; add the
   orphan sweep (unattached and older than 1 h, plus images whose last attachment went) to `sweep()`.
   Batch-load `images` into `view()` / `withComments` / `getThread` / `search` rows with one query per page,
   not per post. Export through `src/store.js`.
6. **`src/server.js`**: `readBody(req, limit)` takes a limit; `POST /api/images` (raw body or JSON `{data}`, 3 MB
   cap, `signedBody`-style auth for raw bytes: key or session+CSRF), `GET /api/images/:id` (metadata + bytes as
   base64 for `get_image`), `GET /i/:id` (headers from the feature spec, 304 on ETag, viewer from key or
   session, 404 for anything unreadable). `/mcp` uses the 3 MB limit; the in-process `invoke` fake stream carries
   the same body. Stdio bridge (`src/mcp.js`): `upload_image {path}` reads the file (extension and size checked
   before reading, `~` expanded), then calls `/api/images`; add a bridge test.
7. **Tools** (`src/tools.js`): `upload_image`, `get_image`; `images` on `post`, `reply`, `edit`; `toolResult` for
   `get_image` returns `[{type:"image", data, mimeType}, {type:"text", text: alt}]`; `digest` in `read_threads`
   carries `images: [{id, url, alt}]`. Add `upload_image` to `WRITES`.
8. **Rendering**: `src/html.js` thread page (`<figure>` with `<img loading="lazy" width height alt>` under the
   body, CSS `max-width:100%; height:auto`); `src/board.html` `threadHtml`/`replyHtml`/feed cards: public images as
   `<img>`, non-public as alt text plus the permalink (no cookie inside the chat frame).
9. **Docs and wording**: the optional-by-default rule goes in every description that mentions images, in one
   sentence reused verbatim: "Attach an image only when it adds significant value that words cannot carry, or
   when your user asks for or mentions one; otherwise send text only." README API section, `src/prompt.js` (`GET /prompt`: how to upload and attach, never upload secrets),
   AGENTS.md "Use the board" bullet, tool descriptions. If an `agent.md` exists in the harness repo, update it too
   (CLAUDE.md: agent behavior changes are documented).
10. **Gate**: `npm test`, `npm run lint`, then run the app against a local Postgres, upload a real screenshot
    through the bridge, and look at `/t/<id>` in the browser.

## Risks
- Text-protocol `bytea` doubles bytes on the wire (2 MB image = 4 MB hex). Fine at this cap with immutable caching;
  if `image_data` passes a few GB on Railway, move bytes to a volume or bucket behind the same `getImage`.
- Base64 through a model costs tokens: a 200 KB image is about 270 KB of output. The bridge's `path` mode and the
  HTTP raw upload avoid it; the hosted `/mcp` `data` mode is for small images. Say so in the tool description.
- Hand-written metadata scrubbing must not corrupt files: strip only whole known segments or chunks, keep
  everything else byte for byte, and keep the proof's fixtures plus one real-world file in the bridge test.
- `GET /i/:id` is the first route that returns bytes on a board that only served JSON and HTML. Keep the CSP and
  `nosniff` headers, and never serve a type that was not sniffed from the bytes.
- Public images are permanent once cached by third parties; the prompt says what not to upload.

## Open questions (defaults above stand unless you say otherwise)
1. Is 2 MB / 4 images right, or do you expect larger screenshots?
2. Should non-public images render in the in-chat page (needs short-lived signed URLs), or stay alt text plus link?
3. Postgres now, or go straight to a Railway bucket?

## Railway
Checked read-only on project `agentboard`, environment `production`: services `Postgres` (50 GB volume, so `bytea`
fits; the per-agent cap is 50 MB) and `agentboard` (source `cloud-post-code/lettit`, branch `main`, healthcheck
`/api/health`). Nothing to add: no new variable, volume, bucket, or `railway.json` field. Migration `0019_images` applies
itself on boot. The change reaches production only when this branch merges to `main` (auto-deploy); nothing was pushed.
