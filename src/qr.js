// Zero-dependency QR encoder: byte mode, error correction level M, versions 1 to 10 (up to 213 bytes).
// Output is a module grid or an inline SVG. Implements ISO/IEC 18004; the structure mirrors the reference
// encoder by Project Nayuki, rewritten for this repo.

// ---------- GF(256) and Reed-Solomon ----------
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

function generator(n) {
  let g = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) { next[j] ^= g[j]; next[j + 1] ^= mul(g[j], EXP[i]); }
    g = next;
  }
  return g;
}

export function ecCodewords(data, n) {
  const g = generator(n);
  const buf = [...data, ...new Array(n).fill(0)];
  for (let i = 0; i < data.length; i++) {
    const c = buf[i];
    if (c) for (let j = 0; j < g.length; j++) buf[i + j] ^= mul(g[j], c);
  }
  return buf.slice(data.length);
}

// ---------- version tables (level M) ----------
// version: [ec codewords per block, [[blocks, data codewords per block], ...]]
export const EC = {
  1: [10, [[1, 16]]], 2: [16, [[1, 28]]], 3: [26, [[1, 44]]], 4: [18, [[2, 32]]], 5: [24, [[2, 43]]],
  6: [16, [[4, 27]]], 7: [18, [[4, 31]]], 8: [22, [[2, 38], [2, 39]]], 9: [22, [[3, 36], [2, 37]]], 10: [26, [[4, 43], [1, 44]]],
};
const ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };
export const MAX_VERSION = 10;
const dataCodewords = (v) => EC[v][1].reduce((n, [count, per]) => n + count * per, 0);
const countBits = (v) => (v < 10 ? 8 : 16);
export const capacity = (v) => Math.floor((dataCodewords(v) * 8 - 4 - countBits(v)) / 8);
export const sizeOf = (v) => 17 + 4 * v;

// ---------- bit assembly ----------
function dataBits(bytes, v) {
  const bits = [];
  const push = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  push(4, 4);
  push(bytes.length, countBits(v));
  for (const b of bytes) push(b, 8);
  const total = dataCodewords(v) * 8;
  push(0, Math.min(4, total - bits.length));
  while (bits.length % 8) bits.push(0);
  for (let pad = 0xec; bits.length < total; pad ^= 0xec ^ 0x11) push(pad, 8);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8).join(""), 2));
  return out;
}

// Split into blocks, add EC to each, interleave data then EC.
function codewords(data, v) {
  const [ecPer, groups] = EC[v];
  const blocks = [];
  let at = 0;
  for (const [count, per] of groups) for (let i = 0; i < count; i++) { blocks.push(data.slice(at, at + per)); at += per; }
  const ecs = blocks.map((b) => ecCodewords(b, ecPer));
  const out = [];
  const longest = Math.max(...blocks.map((b) => b.length));
  for (let i = 0; i < longest; i++) for (const b of blocks) if (i < b.length) out.push(b[i]);
  for (let i = 0; i < ecPer; i++) for (const e of ecs) out.push(e[i]);
  return out;
}

// ---------- matrix ----------
const grid = (size, fill = 0) => Array.from({ length: size }, () => new Array(size).fill(fill));

// Function patterns for a version: finders, separators, timing, alignment, dark module, and the reserved
// format and version areas. Returns {modules, isFunction}.
export function layout(v) {
  const size = sizeOf(v);
  const modules = grid(size), isFunction = grid(size);
  const set = (x, y, dark) => { modules[y][x] = dark ? 1 : 0; isFunction[y][x] = 1; };
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  const finder = (cx, cy) => { for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const x = cx + dx, y = cy + dy; if (x >= 0 && y >= 0 && x < size && y < size) { const d = Math.max(Math.abs(dx), Math.abs(dy)); set(x, y, d !== 2 && d !== 4); } } };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  const al = ALIGN[v];
  for (let i = 0; i < al.length; i++) for (let j = 0; j < al.length; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  drawFormat(modules, isFunction, size, 0);
  drawVersion(modules, isFunction, size, v);
  return { size, modules, isFunction };
}

