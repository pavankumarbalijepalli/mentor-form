// Integration tests: the real handlers + Lua scripts against a real redis-server,
// with a local mock standing in for PhonePe's API.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { CONFIG } from "../api/_config.js";
import { isSlotOpen, addDays, todayKey } from "../public/js/dates.js";
import { call, hasRedis, startRedis } from "../test-helpers/redis.js";
import { startPhonePeMock } from "../test-helpers/phonepe.js";

const skip = hasRedis ? false : "redis-server not installed";
const ADMIN = "s3cret-token";

let db, pp, h;
const openSlots = [];

before(async () => {
  if (skip) return;
  db = await startRedis();
  pp = await startPhonePeMock();
  process.env.ADMIN_TOKEN = ADMIN;
  CONFIG.bookingWindowDays = 90; // plenty of distinct slots for the tests below
  h = {};
  for (const n of ["book", "webhook", "status", "release", "slots", "admin", "config", "health"]) {
    h[n] = (await import(`../api/${n}.js`)).default;
  }
  const now = Date.now();
  for (let i = 0; i < CONFIG.bookingWindowDays; i++) {
    const date = addDays(todayKey(now, CONFIG.utcOffsetMinutes), i);
    for (const time of CONFIG.timeSlots) if (isSlotOpen(date, time, now, CONFIG)) openSlots.push({ date, time });
  }
});
after(() => { db?.stop(); pp?.stop(); });

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
const poll = (id, headers = freshIp()) => call(h.status, { query: { id }, headers });
const admin = (opts = {}) => call(h.admin, { ...opts, headers: { ...freshIp(), authorization: `Bearer ${ADMIN}`, ...opts.headers } });
const adminPost = (body) => admin({ method: "POST", body });
const deliver = (hook, headers = {}) =>
  call(h.webhook, { method: "POST", body: hook.body, headers: { authorization: hook.authorization, ...headers } });
const quiet = async (fn) => { const orig = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = orig; } };

// A booking held and then paid for on PhonePe's page (nobody has told our server yet).
async function heldAndPaid(opts) {
  const slot = nextSlot();
  const { body } = await hold(slot);
  pp.complete(body.id, opts);
  return { slot, id: body.id };
}

// ---------- basics ----------

