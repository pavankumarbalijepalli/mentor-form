// Integration tests: the real handlers + Lua scripts against a real redis-server.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { CONFIG } from "../api/_config.js";
import { isSlotOpen, addDays, todayKey } from "../public/js/dates.js";
import { call, hasRedis, startRedis } from "../test-helpers/redis.js";

const skip = hasRedis ? false : "redis-server not installed";

let db, book, confirm, release, slots, admin, config, health;
before(async () => {
  if (skip) return;
  db = await startRedis();
  ({ default: book } = await import("../api/book.js"));
  ({ default: confirm } = await import("../api/confirm.js"));
  ({ default: release } = await import("../api/release.js"));
  ({ default: slots } = await import("../api/slots.js"));
  ({ default: admin } = await import("../api/admin.js"));
  ({ default: config } = await import("../api/config.js"));
  ({ default: health } = await import("../api/health.js"));
});
after(() => db?.stop());

// A distinct bookable slot per index, so tests don't interfere with each other.
const openSlots = [];
{
  const now = Date.now();
  for (let i = 0; i < CONFIG.bookingWindowDays; i++) {
    const date = addDays(todayKey(now, CONFIG.utcOffsetMinutes), i);
    for (const time of CONFIG.timeSlots) if (isSlotOpen(date, time, now, CONFIG)) openSlots.push({ date, time });
  }
}

let ipCounter = 0;
const freshIp = () => ({ "x-real-ip": `10.0.0.${++ipCounter}` });
const person = (extra = {}) => ({
  name: "Ananya Rao", email: "Ananya@Example.com", whatsapp: "+91 98765 43210",
  focus: CONFIG.focusOptions[0], context: "Backend dev moving to ML", ...extra,
});
const hold = (slot, extra = {}, headers = freshIp()) =>
  call(book, { method: "POST", headers, body: { ...slot, ...person(extra) } });
const status = async (slot) =>
  (await call(slots, { query: { date: slot.date } })).body.slots.find((s) => s.time === slot.time).status;

test("config exposes the schedule but nothing secret", { skip }, async () => {
  const r = await call(config);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.timeSlots, CONFIG.timeSlots);
  assert.equal(r.body.timezone, "Asia/Kolkata");
});

test("slots: validates the date and reports closed days as empty", { skip }, async () => {
  assert.equal((await call(slots, { query: {} })).status, 400);
  assert.equal((await call(slots, { query: { date: "2026-02-30" } })).status, 400);
  assert.equal((await call(slots, { query: { date: "2020-01-01" } })).body.slots.length, 0);
  assert.equal((await call(slots, { method: "POST" })).status, 405);
});

test("book: rejects bad input with the offending field", { skip }, async () => {
  const s = openSlots[0];
  for (const [extra, field] of [
    [{ name: "" }, "name"], [{ name: "x".repeat(101) }, "name"],
    [{ email: "nope" }, "email"], [{ whatsapp: "12345" }, "whatsapp"], [{ whatsapp: "abc4567890123" }, "whatsapp"],
    [{ focus: "Free money" }, "focus"], [{ context: "x".repeat(1001) }, "context"],
  ]) {
    const r = await hold(s, extra);
    assert.equal(r.status, 400, field);
    assert.equal(r.body.field, field);
  }
  assert.equal((await status(s)), "open", "failed attempts must not claim the slot");
});

test("book: rejects slots the schedule doesn't offer", { skip }, async () => {
  const now = Date.now();
  const today = todayKey(now, CONFIG.utcOffsetMinutes);
  let sunday = today;
  while (new Date(`${sunday}T00:00:00Z`).getUTCDay() !== 0) sunday = addDays(sunday, 1);
  for (const slot of [
    { date: sunday, time: CONFIG.timeSlots[0] },                       // closed weekday
    { date: addDays(today, -1), time: CONFIG.timeSlots[0] },           // past
    { date: addDays(today, CONFIG.bookingWindowDays + 10), time: CONFIG.timeSlots[0] }, // beyond window
    { date: openSlots[0].date, time: "3:33 AM" },                      // time we don't offer
    { date: "not-a-date", time: CONFIG.timeSlots[0] },
    {},
  ]) {
    assert.equal((await hold(slot)).body.error, "invalid_slot", JSON.stringify(slot));
  }
});

test("book: honeypot field is rejected", { skip }, async () => {
  const r = await hold(openSlots[1], { website: "http://spam.example" });
  assert.equal(r.status, 400);
  assert.equal(await status(openSlots[1]), "open");
});

