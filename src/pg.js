// Minimal Postgres client: the wire protocol over node:net/node:tls, no dependencies. Simple queries
// (query(sql)), parameterised queries over the extended protocol (query(sql, params)), typed decoding of the
// common column types, transactions (tx), and a small pool. Auth: trust, password, md5, and SCRAM-SHA-256
// (what Railway and modern Postgres use). TLS when the URL asks for it or the host is not local.
import net from "node:net";
import tls from "node:tls";
import crypto from "node:crypto";

export function parseUrl(url) {
  const u = new URL(url);
  const sslmode = u.searchParams.get("sslmode") || process.env.PGSSLMODE || "";
  const host = decodeURIComponent(u.hostname);
  const local = host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".internal");
  return {
    host, port: Number(u.port || 5432),
    user: decodeURIComponent(u.username), password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.replace(/^\//, "")) || decodeURIComponent(u.username),
    ssl: sslmode ? sslmode !== "disable" : !local,
    search_path: u.searchParams.get("search_path") || "",
  };
}

const str = (s) => Buffer.concat([Buffer.from(String(s), "utf8"), Buffer.alloc(1)]);
function frame(type, ...parts) {
  const body = Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
  const head = Buffer.alloc(type ? 5 : 4);
  if (type) head.write(type, 0, "ascii");
  head.writeInt32BE(body.length + 4, type ? 1 : 0);
  return Buffer.concat([head, body]);
}
function int32(n) { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; }
function int16(n) { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; }

// Splits ErrorResponse/NoticeResponse fields into {S, C, M, ...}.
function fields(body) {
  const out = {};
  let i = 0;
  while (i < body.length && body[i] !== 0) {
    const code = String.fromCharCode(body[i]);
    const end = body.indexOf(0, i + 1);
    out[code] = body.toString("utf8", i + 1, end);
    i = end + 1;
  }
  return out;
}
const pgError = (f) => Object.assign(new Error(f.M || "postgres error"), { code: f.C, severity: f.S, detail: f.D, constraint: f.n });

export async function connect(url) {
  const cfg = parseUrl(url);
  let socket = await new Promise((resolve, reject) => {
    const s = net.connect(cfg.port, cfg.host, () => resolve(s));
    s.once("error", reject);
  });
  if (cfg.ssl) socket = await startTls(socket, cfg.host);
  const client = new Client(socket, cfg);
  await client.startup();
  return client;
}

async function startTls(socket, host) {
  socket.write(frame(null, int32(80877103)));
  const answer = await new Promise((resolve, reject) => { socket.once("data", (d) => resolve(String(d)[0])); socket.once("error", reject); });
  if (answer !== "S") throw new Error("postgres server does not accept TLS");
  return new Promise((resolve, reject) => {
    const t = tls.connect({ socket, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false }, () => resolve(t));
    t.once("error", reject);
  });
}

class Client {
  constructor(socket, cfg) {
    this.socket = socket;
    this.cfg = cfg;
    this.buf = Buffer.alloc(0);
    this.waiters = [];
    this.closed = false;
    socket.on("data", (d) => this.onData(d));
    socket.on("error", (e) => this.fail(e));
    socket.on("close", () => this.fail(new Error("postgres connection closed")));
  }

  fail(e) {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w.reject(e);
  }

