// Shared helpers for the API functions. Files starting with "_" are not
// exposed as endpoints by Vercel.
//
// Redis schema
//   slots       (hash)  field "date|time" -> one of
//                         "hold:<id>:<expiresAtMs>"  reserved while the person pays
//                         "booked:<id>"              paid for (or free via promo code)
//                         "true"                     legacy value from the first version
//   bookings    (hash)  field <id> -> JSON booking record, with `status`:
//                         held -> confirmed        (paid, or free via promo code)
//                         released | cancelled     (slot given back)
//                         refund_due -> refunded   (paid but the slot was gone)
//   orders      (hash)  Razorpay order id -> booking id (webhook lookup)
//   promos      (hash)  CODE -> JSON { code, active, uses, maxUses?, expiresAt? }
//   promo_users (hash)  "CODE|email" -> booking id (one redemption per email)
//   rl:<scope>:<ip>     rate-limit counters (expire on their own)

import { CONFIG } from "./_config.js";

// ---------- Redis (Upstash REST) ----------

export async function redis(command) {
  // The Vercel Upstash integration names these KV_REST_API_*; a hand-made database uses UPSTASH_*.
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    throw new Error("Redis is not configured: set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN");
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

// Book a slot for free with a promo code: check the code, the slot and the email
// first, then write everything, so a failed check never uses up the code.
// KEYS: slots, bookings, promos, promo_users
// ARGV: field, bookedValue, nowMs, id, recordJson, code, email
const CLAIM_FREE = `
local raw = redis.call('HGET', KEYS[3], ARGV[6])
if not raw then return 'invalid_promo' end
local p = cjson.decode(raw)
if p.active ~= true then return 'invalid_promo' end
if type(p.expiresAt) == 'number' and p.expiresAt <= tonumber(ARGV[3]) then return 'invalid_promo' end
if type(p.maxUses) == 'number' and p.uses >= p.maxUses then return 'invalid_promo' end
local userKey = ARGV[6] .. '|' .. ARGV[7]
if redis.call('HEXISTS', KEYS[4], userKey) == 1 then return 'invalid_promo' end
local cur = redis.call('HGET', KEYS[1], ARGV[1])
if cur then
  local exp = string.match(cur, '^hold:[^:]+:(%d+)$')
  if not exp or tonumber(exp) > tonumber(ARGV[3]) then return 'slot_taken' end
end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('HSET', KEYS[2], ARGV[4], ARGV[5])
p.uses = p.uses + 1
redis.call('HSET', KEYS[3], ARGV[6], cjson.encode(p))
redis.call('HSET', KEYS[4], userKey, ARGV[4])
return 'ok'
`;

// Remember which Razorpay order belongs to a still-held booking.
// KEYS: bookings, orders   ARGV: id, orderId
const ATTACH_ORDER = `
local rec = redis.call('HGET', KEYS[1], ARGV[1])
if not rec then return 0 end
local b = cjson.decode(rec)
if b.status ~= 'held' then return 0 end
b.orderId = ARGV[2]
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(b))
redis.call('HSET', KEYS[2], ARGV[2], ARGV[1])
return 1
`;

// A verified, captured payment arrives: confirm the booking if its slot is still
// ours, otherwise mark it refund_due. Safe to run any number of times for the
// same payment (checkout callback, webhook and status sync can all race).
// KEYS: slots, bookings   ARGV: id, orderId, paymentId, nowMs, iso
const PAY = `
local rec = redis.call('HGET', KEYS[2], ARGV[1])
if not rec then return 'not_found' end
local b = cjson.decode(rec)
if b.orderId ~= ARGV[2] then return 'order_mismatch' end
if b.paymentId == ARGV[3] and (b.status == 'confirmed' or b.status == 'cancelled' or b.status == 'refunded' or b.status == 'refund_due') then
  return b.status
end
if b.status == 'confirmed' or b.status == 'refund_due' or b.status == 'refunded' then return 'duplicate' end
if b.status == 'held' or b.status == 'released' then
  local field = b.date .. '|' .. b.time
  local cur = redis.call('HGET', KEYS[1], field)
  local free = true
  if cur and cur ~= ('booked:' .. ARGV[1]) then
    local mine = 'hold:' .. ARGV[1] .. ':'
    if string.sub(cur, 1, #mine) ~= mine then
      local exp = string.match(cur, '^hold:[^:]+:(%d+)$')
      if not exp or tonumber(exp) > tonumber(ARGV[4]) then free = false end
    end
  end
  if free then
    redis.call('HSET', KEYS[1], field, 'booked:' .. ARGV[1])
    b.status = 'confirmed'
    b.paymentId = ARGV[3]
    b.paidAt = ARGV[5]
    redis.call('HSET', KEYS[2], ARGV[1], cjson.encode(b))
    return 'confirmed'
  end
end
b.status = 'refund_due'
b.paymentId = ARGV[3]
b.refundDueAt = ARGV[5]
redis.call('HSET', KEYS[2], ARGV[1], cjson.encode(b))
return 'refund_due'
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

const PROMO_DISABLE = `
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then return 0 end
local p = cjson.decode(raw)
p.active = false
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(p))
return 1
`;

const RATE_LIMIT = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return n
`;