test("book: a hold shows as held, normalises input, and blocks a second booking", { skip }, async () => {
  const s = openSlots[2];
  const r = await hold(s);
  assert.equal(r.status, 200);
  assert.match(r.body.id, /^[0-9a-f-]{36}$/);
  assert.equal(r.body.ref, r.body.id.slice(0, 8).toUpperCase());
  assert.ok(r.body.expiresAt > Date.now());
  assert.equal(await status(s), "held");

  const saved = JSON.parse(await db.cmd(["HGET", "bookings", r.body.id]));
  assert.equal(saved.email, "ananya@example.com");
  assert.equal(saved.status, "held");

  const second = await hold(s);
  assert.equal(second.status, 409);
  assert.equal(second.body.error, "slot_taken");
});

test("book: concurrent requests for one slot produce exactly one winner", { skip }, async () => {
  const s = openSlots[3];
  const results = await Promise.all(Array.from({ length: 10 }, () => hold(s)));
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal(results.filter((r) => r.status === 409).length, 9);
  assert.equal(Number(await db.cmd(["HLEN", "bookings"])) >= 1, true);
});

test("book: an expired hold can be taken by someone else", { skip }, async () => {
  const s = openSlots[4];
  await db.cmd(["HSET", "slots", `${s.date}|${s.time}`, `hold:old-id:${Date.now() - 1000}`]);
  assert.equal(await status(s), "open");
  assert.equal((await hold(s)).status, 200);
});

test("book: slots marked 'true' by the first version stay booked", { skip }, async () => {
  const s = openSlots[5];
  await db.cmd(["HSET", "slots", `${s.date}|${s.time}`, "true"]);
  assert.equal(await status(s), "booked");
  assert.equal((await hold(s)).status, 409);
});

test("book: rate limits a single visitor", { skip }, async () => {
  const headers = freshIp();
  const real = openSlots.slice(10, 18);
  const limited = [];
  for (const s of real) limited.push((await hold(s, {}, headers)).status);
  assert.deepEqual(limited.slice(0, 6), [200, 200, 200, 200, 200, 200]);
  assert.deepEqual(limited.slice(6), [429, 429]);
  assert.equal(await status(real[6]), "open", "rate-limited request must not claim a slot");
});

test("confirm: hold becomes a booking, is idempotent, and rejects junk ids", { skip }, async () => {
  const s = openSlots[20];
  const { body } = await hold(s);
  assert.equal((await call(confirm, { method: "POST", headers: freshIp(), body: { id: "nope" } })).status, 400);
  assert.equal((await call(confirm, { method: "POST", headers: freshIp(), body: { id: crypto.randomUUID() } })).status, 404);

  for (let i = 0; i < 2; i++) {
    const r = await call(confirm, { method: "POST", headers: freshIp(), body: { id: body.id } });
    assert.equal(r.status, 200);
  }
  assert.equal(await status(s), "booked");
  assert.equal(await db.cmd(["HGET", "slots", `${s.date}|${s.time}`]), `booked:${body.id}`);
  assert.equal(JSON.parse(await db.cmd(["HGET", "bookings", body.id])).status, "pending_review");
});

test("confirm: still works after the hold expired if nobody took the slot", { skip }, async () => {
  const s = openSlots[21];
  const { body } = await hold(s);
  await db.cmd(["HSET", "slots", `${s.date}|${s.time}`, `hold:${body.id}:${Date.now() - 60000}`]);
  assert.equal((await call(confirm, { method: "POST", headers: freshIp(), body: { id: body.id } })).status, 200);
  assert.equal(await status(s), "booked");
});

test("confirm: 409 if the slot went to someone else after the hold expired", { skip }, async () => {
  const s = openSlots[22];
  const first = (await hold(s)).body;
  await db.cmd(["HSET", "slots", `${s.date}|${s.time}`, `hold:${first.id}:${Date.now() - 60000}`]);
  const second = await hold(s);
  assert.equal(second.status, 200);
  const r = await call(confirm, { method: "POST", headers: freshIp(), body: { id: first.id } });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "slot_taken");
  // and the new holder is unaffected
  assert.equal((await call(confirm, { method: "POST", headers: freshIp(), body: { id: second.body.id } })).status, 200);
});

test("release: frees a held slot but can't undo a payment claim", { skip }, async () => {
  const a = openSlots[23], b = openSlots[24];
  const ha = (await hold(a)).body, hb = (await hold(b)).body;

  assert.equal((await call(release, { method: "POST", headers: freshIp(), body: { id: ha.id } })).status, 200);
  assert.equal(await status(a), "open");
  assert.equal((await hold(a)).status, 200, "freed slot can be booked again");

  await call(confirm, { method: "POST", headers: freshIp(), body: { id: hb.id } });
  assert.equal((await call(release, { method: "POST", headers: freshIp(), body: { id: hb.id } })).status, 200);
  assert.equal(await status(b), "booked");
  // a stale release of the first hold must not free the slot its new owner holds
  await call(release, { method: "POST", headers: freshIp(), body: { id: ha.id } });
  assert.equal(await status(a), "held");
});

