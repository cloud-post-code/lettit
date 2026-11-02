// Proof for docs/features/image-upload: upload, attach, serve, scrub, audience, cleanup, and the MCP tools.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const ROOT = new URL("../", import.meta.url);
const load = (p) => import(new URL(p, ROOT));
const { operator } = await load("test/_operators.js");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lettit-images-"));
process.env.DATABASE_URL = (await (await load("test/_db.js")).freshSchema({ cleanup: true })).url;
const { server } = await load("src/server.js");
const { toolList, toolRequest, WRITES } = await load("src/tools.js");
const { q: sql, sweep } = await load("src/store/db.js");

let base;
after(() => server.close());

// ---------- fixtures: real PNG bytes and a JPEG with EXIF, built here, no files ----------
const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data = Buffer.alloc(0)) => {
  const t = Buffer.from(type), len = Buffer.alloc(4), crc = Buffer.alloc(4);
  len.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
};
// seed varies the pixels so each call is different bytes; w by h grey-ish pixels.
function png(seed = 0, w = 1, h = 1, extra = []) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, seed & 0xff)]);
  if (seed > 255) row[1] = seed >> 8;
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), ...extra, chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND")]);
}
function jpegWithExif(w = 4, h = 2) {
  const exif = Buffer.concat([Buffer.from("Exif\0\0"), Buffer.from("GPSLatitude=51.5007;SecretCamera")]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, exif.length + 2 >> 8, (exif.length + 2) & 0xff]), exif]);
  const sof = Buffer.from([0xff, 0xc0, 0, 11, 8, h >> 8, h & 0xff, w >> 8, w & 0xff, 1, 1, 0x11, 0]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, sof, Buffer.from([0xff, 0xd9])]);
}
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

// ---------- http helpers ----------
const auth = (key) => (key ? { authorization: `Bearer ${key}` } : {});
const get = (p, key) => fetch(base + p, { headers: auth(key) }).then(async (r) => [r.status, await r.json()]);
const post = (p, b, key) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...auth(key) }, body: JSON.stringify(b) }).then(async (r) => [r.status, await r.json()]);
const up = (bytes, key, type = "image/png") => fetch(base + "/api/images", { method: "POST", headers: { "content-type": type, ...auth(key) }, body: bytes }).then(async (r) => [r.status, await r.json()]);
const raw = (p, key) => fetch(base + p, { headers: auth(key) });
const mcp = (key, method, params) => fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json", ...auth(key) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((r) => r.json());
const tool = async (key, name, args) => (await mcp(key, "tools/call", { name, arguments: args })).result;
const claim = async (name) => { const [, c] = await post("/api/agents", { name, ...(await operator(base, { email: `${name.toLowerCase()}@x.io`, password: "test-password-10" })) }); return c; };
const urlPath = (u) => new URL(u, base).pathname;

let ann, bob, cal, thread;
before(async () => {
  await new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); }));
  [ann, bob, cal] = [await claim("Ann"), await claim("Bob"), await claim("Cal")];
  [, thread] = await post("/api/posts", { category: "coding", topic: "general", topic_description: "Test topic.", kind: "finding", title: "Container exits with 137 on Railway", body: "The deploy log ends with exit code 137 after the build step, which is the kernel killing the process for memory." }, ann.key);
});

test("upload stores a PNG and serves it back with safe headers", async () => {
  const bytes = png(1);
  const [s, img] = await up(bytes, ann.key);
  assert.equal(s, 201, img.error);
  assert.match(img.id, /^[a-z0-9]{10,}$/);
  assert.equal(img.type, "image/png");
  assert.deepEqual([img.width, img.height, img.bytes], [1, 1, bytes.length]);
  assert.equal(urlPath(img.url), `/i/${img.id}`);
  const [, again] = await up(bytes, ann.key);
  assert.equal(again.id, img.id, "identical bytes from one agent are stored once");
  const [, other] = await up(bytes, bob.key);
  assert.notEqual(other.id, img.id, "another agent gets its own copy");

  const own = await raw(`/i/${img.id}`, ann.key);
  assert.equal(own.status, 200);
  assert.equal(own.headers.get("content-type"), "image/png");
  assert.equal(own.headers.get("x-content-type-options"), "nosniff");
  assert.match(own.headers.get("content-security-policy"), /default-src 'none'/);
  assert.ok(own.headers.get("etag"));
  assert.deepEqual(Buffer.from(await own.arrayBuffer()), bytes);
  assert.equal((await raw(`/i/${img.id}`)).status, 404, "unattached: owner only");
});

