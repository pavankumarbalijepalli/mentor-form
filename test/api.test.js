// Integration tests: the real handlers + Lua scripts against a real redis-server,
// with a local mock standing in for Razorpay's API.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { CONFIG } from "../api/_config.js";
import { isSlotOpen, addDays, todayKey } from "../public/js/dates.js";
import { call, hasRedis, startRedis } from "../test-helpers/redis.js";
import { startRazorpayMock } from "../test-helpers/razorpay.js";

const skip = hasRedis ? false : "redis-server not installed";
const ADMIN = "s3cret-token";

let db, rzp, h;
const openSlots = [];

before(async () => {
  if (skip) return;
  db = await startRedis();
  rzp = await startRazorpayMock();
  process.env.ADMIN_TOKEN = ADMIN;
  CONFIG.bookingWindowDays = 90; // plenty of distinct slots for the tests below
  h = {};
  for (const n of ["book", "verify", "webhook", "status", "release", "slots", "admin", "config", "health"]) {
    h[n] = (await import(`../api/${n}.js`)).default;
  }
  const now = Date.now();
  for (let i = 0; i < CONFIG.bookingWindowDays; i++) {
    const date = addDays(todayKey(now, CONFIG.utcOffsetMinutes), i);
    for (const time of CONFIG.timeSlots) if (isSlotOpen(date, time, now, CONFIG)) openSlots.push({ date, time });
  }
});
after(() => { db?.stop(); rzp?.stop(); });

let slotIdx = 0;
const nextSlot = () => openSlots[slotIdx++];
let ipCounter = 0;
const freshIp = () => ({ "x-real-ip": `10.0.0.${++ipCounter}` });
const person = (extra = {}) => ({
  name: "Ananya Rao", email: `ananya${++ipCounter}@Example.com`, whatsapp: "+91 98765 43210",
  focus: CONFIG.focusOptions[0], context: "Backend dev moving to ML", ...extra,
});
const hold = (slot, extra = {}, headers = freshIp()) =>
  call(h.book, { method: "POST", headers, body: { ...slot, ...person(extra) } });
const status = async (slot) =>
  (await call(h.slots, { query: { date: slot.date } })).body.slots.find((s) => s.time === slot.time).status;
const field = (slot) => `${slot.date}|${slot.time}`;
const record = async (id) => JSON.parse(await db.cmd(["HGET", "bookings", id]));
const slotValue = (slot) => db.cmd(["HGET", "slots", field(slot)]);
const expireHold = (slot, id) => db.cmd(["HSET", "slots", field(slot), `hold:${id}:${Date.now() - 60000}`]);
const verify = (id, p, headers = freshIp()) =>
  call(h.verify, { method: "POST", headers, body: { id, razorpay_payment_id: p.paymentId, razorpay_signature: p.signature } });
const admin = (opts = {}) => call(h.admin, { ...opts, headers: { ...freshIp(), authorization: `Bearer ${ADMIN}`, ...opts.headers } });
const adminPost = (body) => admin({ method: "POST", body });
const deliver = (hook, headers = {}) =>
  call(h.webhook, { method: "POST", raw: hook.raw, headers: { "x-razorpay-signature": hook.signature, ...headers } });

// A paid-for hold: returns { slot, id, order, p } with a captured payment not yet reported to us.
async function heldAndPaid(opts) {
  const slot = nextSlot();
  const { body } = await hold(slot);
  return { slot, id: body.id, order: body.order, p: rzp.pay(body.order.id, opts) };
}

// ---------- basics ----------

test("config exposes the schedule and price but no payment secrets", { skip }, async () => {
  const r = await call(h.config);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.timeSlots, CONFIG.timeSlots);
  assert.equal(r.body.amount, 899);
  assert.equal(r.body.timezone, "Asia/Kolkata");
  assert.ok(!JSON.stringify(r.body).match(/secret|rzp_|upi/i));
});

