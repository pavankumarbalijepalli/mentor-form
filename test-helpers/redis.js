// Test harness: a real redis-server behind a tiny Upstash-style REST endpoint
// (POST a JSON command array, get { result } back), so the API handlers and
// their Lua scripts run unmodified. Tests skip when redis-server isn't installed.
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { Readable } from "node:stream";

export const hasRedis = spawnSync("redis-server", ["--version"]).status === 0;

function encode(cmd) {
  return `*${cmd.length}\r\n` + cmd.map((a) => { const s = String(a); return `$${Buffer.byteLength(s)}\r\n${s}\r\n`; }).join("");
}

// Parse one RESP reply starting at `pos`; null if the buffer is incomplete.
function parse(buf, pos = 0) {
  const eol = buf.indexOf("\r\n", pos);
  if (eol < 0) return null;
  const type = buf[pos];
  const line = buf.toString("utf8", pos + 1, eol);
  const next = eol + 2;
  if (type === 43) return [line, next];                       // +
  if (type === 45) return [{ error: line }, next];            // -
  if (type === 58) return [Number(line), next];               // :
  if (type === 36) {                                          // $
    const len = Number(line);
    if (len < 0) return [null, next];
    if (buf.length < next + len + 2) return null;
    return [buf.toString("utf8", next, next + len), next + len + 2];
  }
  if (type === 42) {                                          // *
    const n = Number(line);
    const out = [];
    let p = next;
    for (let i = 0; i < n; i++) {
      const r = parse(buf, p);
      if (!r) return null;
      out.push(r[0]); p = r[1];
    }
    return [out, p];
  }
  throw new Error("bad RESP");
}

function run(port, cmd) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1");
    let buf = Buffer.alloc(0);
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      const r = parse(buf);
      if (r) { sock.end(); resolve(r[0]); }
    });
    sock.on("error", reject);
    sock.write(encode(cmd));
  });
}

export async function startRedis() {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const proc = spawn("redis-server", ["--port", String(port), "--save", "", "--appendonly", "no"], { stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    try { await run(port, ["PING"]); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const r = await run(port, JSON.parse(body));
      res.setHeader("Content-Type", "application/json");
      if (r && r.error) { res.statusCode = 400; res.end(JSON.stringify({ error: r.error })); }
      else res.end(JSON.stringify({ result: r }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  process.env.UPSTASH_REDIS_REST_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.UPSTASH_REDIS_REST_TOKEN = "test";
  return {
    cmd: (c) => run(port, c),
    stop: () => { server.close(); proc.kill(); },
  };
}

// Minimal stand-ins for Vercel's req/res. Pass `raw` to deliver the body as an
// unparsed stream (what the webhook needs), otherwise `body` is already-parsed JSON.
export function call(handler, { method = "GET", body, raw, query = {}, headers = {} } = {}) {
  return new Promise((resolve) => {
    const res = {
      headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      status(code) { this.code = code; return this; },
      json(payload) { resolve({ status: this.code, body: payload, headers: this.headers }); },
    };
    const req = raw === undefined ? { method, body, query, headers } : Object.assign(Readable.from([Buffer.from(raw)]), { method, query, headers });
    Promise.resolve(handler(req, res)).catch((e) => resolve({ status: 500, error: e }));
  });
}