test("config exposes the schedule and price but no payment secrets", { skip }, async () => {
  const r = await call(h.config);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.timeSlots, CONFIG.timeSlots);
  assert.equal(r.body.amount, 899);
  assert.equal(r.body.timezone, "Asia/Kolkata");
  assert.ok(!JSON.stringify(r.body).match(/secret|password|client_id|upi/i));
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
  assert.equal(pp.countCalls("POST /pg/checkout/v2/pay"), 0, "no PhonePe order for invalid requests");
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

test("book: holds the slot and creates a PhonePe order for ₹899 on the server", { skip }, async () => {
  const s = nextSlot();
  const r = await hold(s, { amount: 1, amountPaise: 100 }); // client-supplied amounts must be ignored
  assert.equal(r.status, 200);
  assert.match(r.body.ref, /^[0-9A-F]{8}$/);
  assert.equal(r.body.payUrl, `https://pay.phonepe.test/${r.body.id}`);
  assert.equal(await status(s), "held");

  const order = pp.orders.get(r.body.id);
  assert.equal(order.amount, 89900);
  assert.equal(order.expireAfter, CONFIG.holdMinutes * 60);
  assert.equal(order.returnUrl, `https://mentor.test/?booking=${r.body.id}`, "customer comes back to the booking");
  assert.equal(order.meta.udf1, r.body.ref);
  assert.match(order.meta.udf2, /IST$/);

  const saved = await record(r.body.id);
  assert.equal(saved.status, "held");
  assert.equal(saved.orderId, r.body.id);
  assert.equal(saved.payUrl, r.body.payUrl);
  assert.equal(saved.amountPaise, 89900);
  assert.equal(saved.email.includes("@example.com"), true, "email lower-cased");

  const second = await hold(s);
  assert.equal(second.status, 409);
  assert.equal(second.body.error, "slot_taken");
});

test("book: concurrent requests for one slot produce one winner and one order", { skip }, async () => {
  const s = nextSlot();
  const before = pp.countCalls("POST /pg/checkout/v2/pay");
  const results = await Promise.all(Array.from({ length: 10 }, () => hold(s)));
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal(results.filter((r) => r.status === 409).length, 9);
  assert.equal(pp.countCalls("POST /pg/checkout/v2/pay") - before, 1, "losers must not create orders");
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
  const real = Array.from({ length: 8 }, nextSlot);
  for (const s of real) limited.push((await hold(s, {}, headers)).status);
  assert.deepEqual(limited.slice(0, 6), [200, 200, 200, 200, 200, 200]);
  assert.deepEqual(limited.slice(6), [429, 429]);
  assert.equal(await status(real[6]), "open", "rate-limited request must not claim a slot");
});

test("book: if PhonePe is down the hold is released and the visitor gets a 502", { skip }, async () => {
  const s = nextSlot();
  pp.failPay = true;
  try {
    const r = await quiet(() => hold(s));
    assert.equal(r.status, 502);
    assert.equal(r.body.error, "payment_unavailable");
  } finally { pp.failPay = false; }
  assert.equal(await status(s), "open");
  assert.equal((await hold(s)).status, 200, "slot is bookable again");
});

test("book: without PhonePe credentials a paid booking is refused before touching the slot", { skip }, async () => {
  const s = nextSlot();
  const saved = process.env.PHONEPE_CLIENT_SECRET;
  delete process.env.PHONEPE_CLIENT_SECRET;
  try {
    assert.equal((await quiet(() => hold(s))).status, 503);
  } finally { process.env.PHONEPE_CLIENT_SECRET = saved; }
  assert.equal(await status(s), "open");
});

test("auth: the access token is reused, refreshed when it stops working, and bad credentials fail safely", { skip }, async () => {
  await hold(nextSlot()); // make sure a token is cached
  const issued = pp.tokensIssued;
  await hold(nextSlot()); await hold(nextSlot());
  assert.equal(pp.tokensIssued, issued, "token reused across requests");

  pp.expireTokens(); // PhonePe invalidates it early
  const r = await hold(nextSlot());
  assert.equal(r.status, 200, "retried once with a fresh token");
  assert.equal(pp.tokensIssued, issued + 1);

  const s = nextSlot();
  pp.expireTokens(); pp.failAuth = true;
  try {
    assert.equal((await quiet(() => hold(s))).status, 502);
  } finally { pp.failAuth = false; }
  assert.equal(await status(s), "open", "hold released when PhonePe won't authenticate us");
});

// ---------- coming back from PhonePe: the status check ----------

test("status: while PhonePe is still working the booking stays held and says so", { skip }, async () => {
  const s = nextSlot();
  const { body } = await hold(s);
  const r = await poll(body.id);
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.status, r.body.payment, r.body.ref, r.body.payUrl], ["held", "pending", body.ref, body.payUrl]);
  assert.ok(r.body.holdExpiresAt > Date.now());
});

test("status: a paid order confirms the booking, even if the webhook never came", { skip }, async () => {
  const { slot, id } = await heldAndPaid();
  const r = await poll(id);
  assert.equal(r.body.status, "confirmed");
  assert.equal(r.body.payment, "completed");
  assert.equal(r.body.payUrl, undefined, "no payment link once paid");
  assert.equal(await status(slot), "booked");
  assert.equal(await slotValue(slot), `booked:${id}`);
  const saved = await record(id);
  assert.equal(saved.status, "confirmed");
  assert.match(saved.paymentId, /^OMO/);
});

test("status: repeating the check is harmless and doesn't bother PhonePe again", { skip }, async () => {
  const { id } = await heldAndPaid();
  await poll(id);
  const calls = pp.countCalls("GET /pg/checkout/v2/order");
  assert.equal((await poll(id)).body.status, "confirmed");
  assert.equal(pp.countCalls("GET /pg/checkout/v2/order"), calls);
  assert.equal(pp.refunds.has(`rf-${id}`), false, "a normal paid booking is never refunded");
});