test("slots: validates the date and reports closed days as empty", { skip }, async () => {
  assert.equal((await call(h.slots, { query: {} })).status, 400);
  assert.equal((await call(h.slots, { query: { date: "2026-02-30" } })).status, 400);
  assert.equal((await call(h.slots, { query: { date: "2020-01-01" } })).body.slots.length, 0);
  assert.equal((await call(h.slots, { method: "POST" })).status, 405);
});

test("book: rejects bad input with the offending field", { skip }, async () => {
  const s = nextSlot();
  for (const [extra, f] of [
    [{ name: "" }, "name"], [{ name: "x".repeat(101) }, "name"],
    [{ email: "nope" }, "email"], [{ whatsapp: "12345" }, "whatsapp"], [{ whatsapp: "abc4567890123" }, "whatsapp"],
    [{ focus: "Free money" }, "focus"], [{ context: "x".repeat(1001) }, "context"],
  ]) {
    const r = await hold(s, extra);
    assert.equal(r.status, 400, f);
    assert.equal(r.body.field, f);
  }
  assert.equal(await status(s), "open", "failed attempts must not claim the slot");
  assert.equal(rzp.countCalls("POST /v1/orders"), 0, "no Razorpay order for invalid requests");
});

test("book: rejects slots the schedule doesn't offer", { skip }, async () => {
  const today = todayKey(Date.now(), CONFIG.utcOffsetMinutes);
  let sunday = today;
  while (new Date(`${sunday}T00:00:00Z`).getUTCDay() !== 0) sunday = addDays(sunday, 1);
  for (const slot of [
    { date: sunday, time: CONFIG.timeSlots[0] },
    { date: addDays(today, -1), time: CONFIG.timeSlots[0] },
    { date: addDays(today, CONFIG.bookingWindowDays + 10), time: CONFIG.timeSlots[0] },
    { date: openSlots[0].date, time: "3:33 AM" },
    { date: "not-a-date", time: CONFIG.timeSlots[0] },
    {},
  ]) {
    assert.equal((await hold(slot)).body.error, "invalid_slot", JSON.stringify(slot));
  }
});

test("book: honeypot field is rejected", { skip }, async () => {
  const s = nextSlot();
  assert.equal((await hold(s, { website: "http://spam.example" })).status, 400);
  assert.equal(await status(s), "open");
});

// ---------- the paid flow ----------

test("book: holds the slot and creates a Razorpay order for ₹899 on the server", { skip }, async () => {
  const s = nextSlot();
  const r = await hold(s, { amount: 1, amountPaise: 100 }); // client-supplied amounts must be ignored
  assert.equal(r.status, 200);
  assert.equal(r.body.keyId, "rzp_test_mock");
  assert.equal(r.body.order.amount, 89900);
  assert.equal(r.body.order.currency, "INR");
  assert.match(r.body.ref, /^[0-9A-F]{8}$/);
  assert.equal(await status(s), "held");

  const order = rzp.orders.get(r.body.order.id);
  assert.equal(order.receipt, r.body.id);
  assert.equal(order.notes.bookingId, r.body.id);
  assert.match(order.notes.slot, /IST$/);

  const saved = await record(r.body.id);
  assert.equal(saved.status, "held");
  assert.equal(saved.orderId, r.body.order.id);
  assert.equal(saved.amountPaise, 89900);
  assert.equal(saved.email.includes("@example.com"), true, "email lower-cased");
  assert.equal(await db.cmd(["HGET", "orders", r.body.order.id]), r.body.id);

  const second = await hold(s);
  assert.equal(second.status, 409);
  assert.equal(second.body.error, "slot_taken");
});

test("book: concurrent requests for one slot produce one winner and one order", { skip }, async () => {
  const s = nextSlot();
  const before = rzp.countCalls("POST /v1/orders");
  const results = await Promise.all(Array.from({ length: 10 }, () => hold(s)));
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal(results.filter((r) => r.status === 409).length, 9);
  assert.equal(rzp.countCalls("POST /v1/orders") - before, 1, "losers must not create orders");
});

test("book: an expired hold can be taken by someone else", { skip }, async () => {
  const s = nextSlot();
  await db.cmd(["HSET", "slots", field(s), `hold:old-id:${Date.now() - 1000}`]);
  assert.equal(await status(s), "open");
  assert.equal((await hold(s)).status, 200);
});