// Format information: (level M = 00) << 3 | mask, BCH(15,5), XOR mask 0x5412, drawn twice.
export function formatBits(mask) {
  const data = (0 << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}
function drawFormat(modules, isFunction, size, mask) {
  const bits = formatBits(mask);
  const bit = (i) => (bits >>> i) & 1;
  const set = (x, y, dark) => { modules[y][x] = dark ? 1 : 0; isFunction[y][x] = 1; };
  for (let i = 0; i <= 5; i++) set(8, i, bit(i));
  set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
  set(8, size - 8, 1);
}

// Version information for versions 7 and up: 6 data bits plus BCH(18,6) remainder, drawn twice.
export function versionBits(v) {
  let rem = v;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (v << 12) | rem;
}
function drawVersion(modules, isFunction, size, v) {
  if (v < 7) return;
  const bits = versionBits(v);
  for (let i = 0; i < 18; i++) {
    const dark = (bits >>> i) & 1, a = size - 11 + (i % 3), b = Math.floor(i / 3);
    modules[b][a] = dark; isFunction[b][a] = 1;
    modules[a][b] = dark; isFunction[a][b] = 1;
  }
}

// Zigzag placement of codeword bits into the non-function modules, two columns at a time, skipping column 6.
export function place(modules, isFunction, size, bytes) {
  let i = 0;
  const total = bytes.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunction[y][x]) {
          modules[y][x] = i < total ? (bytes[i >>> 3] >>> (7 - (i & 7))) & 1 : 0;
          i++;
        }
      }
    }
  }
}

export const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];
function applyMask(modules, isFunction, size, mask) {
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!isFunction[y][x] && MASKS[mask](x, y)) modules[y][x] ^= 1;
}

// Penalty score per the standard: runs, 2x2 blocks, finder-like patterns, dark balance.
function penalty(modules, size) {
  let score = 0;
  const line = (get) => {
    let run = 1;
    for (let i = 1; i < size; i++) {
      if (get(i) === get(i - 1)) { run++; if (i === size - 1 && run >= 5) score += run - 2; } else { if (run >= 5) score += run - 2; run = 1; }
    }
    const s = "0000" + Array.from({ length: size }, (_, i) => get(i)).join("") + "0000";
    for (let i = 0; i + 11 <= s.length; i++) { const w = s.slice(i, i + 11); if (w === "10111010000" || w === "00001011101") score += 40; }
  };
  for (let y = 0; y < size; y++) line((x) => modules[y][x]);
  for (let x = 0; x < size; x++) line((y) => modules[y][x]);
  for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
    const c = modules[y][x];
    if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) score += 3;
  }
  let dark = 0;
  for (const row of modules) for (const m of row) dark += m;
  const total = size * size;
  score += 10 * (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1);
  return score;
}

// ---------- public API ----------
export function encode(text) {
  const bytes = [...new TextEncoder().encode(String(text))];
  let v = 1;
  while (v <= MAX_VERSION && capacity(v) < bytes.length) v++;
  if (v > MAX_VERSION) throw new Error(`QR payload too long: ${bytes.length} bytes, maximum ${capacity(MAX_VERSION)}`);
  const words = codewords(dataBits(bytes, v), v);
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const { size, modules, isFunction } = layout(v);
    place(modules, isFunction, size, words);
    applyMask(modules, isFunction, size, mask);
    drawFormat(modules, isFunction, size, mask);
    const score = penalty(modules, size);
    if (!best || score < best.score) best = { score, modules, size, mask };
  }
  return { version: v, size: best.size, mask: best.mask, modules: best.modules };
}

// Inline SVG with a quiet zone, a title for accessibility, and crisp edges at any size.
export function svg(text, { scale = 4, margin = 4, title = text } = {}) {
  const { size, modules } = encode(text);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const dim = size + margin * 2;
  let d = "";
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (modules[y][x]) d += `M${x + margin} ${y + margin}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${dim * scale}" height="${dim * scale}" shape-rendering="crispEdges" role="img" aria-label="QR code: ${esc(title)}"><title>${esc(title)}</title><rect width="${dim}" height="${dim}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
