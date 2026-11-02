// Pure image handling, no I/O: recognise PNG, JPEG, GIF, and WebP from their bytes (never from a header or a file
// name), read the pixel size, and cut the metadata segments that can carry a location or a camera.
export const MAX_BYTES = 2 * 1024 * 1024;
export const MAX_DIM = 8000;
export const MAX_PER_POST = 4;
export const DAILY_UPLOADS = 20;
export const STORE_CAP = 50 * 1024 * 1024;
export const ALT_MAX = 200;
export const TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ascii = (b, from, to) => b.toString("latin1", from, to);

// {type, width, height}, or null when the bytes are not one of the four formats or the header is cut short.
export function sniff(b) {
  if (!Buffer.isBuffer(b)) return null;
  if (b.length >= 33 && b.subarray(0, 8).equals(PNG_SIG) && ascii(b, 12, 16) === "IHDR") return size("image/png", b.readUInt32BE(16), b.readUInt32BE(20));
  if (b.length >= 10 && (ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a")) return size("image/gif", b.readUInt16LE(6), b.readUInt16LE(8));
  if (b.length >= 30 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") return webp(b);
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return jpeg(b);
  return null;
}
const size = (type, width, height) => (width > 0 && height > 0 ? { type, width, height } : null);

function webp(b) {
  const kind = ascii(b, 12, 16);
  if (kind === "VP8X") return size("image/webp", 1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3));
  if (kind === "VP8 " && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return size("image/webp", b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff);
  if (kind === "VP8L" && b[20] === 0x2f) return size("image/webp", 1 + (b[21] | ((b[22] & 0x3f) << 8)), 1 + ((b[22] >> 6) | (b[23] << 2) | ((b[24] & 0x0f) << 10)));
  return null;
}

// Walks JPEG segments to the first start-of-frame; the pixel size is in it.
function jpeg(b) {
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m === 0xd9 || m === 0xda) return null;
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) { i += 2; continue; }
    const len = b.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > b.length) return null;
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return len >= 8 ? size("image/jpeg", b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)) : null;
    i += 2 + len;
  }
  return null;
}

// The same image without EXIF, XMP, IPTC, or text chunks; every other byte is kept as it was. Null when the
// structure is broken (a segment or chunk runs past the end).
export function scrub(b, type) {
  if (type === "image/jpeg") return scrubJpeg(b);
  if (type === "image/png") return scrubPng(b);
  return b;
}
const JPEG_DROP = new Set([0xe1, 0xe2, 0xed]); // APP1 (EXIF, XMP), APP2 (ICC, FlashPix), APP13 (IPTC)
function scrubJpeg(b) {
  const out = [b.subarray(0, 2)];
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m === 0xd9 || m === 0xda) { out.push(b.subarray(i)); return Buffer.concat(out); } // from the scan on, copy as is
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) { out.push(b.subarray(i, i + 2)); i += 2; continue; }
    if (i + 4 > b.length) return null;
    const end = i + 2 + b.readUInt16BE(i + 2);
    if (end > b.length || end < i + 4) return null;
    if (!JPEG_DROP.has(m)) out.push(b.subarray(i, end));
    i = end;
  }
  return null;
}
const PNG_DROP = new Set(["tEXt", "iTXt", "zTXt", "eXIf"]);
function scrubPng(b) {
  const out = [b.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= b.length) {
    const end = i + 12 + b.readUInt32BE(i);
    if (end > b.length) return null;
    const name = ascii(b, i + 4, i + 8);
    if (!PNG_DROP.has(name)) out.push(b.subarray(i, end));
    i = end;
    if (name === "IEND") return Buffer.concat(out);
  }
  return null;
}