test("book: slots marked 'true' by the first version stay booked", { skip }, async () => {
  const s = nextSlot();
  await db.cmd(["HSET", "slots", field(s), "true"]);
  assert.equal(await status(s), "booked");
  assert.equal((await hold(s)).status, 409);
});

test("book: rate limits a single visitor", { skip }, async () => {
  const headers = freshIp();
  const limited = [];
  const real = [nextSlot(), nextSlot(), nextSlot(), nextSlot(), nextSlot(), nextSlot(), nextSlot(), nextSlot()];
  for (const s of real) limited.push((await hold(s, {}, headers)).status);
  assert.deepEqual(limited.slice(0, 6), [200, 200, 200, 200, 200, 200]);
  assert.deepEqual(limited.slice(6), [429, 429]);
  assert.equal(await status(real[6]), "open", "rate-limited request must not claim a slot");
});

test("book: if Razorpay is down the hold is released and the visitor gets a 502", { skip }, async () => {
  const s = nextSlot();
  rzp.failOrders = true;
  const origError = console.error; console.error = () => {};
  try {
    const r = await hold(s);
    assert.equal(r.status, 502);
    assert.equal(r.body.error, "payment_unavailable");
  } finally { rzp.failOrders = false; console.error = origError; }
  assert.equal(await status(s), "open");
  assert.equal((await hold(s)).status, 200, "slot is bookable again");
});

test("book: without Razorpay keys a paid booking is refused before touching the slot", { skip }, async () => {
  const s = nextSlot();
  const saved = process.env.RAZORPAY_KEY_SECRET;
  delete process.env.RAZORPAY_KEY_SECRET;
  const origError = console.error; console.error = () => {};
  try {
    assert.equal((await hold(s)).status, 503);
  } finally { process.env.RAZORPAY_KEY_SECRET = saved; console.error = origError; }
  assert.equal(await status(s), "open");
});

test("verify: a genuine payment confirms the booking, and repeating it is harmless", { skip }, async () => {
  const { slot, id, p } = await heldAndPaid();
  const r = await verify(id, p);
  assert.equal(r.status, 200);
  assert.equal(r.body.status, "confirmed");
  assert.equal(r.body.date, slot.date);
  assert.equal(await status(slot), "booked");
  assert.equal(await slotValue(slot), `booked:${id}`);
  const saved = await record(id);
  assert.equal(saved.status, "confirmed");
  assert.equal(saved.paymentId, p.paymentId);

  assert.equal((await verify(id, p)).status, 200);
  assert.equal(rzp.payments.get(p.paymentId).status, "captured", "never refunded");
});

test("verify: rejects forged, mismatched and malformed payments", { skip }, async () => {
  const { slot, id, order, p } = await heldAndPaid();
  assert.equal((await verify(id, { ...p, signature: "0".repeat(64) })).body.error, "bad_signature");
  assert.equal((await verify(id, { ...p, signature: "" })).status, 400);
  assert.equal((await verify(id, { paymentId: "not-a-payment", signature: p.signature })).status, 400);
  assert.equal((await call(h.verify, { method: "POST", headers: freshIp(), body: { id: "nope", razorpay_payment_id: p.paymentId, razorpay_signature: p.signature } })).status, 400);
  assert.equal((await verify(crypto.randomUUID(), p)).status, 404);

  // a genuine payment for ANOTHER booking's order can't confirm this one
  const other = await heldAndPaid();
  assert.equal((await verify(id, other.p)).body.error, "bad_signature");

  // right order, wrong amount (e.g. someone pays ₹1 against the order) is refused
  const cheap = rzp.pay(order.id, { amount: 100 });
  assert.equal((await verify(id, cheap)).body.error, "payment_mismatch");
  // a payment that failed at the bank
  const failed = rzp.pay(order.id, { status: "failed" });
  assert.equal((await verify(id, failed)).status, 402);

  assert.equal(await status(slot), "held", "none of that may confirm the booking");
  assert.equal((await record(id)).status, "held");
});