  // Every complete frame goes to the oldest waiter; it says whether it wants more.
  onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 5) {
      const len = this.buf.readInt32BE(1);
      if (this.buf.length < len + 1) return;
      const type = String.fromCharCode(this.buf[0]);
      const body = this.buf.subarray(5, len + 1);
      this.buf = this.buf.subarray(len + 1);
      const w = this.waiters[0];
      if (!w) continue;
      try { if (w.onFrame(type, body) === true) { this.waiters.shift(); w.resolve(w.result()); } } catch (e) { this.waiters.shift(); w.reject(e); }
    }
  }

  // Collects frames until onFrame returns true.
  wait(onFrame, result) {
    return new Promise((resolve, reject) => this.waiters.push({ onFrame, result, resolve, reject }));
  }

  async startup() {
    const { user, database } = this.cfg;
    const params = [str("user"), str(user), str("database"), str(database), str("client_encoding"), str("UTF8"), str("TimeZone"), str("UTC"), str("DateStyle"), str("ISO")];
    if (this.cfg.search_path) params.push(str("search_path"), str(this.cfg.search_path));
    this.socket.write(frame(null, int32(196608), ...params, Buffer.alloc(1)));
    const scram = new Scram(user, this.cfg.password);
    await this.wait((type, body) => {
      if (type === "E") throw pgError(fields(body));
      if (type === "Z") return true;
      if (type !== "R") return false;
      const code = body.readInt32BE(0);
      if (code === 3) this.socket.write(frame("p", str(this.cfg.password)));
      else if (code === 5) this.socket.write(frame("p", str(md5Password(user, this.cfg.password, body.subarray(4, 8)))));
      else if (code === 10) {
        if (!body.toString("utf8", 4).split("\0").includes("SCRAM-SHA-256")) throw new Error("server offers no supported SASL mechanism");
        const first = scram.clientFirst();
        this.socket.write(frame("p", str("SCRAM-SHA-256"), int32(Buffer.byteLength(first)), Buffer.from(first)));
      } else if (code === 11) this.socket.write(frame("p", Buffer.from(scram.clientFinal(body.toString("utf8", 4)))));
      else if (code === 12) scram.verify(body.toString("utf8", 4));
      else if (code !== 0) throw new Error(`unsupported postgres auth method ${code}`);
      return false;
    }, () => undefined);
  }

  // query(sql): simple protocol, one or more statements, rows of the last result, values decoded by type.
  // query(sql, params): extended protocol, one statement with $1.. placeholders. Both resolve to an array of
  // row objects carrying a non-enumerable `count` (rows affected, from the command tag).
  query(sql, params) {
    if (this.closed) return Promise.reject(new Error("postgres connection closed"));
    let columns = [];
    let rows = [];
    let count = 0;
    let error = null;
    const p = this.wait((type, body) => {
      if (type === "T") { columns = rowDescription(body); rows = []; }
      else if (type === "D") rows.push(dataRow(body, columns));
      else if (type === "C") count = Number(body.toString("utf8").replace(/\0$/, "").split(" ").pop()) || 0;
      else if (type === "E") error = pgError(fields(body));
      else if (type === "Z") { if (error) throw error; return true; }
      return false;
    }, () => Object.defineProperty(rows, "count", { value: count, enumerable: false }));
    if (params === undefined) this.socket.write(frame("Q", str(sql)));
    else this.socket.write(Buffer.concat([
      frame("P", str(""), str(sql), int16(0)),
      frame("B", str(""), str(""), int16(0), int16(params.length), ...params.map(encode), int16(0)),
      frame("D", "P", str("")),
      frame("E", str(""), int32(0)),
      frame("S"),
    ]));
    return p;
  }

  // Runs fn(client) inside a transaction: commit on return, rollback on throw.
  async tx(fn) {
    await this.query("begin");
    try {
      const out = await fn(this);
      await this.query("commit");
      return out;
    } catch (e) {
      await this.query("rollback").catch(() => {});
      throw e;
    }
  }

  // An idle pooled connection never keeps the process alive.
  ref() { this.socket.ref(); }
  unref() { this.socket.unref(); }

  end() {
    this.closed = true;
    this.socket.write(frame("X"));
    this.socket.end();
  }
}

export const literal = (s) => "'" + String(s).replace(/'/g, "''") + "'";

// ---------- parameters ----------
// Every parameter travels as text: null, string, number, boolean, Date, Buffer (as bytea hex), array (as a
// Postgres array literal), and plain object (as JSON).
function encode(v) {
  if (v === null || v === undefined) return int32(-1);
  const t = Buffer.from(text(v), "utf8");
  return Buffer.concat([int32(t.length), t]);
}
function text(v) {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  if (typeof v === "boolean") return v ? "t" : "f";
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v)) return "\\x" + v.toString("hex");
  if (Array.isArray(v)) return "{" + v.map((x) => (x === null || x === undefined ? "NULL" : '"' + text(x).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"')).join(",") + "}";
  return JSON.stringify(v);
}