test("admin: disabled without a token, then auth, list, confirm and cancel", { skip }, async () => {
  delete process.env.ADMIN_TOKEN;
  assert.equal((await call(admin, { headers: freshIp() })).status, 404);

  process.env.ADMIN_TOKEN = "s3cret-token";
  const auth = (extra = {}) => ({ ...freshIp(), authorization: "Bearer s3cret-token", ...extra });
  assert.equal((await call(admin, { headers: freshIp() })).status, 401);
  assert.equal((await call(admin, { headers: { ...freshIp(), authorization: "Bearer wrong" } })).status, 401);

  const s = openSlots[25];
  const { body } = await hold(s);
  await call(confirm, { method: "POST", headers: freshIp(), body: { id: body.id } });

  const list = await call(admin, { headers: auth(), query: { status: "pending_review" } });
  assert.equal(list.status, 200);
  assert.ok(list.body.bookings.some((x) => x.id === body.id && x.email === "ananya@example.com"));

  assert.equal((await call(admin, { method: "POST", headers: auth(), body: { id: body.id, action: "confirm" } })).status, 200);
  assert.equal((await call(admin, { method: "POST", headers: auth(), body: { id: body.id, action: "confirm" } })).status, 409, "can't confirm twice");
  assert.equal((await call(admin, { method: "POST", headers: auth(), body: { id: body.id, action: "explode" } })).status, 400);
  assert.equal(await status(s), "booked");

  assert.equal((await call(admin, { method: "POST", headers: auth(), body: { id: body.id, action: "cancel" } })).status, 200);
  assert.equal(await status(s), "open", "cancelling frees the slot");
  assert.equal(JSON.parse(await db.cmd(["HGET", "bookings", body.id])).status, "cancelled");
  delete process.env.ADMIN_TOKEN;
});

test("admin: hides expired holds unless asked", { skip }, async () => {
  process.env.ADMIN_TOKEN = "s3cret-token";
  const headers = () => ({ ...freshIp(), authorization: "Bearer s3cret-token" });
  const { body } = await hold(openSlots[26]);
  const stale = JSON.parse(await db.cmd(["HGET", "bookings", body.id]));
  stale.holdExpiresAt = Date.now() - 1000;
  await db.cmd(["HSET", "bookings", body.id, JSON.stringify(stale)]);

  const hidden = await call(admin, { headers: headers() });
  assert.ok(!hidden.body.bookings.some((x) => x.id === body.id));
  const shown = await call(admin, { headers: headers(), query: { all: "1" } });
  assert.ok(shown.body.bookings.some((x) => x.id === body.id));
  delete process.env.ADMIN_TOKEN;
});

test("a Redis outage is a 500, not a crash or a silent success", { skip }, async () => {
  const saved = process.env.UPSTASH_REDIS_REST_URL;
  process.env.UPSTASH_REDIS_REST_URL = "http://127.0.0.1:1";
  const origError = console.error;
  console.error = () => {};
  try {
    assert.equal((await hold(openSlots[27])).status, 500);
    assert.equal((await call(slots, { query: { date: openSlots[27].date } })).status, 500);
  } finally {
    console.error = origError;
    process.env.UPSTASH_REDIS_REST_URL = saved;
  }
  assert.equal(await status(openSlots[27]), "open");
});

test("health: 200 when Redis answers, 503 when it doesn't", { skip }, async () => {
  assert.deepEqual((await call(health)).body, { ok: true });
  const saved = process.env.UPSTASH_REDIS_REST_URL;
  process.env.UPSTASH_REDIS_REST_URL = "http://127.0.0.1:1";
  const origError = console.error;
  console.error = () => {};
  try {
    assert.equal((await call(health)).status, 503);
  } finally {
    console.error = origError;
    process.env.UPSTASH_REDIS_REST_URL = saved;
  }
});

test("redis config: accepts the Vercel integration's KV_REST_API_* names", { skip }, async () => {
  const url = process.env.UPSTASH_REDIS_REST_URL, token = process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.UPSTASH_REDIS_REST_URL; delete process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.KV_REST_API_URL = url; process.env.KV_REST_API_TOKEN = token;
  try {
    assert.equal((await call(health)).status, 200);
  } finally {
    delete process.env.KV_REST_API_URL; delete process.env.KV_REST_API_TOKEN;
    process.env.UPSTASH_REDIS_REST_URL = url; process.env.UPSTASH_REDIS_REST_TOKEN = token;
  }
});