test("verify: an authorized-only payment is captured before the booking is confirmed", { skip }, async () => {
  const { id, p } = await heldAndPaid({ status: "authorized" });
  assert.equal((await verify(id, p)).status, 200);
  assert.equal(rzp.payments.get(p.paymentId).status, "captured");
  assert.ok(rzp.countCalls(`POST /v1/payments/${p.paymentId}/capture`) >= 1);
});

test("verify: paying after the hold lapsed still works if nobody took the slot", { skip }, async () => {
  const { slot, id, p } = await heldAndPaid();
  await expireHold(slot, id);
  assert.equal((await verify(id, p)).status, 200);
  assert.equal(await slotValue(slot), `booked:${id}`);
});

test("verify: paying after the hold lapsed and the slot went elsewhere refunds automatically", { skip }, async () => {
  const { slot, id, p } = await heldAndPaid();
  await expireHold(slot, id);
  const winner = await hold(slot);
  assert.equal(winner.status, 200);

  const r = await verify(id, p);
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "slot_taken");
  assert.equal(r.body.status, "refunded");
  assert.equal(rzp.payments.get(p.paymentId).status, "refunded");
  assert.equal((await record(id)).status, "refunded");
  assert.equal(await slotValue(slot), `hold:${winner.body.id}:${(await record(winner.body.id)).holdExpiresAt}`, "new holder keeps the slot");

  assert.equal((await verify(id, p)).status, 409, "repeating it doesn't refund twice");
  assert.equal(rzp.countCalls(`POST /v1/payments/${p.paymentId}/refund`), 1);
});

test("verify: if the automatic refund fails it is left as refund_due and admin can retry", { skip }, async () => {
  const { slot, id, p } = await heldAndPaid();
  await expireHold(slot, id);
  const winner = await hold(slot);
  rzp.failRefunds = true;
  const origError = console.error; console.error = () => {};
  try {
    const r = await verify(id, p);
    assert.equal(r.status, 409);
    assert.equal(r.body.status, "refund_due");
  } finally { rzp.failRefunds = false; console.error = origError; }
  assert.equal((await record(id)).status, "refund_due");

  const due = await admin({ query: { status: "refund_due" } });
  assert.ok(due.body.bookings.some((b) => b.id === id));
  assert.equal((await adminPost({ id, action: "refund" })).status, 200);
  assert.equal((await record(id)).status, "refunded");
  assert.equal(rzp.payments.get(p.paymentId).status, "refunded");
  assert.ok((await slotValue(slot)).startsWith(`hold:${winner.body.id}`), "refunding must not free the other person's slot");
});

test("verify: a second payment against an already-paid order is refunded", { skip }, async () => {
  const { slot, id, order, p } = await heldAndPaid();
  assert.equal((await verify(id, p)).status, 200);
  const again = rzp.pay(order.id);
  const r = await verify(id, again);
  assert.equal(r.status, 200);
  assert.equal(r.body.status, "confirmed");
  assert.equal(rzp.payments.get(again.paymentId).status, "refunded", "extra payment returned");
  assert.equal(rzp.payments.get(p.paymentId).status, "captured", "original payment untouched");
  assert.equal(await slotValue(slot), `booked:${id}`);
});

// ---------- webhook ----------

test("webhook: confirms a payment the customer never reported back", { skip }, async () => {
  const { slot, id, p } = await heldAndPaid();
  const r = await deliver(rzp.webhook("payment.captured", p.paymentId));
  assert.equal(r.status, 200);
  assert.equal(r.body.status, "confirmed");
  assert.equal(await status(slot), "booked");
  assert.equal((await record(id)).paymentId, p.paymentId);

  // Razorpay retries and also sends order.paid: all harmless
  assert.equal((await deliver(rzp.webhook("payment.captured", p.paymentId))).body.status, "confirmed");
  assert.equal((await deliver(rzp.webhook("order.paid", p.paymentId))).body.status, "confirmed");
  assert.equal((await verify(id, p)).status, 200);
  assert.equal(rzp.payments.get(p.paymentId).status, "captured");
});