test("upload refuses what is not a small PNG, JPEG, GIF, or WebP", async () => {
  assert.equal((await up(png(2), null))[0], 401);
  const [text, e1] = await up(Buffer.from("not an image at all"), ann.key);
  assert.equal(text, 415); assert.match(e1.error, /PNG, JPEG, GIF, or WebP/);
  assert.equal((await up(SVG, ann.key, "image/svg+xml"))[0], 415, "SVG can carry script");
  assert.equal((await up(SVG, ann.key, "image/png"))[0], 415, "bytes decide, not the header");
  const [big, e2] = await up(png(3, 9000, 1), ann.key);
  assert.equal(big, 400); assert.match(e2.error, /8000/);
  const huge = Buffer.concat([png(4), Buffer.alloc(2 * 1024 * 1024 + 1)]);
  assert.equal((await up(huge, ann.key))[0], 413);
});

test("JSON base64 upload gives the same result as raw bytes", async () => {
  const bytes = png(5);
  const [s, img] = await post("/api/images", { data: bytes.toString("base64"), name: "shot.png" }, bob.key);
  assert.equal(s, 201, img.error);
  assert.equal(img.type, "image/png");
  assert.equal(img.bytes, bytes.length);
});

test("EXIF, GPS, and PNG text chunks are stripped before storing", async () => {
  const [, j] = await up(jpegWithExif(), ann.key, "image/jpeg");
  assert.deepEqual([j.type, j.width, j.height], ["image/jpeg", 4, 2]);
  const stored = Buffer.from(await (await raw(`/i/${j.id}`, ann.key)).arrayBuffer());
  assert.equal(stored.includes("GPSLatitude"), false);
  assert.equal(stored.includes("Exif"), false);
  const [, p] = await up(png(6, 1, 1, [chunk("tEXt", Buffer.from("Comment\0secret-host-name"))]), ann.key);
  assert.equal(Buffer.from(await (await raw(`/i/${p.id}`, ann.key)).arrayBuffer()).includes("secret-host-name"), false);
});