test("status: a failed payment leaves the booking held with a link to try again", { skip }, async () => {
  const s = nextSlot();
  const { body } = await hold(s);
  pp.fail(body.id);
  const r = await poll(body.id);
  assert.deepEqual([r.body.status, r.body.payment, r.body.payUrl], ["held", "failed", body.payUrl]);
  assert.equal(await status(s), "held");
  pp.orders.get(body.id).state = "COMPLETED"; // they retried on PhonePe's page and it worked
  assert.equal((await poll(body.id)).body.status, "confirmed");
});

test("status: a payment for the wrong amount is never accepted", { skip }, async () => {
  const { slot, id } = await heldAndPaid({ amount: 100 });
  const r = await quiet(() => poll(id));
  assert.equal(r.body.payment, "mismatch");
  assert.equal(r.body.status, "held");
  assert.equal(await status(slot), "held");
});

test("status: bad ids are rejected and PhonePe being unreachable doesn't break the answer", { skip }, async () => {
  assert.equal((await poll(crypto.randomUUID())).status, 404);
  assert.equal((await poll("x")).status, 400);

  const { body } = await hold(nextSlot());
  const saved = process.env.PHONEPE_API_BASE;
  process.env.PHONEPE_API_BASE = "http://127.0.0.1:1/pg";
  try {
    const r = await quiet(() => poll(body.id));
    assert.deepEqual([r.status, r.body.status, r.body.payment], [200, "held", null]);
  } finally { process.env.PHONEPE_API_BASE = saved; }
});

// ---------- late payments ----------

test("late payment: if the hold lapsed but nobody took the slot, the booking is still confirmed", { skip }, async () => {
  const { slot, id } = await heldAndPaid();
  await expireHold(slot, id);
  assert.equal((await poll(id)).body.status, "confirmed");
  assert.equal(await slotValue(slot), `booked:${id}`);
});

test("late payment: if the slot went elsewhere the customer is refunded automatically, once", { skip }, async () => {
  const { slot, id } = await heldAndPaid();
  await expireHold(slot, id);
  const winner = await hold(slot);
  assert.equal(winner.status, 200);

  const r = await poll(id);
  assert.equal(r.body.status, "refunded");
  assert.equal((await record(id)).status, "refunded");
  const refund = pp.refunds.get(`rf-${id}`);
  assert.deepEqual([refund.amount, pp.refunds.size > 0], [89900, true]);
  assert.ok((await slotValue(slot)).startsWith(`hold:${winner.body.id}`), "the new holder keeps the slot");

  const refundsBefore = pp.refunds.size;
  assert.equal((await poll(id)).body.status, "refunded");
  assert.equal(pp.refunds.size, refundsBefore, "repeating the check never refunds twice");
});

test("late payment: if the automatic refund fails it is left as refund_due and admin can retry", { skip }, async () => {
  const { slot, id } = await heldAndPaid();
  await expireHold(slot, id);
  const winner = await hold(slot);
  pp.failRefunds = true;
  try {
    assert.equal((await quiet(() => poll(id))).body.status, "refund_due");
  } finally { pp.failRefunds = false; }

  const due = await admin({ query: { status: "refund_due" } });
  assert.ok(due.body.bookings.some((b) => b.id === id));
  assert.equal((await adminPost({ id, action: "refund" })).status, 200);
  assert.equal((await record(id)).status, "refunded");
  assert.ok(pp.refunds.has(`rf-${id}`));
  assert.ok((await slotValue(slot)).startsWith(`hold:${winner.body.id}`), "refunding must not free the other person's slot");
});

test("release: frees a held slot but never undoes a confirmed booking", { skip }, async () => {
  const a = await heldAndPaid(), b = await heldAndPaid();
  const release = (id) => call(h.release, { method: "POST", headers: freshIp(), body: { id } });

  assert.equal((await release(a.id)).status, 200);
  assert.equal(await status(a.slot), "open");
  const rebooked = await hold(a.slot);
  assert.equal(rebooked.status, 200, "freed slot can be booked again");

  await poll(b.id); // b is paid and confirmed
  assert.equal((await release(b.id)).status, 200);
  assert.equal(await status(b.slot), "booked");

  await release(a.id); // stale release must not free the slot's new holder
  assert.equal(await status(a.slot), "held");
  assert.equal((await release(crypto.randomUUID())).status, 404);
});