test("webhook: refuses bad or missing signatures and changes nothing", { skip }, async () => {
  const { slot, id, p } = await heldAndPaid();
  const hook = rzp.webhook("payment.captured", p.paymentId);
  assert.equal((await deliver({ raw: hook.raw, signature: "0".repeat(64) })).status, 400);
  assert.equal((await deliver({ raw: hook.raw, signature: undefined })).status, 400);
  assert.equal((await deliver(rzp.webhook("payment.captured", p.paymentId, { secret: "wrong" }))).status, 400);
  // a tampered body no longer matches its signature
  assert.equal((await deliver({ raw: hook.raw.replace("captured", "captured "), signature: hook.signature })).status, 400);
  assert.equal(await status(slot), "held");
  assert.equal((await record(id)).status, "held");
});

test("webhook: ignores other events and orders that aren't ours", { skip }, async () => {
  const { id, p } = await heldAndPaid();
  const failedHook = rzp.webhook("payment.failed", p.paymentId);
  assert.equal((await deliver(failedHook)).body.ignored, true);

  rzp.orders.set("order_foreign", { id: "order_foreign", amount: 5000, currency: "INR", notes: {}, status: "created" });
  const foreign = rzp.pay("order_foreign");
  assert.equal((await deliver(rzp.webhook("payment.captured", foreign.paymentId))).body.ignored, true);
  assert.equal((await record(id)).status, "held");

  assert.equal((await call(h.webhook, { method: "GET" })).status, 405);
});

test("webhook: a payment that belongs to a different order can't confirm a booking", { skip }, async () => {
  const a = await heldAndPaid(), b = await heldAndPaid();
  // a (correctly signed) delivery that pairs booking A's order id with booking B's payment
  const raw = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: b.p.paymentId, order_id: a.order.id } } } });
  const signature = createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET).update(raw).digest("hex");
  const r = await deliver({ raw, signature });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, "mismatch");
  assert.equal((await record(a.id)).status, "held");
  assert.equal(await status(a.slot), "held");
});

test("webhook: says so when the webhook secret isn't configured", { skip }, async () => {
  const { p } = await heldAndPaid();
  const hook = rzp.webhook("payment.captured", p.paymentId);
  const saved = process.env.RAZORPAY_WEBHOOK_SECRET;
  delete process.env.RAZORPAY_WEBHOOK_SECRET;
  const origError = console.error; console.error = () => {};
  try {
    assert.equal((await deliver(hook)).status, 503);
  } finally { process.env.RAZORPAY_WEBHOOK_SECRET = saved; console.error = origError; }
});

// ---------- status sync ----------

test("status: recovers a paid booking whose customer lost the tab and webhook never arrived", { skip }, async () => {
  const { slot, id } = await heldAndPaid(); // paid at Razorpay, nobody told us
  assert.equal((await call(h.status, { query: { id }, headers: freshIp() })).body.status, "confirmed");
  assert.equal(await status(slot), "booked");
});

test("status: unpaid holds stay held; bad ids are rejected", { skip }, async () => {
  const s = nextSlot();
  const { body } = await hold(s);
  const r = await call(h.status, { query: { id: body.id }, headers: freshIp() });
  assert.equal(r.body.status, "held");
  assert.equal(r.body.ref, body.ref);
  assert.equal((await call(h.status, { query: { id: crypto.randomUUID() }, headers: freshIp() })).status, 404);
  assert.equal((await call(h.status, { query: { id: "x" }, headers: freshIp() })).status, 400);
});

test("status: still answers if Razorpay can't be reached", { skip }, async () => {
  const s = nextSlot();
  const { body } = await hold(s);
  const saved = process.env.RAZORPAY_API_BASE;
  process.env.RAZORPAY_API_BASE = "http://127.0.0.1:1/v1";
  const origError = console.error; console.error = () => {};
  try {
    assert.equal((await call(h.status, { query: { id: body.id }, headers: freshIp() })).body.status, "held");
  } finally { process.env.RAZORPAY_API_BASE = saved; console.error = origError; }
});

