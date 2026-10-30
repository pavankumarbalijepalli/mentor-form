// Shared helpers for the API functions. Files starting with "_" are not
// exposed as endpoints by Vercel.
//
// Redis schema
//   slots    (hash)  field "date|time" -> one of
//                      "hold:<id>:<expiresAtMs>"  reserved while the person pays
//                      "booked:<id>"              person says they've paid
//                      "true"                     legacy value from the first version
//   bookings (hash)  field <id> -> JSON booking record, with `status`:
//                      held -> pending_review -> confirmed
//                      and released | cancelled when the slot is given back
//   rl:<scope>:<ip>  rate-limit counters (expire on their own)

import { CONFIG } from "./_config.js";

// ---------- Redis (Upstash REST) ----------

export async function redis(command) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error("UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are not set");
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(8000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    throw new Error(`Redis ${command[0]} failed: ${data.error || res.status}`);
  }
  return data.result;
}

const evalLua = (script, keys, args) =>
  redis(["EVAL", script, keys.length, ...keys, ...args.map(String)]);

// ---------- Slot values ----------

export const slotField = (date, time) => `${date}|${time}`;

// 'free' | 'held' | 'booked' — an expired hold counts as free.
export function slotState(value, nowMs) {
  if (value == null) return "free";
  const hold = /^hold:[^:]+:(\d+)$/.exec(value);
  if (hold) return Number(hold[1]) > nowMs ? "held" : "free";
  return "booked";
}

// ---------- Atomic operations (Lua runs as one step, so no races) ----------

// Reserve a slot and write its booking record together, unless someone holds it.
const CLAIM = `
local cur = redis.call('HGET', KEYS[1], ARGV[1])
if cur then
  local exp = string.match(cur, '^hold:[^:]+:(%d+)$')
  if not exp or tonumber(exp) > tonumber(ARGV[3]) then return 0 end
end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('HSET', KEYS[2], ARGV[4], ARGV[5])
return 1
`;

// The person says they've paid: turn their hold into a booking. Still works
// after the hold has expired as long as nobody else took the slot meanwhile.
const CONFIRM = `
local rec = redis.call('HGET', KEYS[2], ARGV[1])
if not rec then return 'not_found' end
local b = cjson.decode(rec)
if b.status == 'pending_review' or b.status == 'confirmed' then return 'ok' end
if b.status ~= 'held' then return 'gone' end
local field = b.date .. '|' .. b.time
local cur = redis.call('HGET', KEYS[1], field)
local mine = 'hold:' .. ARGV[1] .. ':'
if cur and string.sub(cur, 1, #mine) ~= mine then return 'taken' end
redis.call('HSET', KEYS[1], field, 'booked:' .. ARGV[1])
b.status = 'pending_review'
b.paidClaimedAt = ARGV[2]
redis.call('HSET', KEYS[2], ARGV[1], cjson.encode(b))
return 'ok'
`;

// Move a booking to a new status; optionally give its slot back.
const TRANSITION = `
local rec = redis.call('HGET', KEYS[2], ARGV[1])
if not rec then return 'not_found' end
local b = cjson.decode(rec)
if not string.find(',' .. ARGV[3] .. ',', ',' .. b.status .. ',', 1, true) then
  return 'bad_state:' .. b.status
end
if ARGV[4] == '1' then
  local field = b.date .. '|' .. b.time
  local cur = redis.call('HGET', KEYS[1], field)
  local hold = 'hold:' .. ARGV[1] .. ':'
  if cur and (cur == 'booked:' .. ARGV[1] or string.sub(cur, 1, #hold) == hold) then
    redis.call('HDEL', KEYS[1], field)
  end
end
b.status = ARGV[2]
b[ARGV[2] .. 'At'] = ARGV[5]
redis.call('HSET', KEYS[2], ARGV[1], cjson.encode(b))
return 'ok'
`;

const RATE_LIMIT = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return n
`;

export async function claimSlot({ id, date, time, booking, nowMs }) {
  const expiresAt = nowMs + CONFIG.holdMinutes * 60000;
  const record = { id, ...booking, date, time, status: "held", createdAt: new Date(nowMs).toISOString(), holdExpiresAt: expiresAt };
  const ok = await evalLua(CLAIM, ["slots", "bookings"], [
    slotField(date, time), `hold:${id}:${expiresAt}`, nowMs, id, JSON.stringify(record),
  ]);
  return ok === 1 ? { expiresAt } : null;
}

export const confirmBooking = (id, nowMs) =>
  evalLua(CONFIRM, ["slots", "bookings"], [id, new Date(nowMs).toISOString()]);

export const transitionBooking = (id, to, from, freeSlot, nowMs) =>
  evalLua(TRANSITION, ["slots", "bookings"], [id, to, from.join(","), freeSlot ? "1" : "0", new Date(nowMs).toISOString()]);

// Returns true once `limit` requests have been made in the window.
export async function isRateLimited(scope, ip, limit, windowSec) {
  const n = await evalLua(RATE_LIMIT, [`rl:${scope}:${ip}`], [windowSec]);
  return n > limit;
}

// ---------- Validation ----------

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const clean = (v) => (typeof v === "string" ? v.replace(CONTROL_CHARS, "").trim() : "");

// Short reference shown to the customer and put in the UPI payment note.
export const refOf = (id) => id.slice(0, 8).toUpperCase();

export const isBookingId = (v) =>
  typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);

// -> { value } or { error: "<field>" }
export function validateBooking(body) {
  const name = clean(body.name);
  if (name.length < 2 || name.length > 100) return { error: "name" };

  const email = clean(body.email).toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: "email" };

  const whatsapp = clean(body.whatsapp);
  const digits = whatsapp.replace(/\D/g, "");
  if (!/^\+?[0-9][0-9 ()-]*$/.test(whatsapp) || digits.length < 10 || digits.length > 15) {
    return { error: "whatsapp" };
  }

  const focus = clean(body.focus);
  if (!CONFIG.focusOptions.includes(focus)) return { error: "focus" };

  const context = typeof body.context === "string"
    ? body.context.replace(CONTROL_CHARS, "").trim()
    : "";
  if (context.length > 1000) return { error: "context" };

  return { value: { name, email, whatsapp, focus, context } };
}

// ---------- HTTP ----------

export function send(res, status, body) {
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).json(body);
}

export function requireMethod(req, res, method) {
  if (req.method === method) return true;
  res.setHeader("Allow", method);
  send(res, 405, { error: "method_not_allowed" });
  return false;
}

// Vercel parses JSON bodies; be defensive about anything else.
export function jsonBody(req) {
  let b = req.body;
  if (typeof b === "string") {
    try { b = JSON.parse(b); } catch { return {}; }
  }
  return b && typeof b === "object" && !Array.isArray(b) ? b : {};
}

export function clientIp(req) {
  const fwd = req.headers?.["x-forwarded-for"];
  return String(req.headers?.["x-real-ip"] || (fwd ? String(fwd).split(",")[0] : "") || "unknown").trim();
}

export function serverError(res, err) {
  console.error(err);
  return send(res, 500, { error: "server_error" });
}