test("release then pay: a customer who paid after going back is still confirmed if the slot is free", { skip }, async () => {
  const { slot, id } = await heldAndPaid();
  await call(h.release, { method: "POST", headers: freshIp(), body: { id } });
  assert.equal((await poll(id)).body.status, "confirmed");
  assert.equal(await slotValue(slot), `booked:${id}`);
});

// ---------- webhook ----------

test("webhook: confirms a payment the customer never came back from", { skip }, async () => {
  const { slot, id } = await heldAndPaid();
  const r = await deliver(pp.webhook(id));
  assert.deepEqual([r.status, r.body.status, r.body.payment], [200, "confirmed", "completed"]);
  assert.equal(await status(slot), "booked");

  // retries and the customer returning afterwards are all harmless
  assert.equal((await deliver(pp.webhook(id))).body.status, "confirmed");
  assert.equal((await poll(id)).body.status, "confirmed");
  assert.equal(pp.refunds.has(`rf-${id}`), false);
});

test("webhook: accepts the authorization header as bare hex, upper-case hex, or with a SHA256 prefix", { skip }, async () => {
  for (const [label, tweak] of [["prefix", { prefix: "SHA256 " }], ["upper", { upper: true }]]) {
    const { id } = await heldAndPaid();
    const hook = pp.webhook(id, tweak.prefix ? tweak : {});
    if (tweak.upper) hook.authorization = hook.authorization.toUpperCase();
    assert.equal((await deliver(hook)).status, 200, label);
    assert.equal((await record(id)).status, "confirmed", label);
  }
});

test("webhook: refuses wrong or missing credentials and changes nothing", { skip }, async () => {
  const { slot, id } = await heldAndPaid();
  assert.equal((await deliver(pp.webhook(id, { pass: "wrong" }))).status, 401);
  assert.equal((await deliver({ body: pp.webhook(id).body, authorization: undefined })).status, 401);
  assert.equal((await deliver({ body: pp.webhook(id).body, authorization: "garbage" })).status, 401);
  assert.equal(await status(slot), "held");
  assert.equal((await record(id)).status, "held");
});

test("webhook: even a correctly authenticated body is not believed, PhonePe decides", { skip }, async () => {
  const s = nextSlot();
  const { body } = await hold(s); // PhonePe says this order is still PENDING
  const r = await deliver(pp.webhook(body.id, { state: "COMPLETED" }));
  assert.equal(r.status, 200);
  assert.equal(r.body.payment, "pending");
  assert.equal(await status(s), "held");

  const failed = await hold(nextSlot());
  pp.fail(failed.body.id);
  assert.equal((await deliver(pp.webhook(failed.body.id, { event: "checkout.order.failed", state: "FAILED" }))).body.payment, "failed");
  assert.equal((await record(failed.body.id)).status, "held");
});

test("webhook: ignores orders that aren't ours and bodies it doesn't understand", { skip }, async () => {
  for (const hook of [
    pp.webhook(crypto.randomUUID()),
    pp.webhook("someone-elses-order"),
    { body: {}, authorization: pp.webhook("x").authorization },
    { body: { event: "pg.refund.completed", payload: { originalMerchantOrderId: crypto.randomUUID() } }, authorization: pp.webhook("x").authorization },
  ]) {
    const r = await deliver(hook);
    assert.deepEqual([r.status, r.body.ignored], [200, true]);
  }
  assert.equal((await call(h.webhook, { method: "GET" })).status, 405);
});