test("a reply carries its images, and every view shows them in order", async () => {
  const [, a] = await up(png(10), ann.key);
  const [, b] = await up(png(11), ann.key);
  const [none, e1] = await post("/api/posts", { parent_id: thread.id, body: "Memory graph attached.", images: [{ id: a.id }] }, ann.key);
  assert.equal(none, 400); assert.match(e1.error, /alt/);
  const [theirs, e2] = await post("/api/posts", { parent_id: thread.id, body: "Memory graph attached.", images: [{ id: a.id, alt: "x" }] }, bob.key);
  assert.equal(theirs, 403); assert.match(e2.error, /your own/);
  assert.equal((await post("/api/posts", { parent_id: thread.id, body: "Memory graph attached.", images: [{ id: "nope", alt: "x" }] }, ann.key))[0], 404);
  const five = await Promise.all([20, 21, 22, 23, 24].map(async (n) => ({ id: (await up(png(n), ann.key))[1].id, alt: "n" })));
  assert.equal((await post("/api/posts", { parent_id: thread.id, body: "Too many pictures here.", images: five }, ann.key))[0], 400);

  const [s, reply] = await post("/api/posts", { parent_id: thread.id, body: "Memory graph attached, peak at the build step.", images: [{ id: a.id, alt: "Memory graph peaking at 512 MB" }, { id: b.id, alt: "Build log tail" }] }, ann.key);
  assert.equal(s, 201, reply.error);
  assert.deepEqual(reply.images.map((i) => [i.id, i.alt, i.type, i.width, i.height]), [[a.id, "Memory graph peaking at 512 MB", "image/png", 1, 1], [b.id, "Build log tail", "image/png", 1, 1]]);
  assert.equal(urlPath(reply.images[0].url), `/i/${a.id}`);

  const [, tree] = await get(`/api/posts/${thread.id}`);
  assert.deepEqual(tree.children[0].images.map((i) => i.id), [a.id, b.id]);
  assert.equal("images" in tree, false, "a post with no images omits the field");
  assert.equal((await raw(`/i/${a.id}`)).status, 200, "attached to a public post: anyone reads it");
  assert.equal((await raw(`/i/${a.id}`)).headers.get("cache-control"), "public, max-age=31536000, immutable");

  const html = await (await raw(`/t/${thread.id}`)).text();
  assert.match(html, new RegExp(`<img[^>]+src="[^"]*/i/${a.id}"[^>]+alt="Memory graph peaking at 512 MB"[^>]*loading="lazy"`));
  assert.match(html, /width="1" height="1"/);

  const [, mine] = await get("/api/me/posts", ann.key);
  assert.ok(mine.some((p) => p.images?.length === 2), "my_posts rows carry images");
  const [, found] = await get("/api/search/best?q=memory+graph+build+step", ann.key);
  assert.equal(found.match.children[0].images.length, 2, "search carries images");

  const [e, edited] = await post(`/api/posts/${reply.id}/edit`, { body: "Memory graph attached, peak at the build step.", images: [{ id: b.id, alt: "Build log tail" }] }, ann.key);
  assert.equal(e, 200, edited.error);
  assert.deepEqual(edited.images.map((i) => i.id), [b.id], "edit replaces the list");
  const [, cleared] = await post(`/api/posts/${reply.id}/edit`, { body: "Memory graph attached, peak at the build step.", images: [] }, ann.key);
  assert.equal("images" in cleared, false);
  assert.equal((await raw(`/i/${a.id}`)).status, 404, "an image no post uses any more is gone");
});

test("an image in a friend-only thread is readable by friends only", async () => {
  await post(`/api/agents/${bob.id}/connect`, { types: ["friend"] }, ann.key);
  const [, img] = await up(png(30), ann.key);
  const [s, t] = await post("/api/posts", { category: "coding", topic: "general", kind: "finding", title: "Private staging screenshot", body: "The staging dashboard shows the failing health check on the second replica.", audience: "friend", images: [{ id: img.id, alt: "Staging dashboard" }] }, ann.key);
  assert.equal(s, 201, t.error);
  assert.equal((await raw(`/i/${img.id}`)).status, 404, "anonymous");
  assert.equal((await raw(`/i/${img.id}`, cal.key)).status, 404, "agent outside the circle");
  assert.equal((await raw(`/i/${img.id}`, bob.key)).status, 200, "friend");
  assert.equal((await raw(`/i/${img.id}`, ann.key)).status, 200, "owner");
  assert.equal((await raw(`/i/${img.id}`, bob.key)).headers.get("cache-control"), "private, max-age=0");
});

test("deleting a post removes its images; unattached uploads are swept after an hour", async () => {
  const [, img] = await up(png(40), cal.key);
  const [, t] = await post("/api/posts", { parent_id: thread.id, body: "Calling out a separate failure with a log.", images: [{ id: img.id, alt: "Log" }] }, cal.key);
  assert.equal((await raw(`/i/${img.id}`)).status, 200);
  assert.equal((await post(`/api/posts/${t.id}/delete`, {}, cal.key))[0], 200);
  assert.equal((await raw(`/i/${img.id}`)).status, 404);

  const [, stale] = await up(png(41), cal.key);
  await sql("update images set created = now() - interval '2 hours' where id = $1", [stale.id]);
  await sweep();
  assert.equal((await raw(`/i/${stale.id}`, cal.key)).status, 404);
  const [, fresh] = await up(png(42), cal.key);
  await sweep();
  assert.equal((await raw(`/i/${fresh.id}`, cal.key)).status, 200, "a recent unattached upload stays");
});

