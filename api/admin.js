// Mentor-only management. Send `Authorization: Bearer <ADMIN_TOKEN>`.
//   GET  /api/admin[?status=confirmed][&all=1]   -> { bookings }, newest first
//   GET  /api/admin?view=promos                  -> { promos }
//   POST /api/admin { id, action: "cancel" }     free the slot (no refund)
//   POST /api/admin { id, action: "refund" }     refund the payment through Razorpay and free the slot
//   POST /api/admin { action: "promo_create", code, maxUses?, expires? }   expires = "YYYY-MM-DD" (end of that day, IST)
//   POST /api/admin { action: "promo_disable", code }
// Disabled (404) until the ADMIN_TOKEN environment variable is set.
import { timingSafeEqual } from "node:crypto";
import { CONFIG } from "./_config.js";
import { addDays, isDateKey } from "../public/js/dates.js";
import {
  clientIp, createPromo, disablePromo, getBooking, isBookingId, isRateLimited, jsonBody, listPromos,
  normalizePromo, redis, send, serverError, transitionBooking,
} from "./_lib.js";
import { refundPayment } from "./_razorpay.js";

function authorized(req) {
  const expected = process.env.ADMIN_TOKEN;
  const m = /^Bearer (.+)$/.exec(req.headers?.authorization || "");
  if (!expected || !m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function bookingAction(res, id, action, now) {
  if (!isBookingId(id)) return send(res, 400, { error: "invalid_id" });

  if (action === "cancel") {
    const result = await transitionBooking(id, "cancelled", ["held", "confirmed", "refund_due"], true, now);
    if (result === "not_found") return send(res, 404, { error: "not_found" });
    if (result !== "ok") return send(res, 409, { error: result });
    const booking = await getBooking(id);
    return send(res, 200, { success: true, paid: Boolean(booking.paymentId), note: booking.paymentId ? "Cancelled without a refund. Use action \"refund\" to return the payment." : undefined });
  }

  // refund
  const booking = await getBooking(id);
  if (!booking) return send(res, 404, { error: "not_found" });
  if (!booking.paymentId) return send(res, 400, { error: "nothing_to_refund" });
  await refundPayment(booking.paymentId, { reason: "Refunded by mentor", bookingId: id });
  const result = await transitionBooking(id, "refunded", ["confirmed", "cancelled", "refund_due", "refunded"], true, now);
  if (result !== "ok") return send(res, 409, { error: result });
  return send(res, 200, { success: true });
}

async function promoAction(res, body) {
  const code = normalizePromo(body.code);
  if (!code) return send(res, 400, { error: "invalid_code", hint: "3-32 characters: letters, numbers, - or _" });

  if (body.action === "promo_disable") {
    return (await disablePromo(code)) ? send(res, 200, { success: true }) : send(res, 404, { error: "not_found" });
  }

  let maxUses;
  if (body.maxUses != null) {
    if (!Number.isInteger(body.maxUses) || body.maxUses < 1) return send(res, 400, { error: "invalid_maxUses" });
    maxUses = body.maxUses;
  }
  let expiresAt;
  if (body.expires != null) {
    if (!isDateKey(body.expires)) return send(res, 400, { error: "invalid_expires", hint: "use YYYY-MM-DD" });
    // valid through the end of that day in IST
    expiresAt = Date.parse(`${addDays(body.expires, 1)}T00:00:00Z`) - CONFIG.utcOffsetMinutes * 60000;
  }
  const promo = await createPromo({ code, maxUses, expiresAt });
  return promo ? send(res, 200, { success: true, promo }) : send(res, 409, { error: "code_exists" });
}

export default async function handler(req, res) {
  if (!process.env.ADMIN_TOKEN) return send(res, 404, { error: "not_found" });

  try {
    if (await isRateLimited("admin", clientIp(req), 60, 600)) {
      return send(res, 429, { error: "rate_limited" });
    }
    if (!authorized(req)) return send(res, 401, { error: "unauthorized" });

    const now = Date.now();

    if (req.method === "GET") {
      const { status, all, view } = req.query || {};
      if (view === "promos") return send(res, 200, { promos: await listPromos() });

      let bookings = (await redis(["HVALS", "bookings"])).map((v) => JSON.parse(v));
      // Abandoned holds are noise unless asked for.
      if (!all) bookings = bookings.filter((b) => b.status !== "held" || b.holdExpiresAt > now);
      if (status) bookings = bookings.filter((b) => b.status === status);
      bookings.sort((x, y) => (y.createdAt || "").localeCompare(x.createdAt || ""));
      return send(res, 200, { bookings });
    }

    if (req.method === "POST") {
      const body = jsonBody(req);
      if (body.action === "cancel" || body.action === "refund") return bookingAction(res, body.id, body.action, now);
      if (body.action === "promo_create" || body.action === "promo_disable") return promoAction(res, body);
      return send(res, 400, { error: "invalid_action" });
    }

    res.setHeader("Allow", "GET, POST");
    return send(res, 405, { error: "method_not_allowed" });
  } catch (err) {
    return serverError(res, err);
  }
}