test("webhook: says so when the webhook credentials aren't configured", { skip }, async () => {
  const { id } = await heldAndPaid();
  const hook = pp.webhook(id);
  const saved = process.env.PHONEPE_WEBHOOK_PASSWORD;
  delete process.env.PHONEPE_WEBHOOK_PASSWORD;
  try {
    assert.equal((await quiet(() => deliver(hook))).status, 503);
  } finally { process.env.PHONEPE_WEBHOOK_PASSWORD = saved; }
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
  const orders = pp.countCalls("POST /pg/checkout/v2/pay");
  const r = await promoBook(s, "  free-one ", { email: "fresher1@example.com" }); // case and spaces don't matter
  assert.equal(r.status, 200);
  assert.equal(r.body.free, true);
  assert.equal(r.body.status, "confirmed");
  assert.equal(r.body.payUrl, undefined);
  assert.equal(pp.countCalls("POST /pg/checkout/v2/pay"), orders, "no PhonePe order for a free booking");
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

test("promo: free bookings still validate the form and work without PhonePe credentials", { skip }, async () => {
  await adminPost({ action: "promo_create", code: "NO-KEYS" });
  assert.equal((await promoBook(nextSlot(), "NO-KEYS", { name: "" })).body.field, "name");

  const savedId = process.env.PHONEPE_CLIENT_ID;
  delete process.env.PHONEPE_CLIENT_ID;
  try {
    assert.equal((await promoBook(nextSlot(), "NO-KEYS", { email: "nokeys@example.com" })).status, 200);
  } finally { process.env.PHONEPE_CLIENT_ID = savedId; }
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

test("admin: lists paid bookings, cancels, and refunds through PhonePe", { skip }, async () => {
  const paid = await heldAndPaid();
  await poll(paid.id);

  const list = await admin({ query: { status: "confirmed" } });
  const row = list.body.bookings.find((b) => b.id === paid.id);
  assert.match(row.paymentId, /^OMO/);
  assert.equal(row.email.includes("@example.com"), true);

  assert.equal((await adminPost({ id: paid.id, action: "explode" })).status, 400);
  assert.equal((await adminPost({ id: "x", action: "cancel" })).status, 400);

  assert.equal((await adminPost({ id: paid.id, action: "refund" })).status, 200);
  assert.equal(pp.refunds.get(`rf-${paid.id}`).amount, 89900);
  assert.equal((await record(paid.id)).status, "refunded");
  assert.equal(await status(paid.slot), "open", "refund frees the slot");
  const refunds = pp.refunds.size;
  assert.equal((await adminPost({ id: paid.id, action: "refund" })).status, 200, "refunding twice is safe");
  assert.equal(pp.refunds.size, refunds, "and never pays out twice");

  // cancel (no refund) of another paid booking points out the money is still there
  const other = await heldAndPaid();
  await poll(other.id);
  const cancel = await adminPost({ id: other.id, action: "cancel" });
  assert.equal(cancel.body.paid, true);
  assert.equal(await status(other.slot), "open");
  assert.equal(pp.refunds.has(`rf-${other.id}`), false);
  assert.equal((await adminPost({ id: other.id, action: "refund" })).status, 200, "can refund after cancelling");
  assert.ok(pp.refunds.has(`rf-${other.id}`));
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

test("health: reports Redis, which PhonePe settings are present, and where customers are sent back", { skip }, async () => {
  assert.deepEqual((await call(h.health)).body, { ok: true, payments: true, webhook: true, siteUrl: "https://mentor.test" });

  const savedUrl = process.env.UPSTASH_REDIS_REST_URL, savedPass = process.env.PHONEPE_WEBHOOK_PASSWORD;
  process.env.UPSTASH_REDIS_REST_URL = "http://127.0.0.1:1";
  delete process.env.PHONEPE_WEBHOOK_PASSWORD;
  try {
    const r = await quiet(() => call(h.health));
    assert.equal(r.status, 503);
    assert.deepEqual([r.body.ok, r.body.payments, r.body.webhook], [false, true, false]);
  } finally { process.env.UPSTASH_REDIS_REST_URL = savedUrl; process.env.PHONEPE_WEBHOOK_PASSWORD = savedPass; }
});

test("config: PhonePe needs PHONEPE_ENV unless the hosts are overridden", { skip }, async () => {
  const { paymentsConfigured } = await import("../api/_phonepe.js");
  const base = process.env.PHONEPE_API_BASE;
  delete process.env.PHONEPE_API_BASE;
  try {
    delete process.env.PHONEPE_ENV;
    assert.equal(paymentsConfigured(), false, "no environment chosen");
    process.env.PHONEPE_ENV = "staging";
    assert.equal(paymentsConfigured(), false, "unknown environment");
    for (const env of ["sandbox", "production"]) { process.env.PHONEPE_ENV = env; assert.equal(paymentsConfigured(), true, env); }
  } finally { process.env.PHONEPE_API_BASE = base; delete process.env.PHONEPE_ENV; }
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