// ---------- rows ----------
function rowDescription(body) {
  const n = body.readInt16BE(0);
  const cols = [];
  let i = 2;
  for (let c = 0; c < n; c++) {
    const end = body.indexOf(0, i);
    cols.push({ name: body.toString("utf8", i, end), oid: body.readInt32BE(end + 7) });
    i = end + 1 + 18;
  }
  return cols;
}
function dataRow(body, columns) {
  const n = body.readInt16BE(0);
  const row = {};
  let i = 2;
  for (let c = 0; c < n; c++) {
    const len = body.readInt32BE(i);
    i += 4;
    row[columns[c].name] = len < 0 ? null : decode(columns[c].oid, body.toString("utf8", i, i + len));
    if (len > 0) i += len;
  }
  return row;
}
// Column types by OID: numbers, booleans, timestamps (ISO strings in UTC), json, bytea (Buffer), and text arrays; else text.
const NUMBERS = new Set([20, 21, 23, 26, 700, 701, 1700]);
const TIMES = new Set([1114, 1184]);
const ARRAYS = new Set([1009, 1015, 1005, 1007, 1016]);
export function decode(oid, s) {
  if (oid === 16) return s === "t";
  if (NUMBERS.has(oid)) return Number(s);
  if (TIMES.has(oid)) { const t = s.replace(" ", "T"); return new Date(/[+-]\d\d$/.test(t) ? t + ":00" : /[+-]\d\d:\d\d$/.test(t) ? t : t + "Z").toISOString(); }
  if (oid === 114 || oid === 3802) return JSON.parse(s);
  if (oid === 17) return Buffer.from(s.slice(2), "hex"); // bytea arrives as \x<hex>
  if (ARRAYS.has(oid)) return parseArray(s).map((x) => (x === null || oid === 1009 || oid === 1015 ? x : Number(x)));
  return s;
}
// Parses a one-dimensional Postgres array literal: {a,"b c",NULL,"q\"x"}.
export function parseArray(s) {
  const out = [];
  if (s === "{}") return out;
  let i = 1, cur = "", quoted = false, had = false;
  while (i < s.length) {
    const ch = s[i];
    if (quoted) {
      if (ch === "\\") { cur += s[i + 1]; i += 2; continue; }
      if (ch === '"') { quoted = false; i++; continue; }
      cur += ch; i++; continue;
    }
    if (ch === '"') { quoted = true; had = true; i++; continue; }
    if (ch === "," || ch === "}") { out.push(!had && cur === "NULL" ? null : cur); cur = ""; had = false; i++; continue; }
    cur += ch; i++;
  }
  return out;
}

// ---------- pool ----------
// Up to `size` connections to one URL; query/tx borrow one. A connection that failed is dropped, not reused.
export function pool(url, size = Number(process.env.PG_POOL) || 4) {
  const idle = [], waiting = [];
  let open = 0, closed = false;
  async function acquire() {
    if (closed) throw new Error("pool closed");
    const c = idle.pop();
    if (c && !c.closed) { c.ref(); return c; }
    if (c) open--;
    if (open < size) { open++; try { return await connect(url); } catch (e) { open--; throw e; } }
    return new Promise((resolve) => waiting.push(resolve));
  }
  function release(c) {
    if (c.closed || closed) { open--; if (c.closed === false) c.end(); if (waiting.length) acquire().then(waiting.shift()); return; }
    const w = waiting.shift();
    if (w) w(c); else { c.unref(); idle.push(c); }
  }
  async function withClient(fn) {
    const c = await acquire();
    try { return await fn(c); } finally { release(c); }
  }
  return {
    query: (sql, params) => withClient((c) => c.query(sql, params)),
    tx: (fn) => withClient((c) => c.tx(fn)),
    connection: withClient,
    end() { closed = true; for (const c of idle.splice(0)) c.end(); },
    get size() { return open; },
  };
}

function md5Password(user, password, salt) {
  const md5 = (...parts) => crypto.createHash("md5").update(Buffer.concat(parts.map((p) => Buffer.from(p)))).digest("hex");
  return "md5" + md5(md5(password + user), salt);
}

// SCRAM-SHA-256 (RFC 7677) client side; the server picks the user from the startup message.
class Scram {
  constructor(user, password) {
    this.password = password;
    this.nonce = crypto.randomBytes(18).toString("base64");
    this.bare = `n=,r=${this.nonce}`;
  }
  clientFirst() { return "n,," + this.bare; }
  clientFinal(serverFirst) {
    const attrs = Object.fromEntries(serverFirst.split(",").map((kv) => [kv[0], kv.slice(2)]));
    if (!attrs.r.startsWith(this.nonce)) throw new Error("scram: server nonce does not extend the client nonce");
    const salted = crypto.pbkdf2Sync(this.password, Buffer.from(attrs.s, "base64"), Number(attrs.i), 32, "sha256");
    const hmac = (key, msg) => crypto.createHmac("sha256", key).update(msg).digest();
    const clientKey = hmac(salted, "Client Key");
    const storedKey = crypto.createHash("sha256").update(clientKey).digest();
    const withoutProof = `c=biws,r=${attrs.r}`;
    const auth = `${this.bare},${serverFirst},${withoutProof}`;
    const sig = hmac(storedKey, auth);
    const proof = Buffer.from(clientKey.map((b, i) => b ^ sig[i]));
    this.serverSig = hmac(hmac(salted, "Server Key"), auth).toString("base64");
    return `${withoutProof},p=${proof.toString("base64")}`;
  }
  verify(serverFinal) {
    const v = serverFinal.split(",").find((kv) => kv.startsWith("v="))?.slice(2);
    if (v !== this.serverSig) throw new Error("scram: server signature mismatch");
  }
}