// ---------- release ----------

test("release: frees a held slot but never undoes a confirmed booking", { skip }, async () => {
  const a = await heldAndPaid(), b = await heldAndPaid();
  const release = (id) => call(h.release, { method: "POST", headers: freshIp(), body: { id } });

  assert.equal((await release(a.id)).status, 200);
  assert.equal(await status(a.slot), "open");
  const rebooked = await hold(a.slot);
  assert.equal(rebooked.status, 200, "freed slot can be booked again");

  await verify(b.id, b.p);
  assert.equal((await release(b.id)).status, 200);
  assert.equal(await status(b.slot), "booked");

  await release(a.id); // stale release must not free the slot's new holder
  assert.equal(await status(a.slot), "held");
  assert.equal((await release(crypto.randomUUID())).status, 404);
});

test("release then pay: a customer who paid after going back is still confirmed if the slot is free", { skip }, async () => {
  const { slot, id, p } = await heldAndPaid();
  await call(h.release, { method: "POST", headers: freshIp(), body: { id } });
  assert.equal((await verify(id, p)).status, 200);
  assert.equal(await slotValue(slot), `booked:${id}`);
});

// ---------- promo codes ----------

const promoBook = (slot, code, extra = {}, headers) => hold(slot, { promoCode: code, ...extra }, headers);

test("promo: admin creates codes and lists them", { skip }, async () => {
  assert.equal((await adminPost({ action: "promo_create", code: "fresher-test", maxUses: 2 })).status, 200);
  assert.equal((await adminPost({ action: "promo_create", code: "FRESHER-TEST" })).status, 409, "same code twice");
  for (const bad of [{ code: "a b!" }, { code: "xx" }, { code: "OK-CODE", maxUses: 0 }, { code: "OK-CODE", maxUses: "5" }, { code: "OK-CODE", expires: "tomorrow" }]) {
    assert.equal((await adminPost({ action: "promo_create", ...bad })).status, 400, JSON.stringify(bad));
  }
  const list = await admin({ query: { view: "promos" } });
  const promo = list.body.promos.find((p) => p.code === "FRESHER-TEST");
  assert.deepEqual([promo.active, promo.uses, promo.maxUses], [true, 0, 2]);
});

test("promo: a valid code books the session for ₹0 with no payment step", { skip }, async () => {
  await adminPost({ action: "promo_create", code: "FREE-ONE" });
  const s = nextSlot();
  const orders = rzp.countCalls("POST /v1/orders");
  const r = await promoBook(s, "  free-one ", { email: "fresher1@example.com" }); // case and spaces don't matter
  assert.equal(r.status, 200);
  assert.equal(r.body.free, true);
  assert.equal(r.body.status, "confirmed");
  assert.equal(r.body.order, undefined);
  assert.equal(rzp.countCalls("POST /v1/orders"), orders, "no Razorpay order for a free booking");
  assert.equal(await status(s), "booked");

  const saved = await record(r.body.id);
  assert.deepEqual([saved.status, saved.amountPaise, saved.promoCode], ["confirmed", 0, "FREE-ONE"]);
  const list = await admin({ query: { view: "promos" } });
  assert.equal(list.body.promos.find((p) => p.code === "FREE-ONE").uses, 1);
});

test("promo: one redemption per email, and the use limit is enforced", { skip }, async () => {
  await adminPost({ action: "promo_create", code: "TWO-USES", maxUses: 2 });
  const used = (r) => r.body.error;

  assert.equal((await promoBook(nextSlot(), "TWO-USES", { email: "a@example.com" })).status, 200);
  assert.equal(used(await promoBook(nextSlot(), "TWO-USES", { email: "A@Example.com" })), "invalid_promo", "same email, any case");
  assert.equal((await promoBook(nextSlot(), "TWO-USES", { email: "b@example.com" })).status, 200);
  assert.equal(used(await promoBook(nextSlot(), "TWO-USES", { email: "c@example.com" })), "invalid_promo", "limit reached");
});