const newRecord = ({ id, booking, date, time, status, nowMs, extra }) =>
  ({ id, ...booking, date, time, status, createdAt: new Date(nowMs).toISOString(), ...extra });

export async function claimSlot({ id, date, time, booking, nowMs }) {
  const expiresAt = nowMs + CONFIG.holdMinutes * 60000;
  const record = newRecord({ id, booking, date, time, status: "held", nowMs, extra: { holdExpiresAt: expiresAt, amountPaise: Math.round(CONFIG.amount * 100) } });
  const ok = await evalLua(CLAIM, ["slots", "bookings"], [
    slotField(date, time), `hold:${id}:${expiresAt}`, nowMs, id, JSON.stringify(record),
  ]);
  return ok === 1 ? { expiresAt } : null;
}

// -> 'ok' | 'slot_taken' | 'invalid_promo'
export function claimFreeSlot({ id, date, time, booking, code, nowMs }) {
  const record = newRecord({
    id, booking, date, time, status: "confirmed", nowMs,
    extra: { promoCode: code, amountPaise: 0, confirmedAt: new Date(nowMs).toISOString() },
  });
  return evalLua(CLAIM_FREE, ["slots", "bookings", "promos", "promo_users"], [
    slotField(date, time), `booked:${id}`, nowMs, id, JSON.stringify(record), code, booking.email,
  ]);
}

export const attachOrder = (id, orderId) => evalLua(ATTACH_ORDER, ["bookings", "orders"], [id, orderId]);

// -> 'confirmed' | 'refund_due' | 'refunded' | 'cancelled' | 'duplicate' | 'order_mismatch' | 'not_found'
export const payBooking = (id, orderId, paymentId, nowMs) =>
  evalLua(PAY, ["slots", "bookings"], [id, orderId, paymentId, nowMs, new Date(nowMs).toISOString()]);

export const transitionBooking = (id, to, from, freeSlot, nowMs) =>
  evalLua(TRANSITION, ["slots", "bookings"], [id, to, from.join(","), freeSlot ? "1" : "0", new Date(nowMs).toISOString()]);

export async function getBooking(id) {
  const raw = await redis(["HGET", "bookings", id]);
  return raw ? JSON.parse(raw) : null;
}

export const bookingIdForOrder = (orderId) => redis(["HGET", "orders", orderId]);

// Returns true once `limit` requests have been made in the window.
export async function isRateLimited(scope, ip, limit, windowSec) {
  const n = await evalLua(RATE_LIMIT, [`rl:${scope}:${ip}`], [windowSec]);
  return n > limit;
}

// ---------- Promo codes ----------

// "  fresher-2026 " -> "FRESHER-2026"; '' when none given; null when malformed
export function normalizePromo(raw) {
  if (raw == null || raw === "") return "";
  if (typeof raw !== "string") return null;
  const code = raw.trim().toUpperCase();
  if (code === "") return "";
  return /^[A-Z0-9_-]{3,32}$/.test(code) ? code : null;
}

export async function createPromo({ code, maxUses, expiresAt }) {
  const promo = { code, active: true, uses: 0, createdAt: new Date().toISOString() };
  if (maxUses != null) promo.maxUses = maxUses;
  if (expiresAt != null) promo.expiresAt = expiresAt;
  return (await redis(["HSETNX", "promos", code, JSON.stringify(promo)])) === 1 ? promo : null;
}

export const disablePromo = async (code) => (await evalLua(PROMO_DISABLE, ["promos"], [code])) === 1;

export async function listPromos() {
  return (await redis(["HVALS", "promos"])).map((v) => JSON.parse(v));
}

// ---------- Validation ----------

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const clean = (v) => (typeof v === "string" ? v.replace(CONTROL_CHARS, "").trim() : "");

// Short reference shown to the customer and sent to Razorpay as the order receipt.
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