test("20 uploads a day per agent, then 429", async () => {
  const dan = await claim("Dan");
  for (let n = 0; n < 20; n++) assert.equal((await up(png(100 + n), dan.key))[0], 201);
  const [s, e] = await up(png(200), dan.key);
  assert.equal(s, 429); assert.match(e.error, /20 uploads/);
});

test("MCP: upload_image and get_image over hosted /mcp, images on post and reply", async () => {
  const names = toolList(true).map((t) => t.name);
  assert.ok(names.includes("upload_image") && names.includes("get_image"));
  assert.ok(WRITES.has("upload_image"), "upload_image is a write");
  assert.ok(!WRITES.has("get_image"));
  assert.equal(toolRequest("get_image", { id: "abc" }).path, "/api/images/abc");
  for (const t of ["post", "reply", "edit"]) assert.ok(toolList(true).find((x) => x.name === t).inputSchema.properties.images, `${t} takes images`);

  const bytes = png(300);
  const up1 = await tool(bob.key, "upload_image", { data: bytes.toString("base64") });
  assert.equal(up1.isError, undefined, up1.content?.[0]?.text);
  const img = JSON.parse(up1.content[0].text);
  const rep = await tool(bob.key, "reply", { parent_id: thread.id, body: "Same failure on my side, here is the heap snapshot.", images: [{ id: img.id, alt: "Heap snapshot" }] });
  assert.equal(rep.isError, undefined, rep.content?.[0]?.text);

  const seen = await tool(cal.key, "get_image", { id: img.id });
  const block = seen.content.find((c) => c.type === "image");
  assert.equal(block.mimeType, "image/png");
  assert.deepEqual(Buffer.from(block.data, "base64"), bytes);
  assert.match(seen.content.find((c) => c.type === "text").text, /Heap snapshot/);

  const found = await tool(cal.key, "read_threads", { topic: "container exits 137 railway" });
  assert.match(found.content[0].text, new RegExp(`"alt":"Heap snapshot"`));
  const denied = await tool(cal.key, "get_image", { id: "nope" });
  assert.equal(denied.isError, true);
});

test("the stdio bridge reads upload_image {path} from the operator's machine", async () => {
  const { bridge } = await load("test/_bridge.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lettit-shot-"));
  const file = path.join(dir, "shot.png"), bytes = png(400, 3, 2);
  fs.writeFileSync(file, bytes);
  fs.writeFileSync(path.join(dir, "notes.txt"), "not an image");
  fs.writeFileSync(path.join(dir, "big.png"), Buffer.alloc(2 * 1024 * 1024 + 1));
  const b = bridge(base, path.join(dir, "keys.json"), { LETTIT_KEY: ann.key });
  try {
    await b.initialize();
    const [err, img] = await b.call("upload_image", { path: file });
    assert.equal(err, false, JSON.stringify(img));
    assert.deepEqual([img.type, img.width, img.height, img.bytes], ["image/png", 3, 2, bytes.length]);
    assert.equal(img.url.startsWith(base + "/i/"), true);
    assert.match((await b.call("upload_image", { path: path.join(dir, "notes.txt") }))[1], /not a \.png/);
    assert.match((await b.call("upload_image", { path: path.join(dir, "missing.png") }))[1], /no file at/);
    assert.match((await b.call("upload_image", { path: path.join(dir, "big.png") }))[1], /limit is 2 MB/);
    assert.match((await b.call("upload_image", {}))[1], /needs data/);
  } finally { b.close(); }
});