test("promo: unknown, malformed, expired and disabled codes are all just 'invalid'", { skip }, async () => {
  const s = nextSlot();
  assert.equal((await promoBook(s, "NO-SUCH-CODE")).body.error, "invalid_promo");
  assert.equal((await promoBook(s, "a b!")).body.error, "invalid_promo");
  assert.equal((await promoBook(s, 12345)).body.error, "invalid_promo");

  await adminPost({ action: "promo_create", code: "OLD-CODE", expires: "2099-01-01" });
  await db.cmd(["HSET", "promos", "OLD-CODE", JSON.stringify({ code: "OLD-CODE", active: true, uses: 0, expiresAt: Date.now() - 1000 })]);
  assert.equal((await promoBook(s, "OLD-CODE")).body.error, "invalid_promo");

  await adminPost({ action: "promo_create", code: "OFF-CODE" });
  assert.equal((await adminPost({ action: "promo_disable", code: "OFF-CODE" })).status, 200);
  assert.equal((await promoBook(s, "OFF-CODE")).body.error, "invalid_promo");
  assert.equal((await adminPost({ action: "promo_disable", code: "NOPE-NOPE" })).status, 404);

  assert.equal(await status(s), "open", "failed promo attempts never claim the slot");
});

test("promo: a taken slot doesn't use up the code", { skip }, async () => {
  await adminPost({ action: "promo_create", code: "KEEP-ME", maxUses: 1 });
  const s = nextSlot();
  assert.equal((await hold(s)).status, 200); // someone else holds it
  const r = await promoBook(s, "KEEP-ME", { email: "x@example.com" });
  assert.equal(r.status, 409);
  const promo = (await admin({ query: { view: "promos" } })).body.promos.find((p) => p.code === "KEEP-ME");
  assert.equal(promo.uses, 0);
  assert.equal((await promoBook(nextSlot(), "KEEP-ME", { email: "x@example.com" })).status, 200, "still redeemable elsewhere");
});

test("promo: free bookings still validate the form and work without Razorpay keys", { skip }, async () => {
  await adminPost({ action: "promo_create", code: "NO-KEYS" });
  assert.equal((await promoBook(nextSlot(), "NO-KEYS", { name: "" })).body.field, "name");

  const savedId = process.env.RAZORPAY_KEY_ID;
  delete process.env.RAZORPAY_KEY_ID;
  try {
    assert.equal((await promoBook(nextSlot(), "NO-KEYS", { email: "nokeys@example.com" })).status, 200);
  } finally { process.env.RAZORPAY_KEY_ID = savedId; }
});

test("promo: guessing codes is rate limited", { skip }, async () => {
  const headers = freshIp();
  const codes = [];
  for (let i = 0; i < 12; i++) codes.push((await promoBook(nextSlot(), `GUESS-${i}`, {}, headers)).status);
  assert.ok(codes.includes(429), `expected a 429 in ${codes}`);
});

test("promo: admin can cancel a free booking; refund says there's nothing to refund", { skip }, async () => {
  await adminPost({ action: "promo_create", code: "CANCEL-ME" });
  const s = nextSlot();
  const r = await promoBook(s, "CANCEL-ME", { email: "cm@example.com" });
  assert.equal((await adminPost({ id: r.body.id, action: "refund" })).body.error, "nothing_to_refund");
  assert.equal((await adminPost({ id: r.body.id, action: "cancel" })).status, 200);
  assert.equal(await status(s), "open");
});

// ---------- admin ----------

test("admin: disabled without a token; wrong tokens are refused", { skip }, async () => {
  delete process.env.ADMIN_TOKEN;
  assert.equal((await call(h.admin, { headers: freshIp() })).status, 404);
  process.env.ADMIN_TOKEN = ADMIN;
  assert.equal((await call(h.admin, { headers: freshIp() })).status, 401);
  assert.equal((await call(h.admin, { headers: { ...freshIp(), authorization: "Bearer wrong" } })).status, 401);
});

test("admin: lists paid bookings, cancels, and refunds through Razorpay", { skip }, async () => {
  const paid = await heldAndPaid();
  await verify(paid.id, paid.p);

  const list = await admin({ query: { status: "confirmed" } });
  const row = list.body.bookings.find((b) => b.id === paid.id);
  assert.equal(row.paymentId, paid.p.paymentId);
  assert.equal(row.email.includes("@example.com"), true);

  assert.equal((await adminPost({ id: paid.id, action: "explode" })).status, 400);
  assert.equal((await adminPost({ id: "x", action: "cancel" })).status, 400);

  const refund = await adminPost({ id: paid.id, action: "refund" });
  assert.equal(refund.status, 200);
  assert.equal(rzp.payments.get(paid.p.paymentId).status, "refunded");
  assert.equal((await record(paid.id)).status, "refunded");
  assert.equal(await status(paid.slot), "open", "refund frees the slot");
  assert.equal((await adminPost({ id: paid.id, action: "refund" })).status, 200, "refunding twice is safe");

  // cancel (no refund) of another paid booking points out the money is still there
  const other = await heldAndPaid();
  await verify(other.id, other.p);
  const cancel = await adminPost({ id: other.id, action: "cancel" });
  assert.equal(cancel.body.paid, true);
  assert.equal(await status(other.slot), "open");
  assert.equal(rzp.payments.get(other.p.paymentId).status, "captured");
  assert.equal((await adminPost({ id: other.id, action: "refund" })).status, 200, "can refund after cancelling");
});

test("admin: hides expired holds unless asked", { skip }, async () => {
  const { body } = await hold(nextSlot());
  const stale = await record(body.id);
  stale.holdExpiresAt = Date.now() - 1000;
  await db.cmd(["HSET", "bookings", body.id, JSON.stringify(stale)]);
  assert.ok(!(await admin()).body.bookings.some((x) => x.id === body.id));
  assert.ok((await admin({ query: { all: "1" } })).body.bookings.some((x) => x.id === body.id));
});

// ---------- health and outages ----------

test("health: reports Redis and which Razorpay settings are present", { skip }, async () => {
  assert.deepEqual((await call(h.health)).body, { ok: true, payments: true, webhook: true });

  const savedUrl = process.env.UPSTASH_REDIS_REST_URL, savedHook = process.env.RAZORPAY_WEBHOOK_SECRET;
  process.env.UPSTASH_REDIS_REST_URL = "http://127.0.0.1:1";
  delete process.env.RAZORPAY_WEBHOOK_SECRET;
  const origError = console.error; console.error = () => {};
  try {
    const r = await call(h.health);
    assert.equal(r.status, 503);
    assert.deepEqual(r.body, { ok: false, payments: true, webhook: false });
  } finally { console.error = origError; process.env.UPSTASH_REDIS_REST_URL = savedUrl; process.env.RAZORPAY_WEBHOOK_SECRET = savedHook; }
});

test("redis config: accepts the Vercel integration's KV_REST_API_* names", { skip }, async () => {
  const url = process.env.UPSTASH_REDIS_REST_URL, token = process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.UPSTASH_REDIS_REST_URL; delete process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.KV_REST_API_URL = url; process.env.KV_REST_API_TOKEN = token;
  try {
    assert.equal((await call(h.health)).status, 200);
  } finally {
    delete process.env.KV_REST_API_URL; delete process.env.KV_REST_API_TOKEN;
    process.env.UPSTASH_REDIS_REST_URL = url; process.env.UPSTASH_REDIS_REST_TOKEN = token;
  }
});

test("a Redis outage is a 500, not a crash or a silent success", { skip }, async () => {
  const s = nextSlot();
  const saved = process.env.UPSTASH_REDIS_REST_URL;
  process.env.UPSTASH_REDIS_REST_URL = "http://127.0.0.1:1";
  const origError = console.error; console.error = () => {};
  try {
    assert.equal((await hold(s)).status, 500);
    assert.equal((await call(h.slots, { query: { date: s.date } })).status, 500);
  } finally { console.error = origError; process.env.UPSTASH_REDIS_REST_URL = saved; }
  assert.equal(await status(s), "open");
});