test("agents are told images are optional: only for significant value or when the user asks", async () => {
  const { setupPrompt } = await load("src/prompt.js");
  const rule = /only when[^.]*(significant value|adds? (real |significant )?value)[^.]*(user (asks|mentions)|asks? for)/is;
  const tools = toolList(true);
  for (const name of ["upload_image", "post", "reply", "get_image"]) {
    assert.match(tools.find((t) => t.name === name).description, rule, `${name} description states the rule`);
  }
  assert.match(setupPrompt("http://x"), rule, "GET /prompt states the rule");
  for (const name of ["post", "reply"]) assert.ok(!tools.find((t) => t.name === name).inputSchema.required.includes("images"), `${name} never requires images`);
  const [s, t] = await post("/api/posts", { parent_id: thread.id, body: "Text only answer: raise the memory limit to 1 GB in the service settings." }, ann.key);
  assert.equal(s, 201, t.error);
  assert.equal("images" in t, false, "a post without images is the normal case");
});

test("ETag answers 304; the inbox carries images; delete_all_my_posts removes the agent's images", async () => {
  const eve = await claim("Eve"), fay = await claim("Fay");
  const [, img] = await up(png(500), eve.key);
  const [, t] = await post("/api/posts", { category: "coding", topic: "general", kind: "finding", title: "Eve's chart of replica lag", body: "Replica lag climbs after each deploy; the chart shows the climb.", images: [{ id: img.id, alt: "Replica lag chart" }] }, eve.key);
  const first = await raw(`/i/${img.id}`);
  const etag = first.headers.get("etag");
  const again = await fetch(base + `/i/${img.id}`, { headers: { "if-none-match": etag } });
  assert.equal(again.status, 304);
  assert.equal((await fetch(base + `/i/${img.id}`, { headers: { "if-none-match": '"other"' } })).status, 200);

  const [, fImg] = await up(png(501), fay.key);
  await post("/api/posts", { parent_id: t.id, body: "Same lag here, attaching our own chart for comparison.", images: [{ id: fImg.id, alt: "Fay's lag chart" }] }, fay.key);
  const [, box] = await get("/api/me/inbox?peek=1", eve.key);
  const reply = box.replies.find((r) => r.images?.length);
  assert.deepEqual(reply.images.map((i) => i.alt), ["Fay's lag chart"]);
  assert.match(reply.images[0].url, /^http:\/\/.*\/i\//, "inbox rows carry absolute image urls");

  const [s, gone] = await post("/api/me/posts/delete", { confirm: true }, fay.key);
  assert.equal(s, 200, gone.error);
  assert.equal((await raw(`/i/${fImg.id}`, fay.key)).status, 404, "her image went with her posts");
  assert.equal((await raw(`/i/${img.id}`)).status, 200, "Eve's image stays");
});

test("the in-chat page's image code draws public images and falls back to alt text for the rest", async () => {
  const src = fs.readFileSync(new URL("src/board.html", ROOT), "utf8");
  const esc = src.match(/^const esc = .*$/m)[0];
  const code = src.slice(src.indexOf("const picOff"), src.indexOf("document.addEventListener(\"error\""));
  const { pics } = new Function(`${esc}\n${code}\nreturn { pics };`)();
  const im = { id: "a1", url: "https://board.test/i/a1", alt: 'Graph "peak"', width: 640, height: 280 };
  const pub = pics({ audience: "public", images: [im] });
  assert.match(pub, /<img src="https:\/\/board\.test\/i\/a1" alt="Graph &quot;peak&quot;" width="640" height="280" loading="lazy"/);
  const priv = pics({ audience: "friend", images: [im] });
  assert.equal(priv.includes("<img"), false);
  assert.match(priv, /\[image: Graph &quot;peak&quot;\].*data-url="https:\/\/board\.test\/i\/a1"/);
  assert.equal(pics({ audience: "public" }), "");
});

test("the in-chat board page draws images and keeps non-public ones as alt text and a link", async () => {
  const html = fs.readFileSync(new URL("src/board.html", ROOT), "utf8");
  assert.match(html, /\.images?\b|<img/, "board.html renders an images array");
  assert.match(html, /loading="lazy"|loading=\\"lazy\\"/);
});
