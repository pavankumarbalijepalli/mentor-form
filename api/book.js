// POST /api/book — start a booking.
// Body: { date, time, name, email, whatsapp, focus, context, promoCode? }
//
// Paid:   reserves the slot for CONFIG.holdMinutes and creates a PhonePe order.
//         -> { success, id, ref, expiresAt, payUrl }   (send the customer to payUrl)
// Promo:  a valid promo code books the slot for free straight away.
//         -> { success, id, ref, free: true, status: "confirmed", date, time }
// Errors: 400 invalid_field | invalid_slot | invalid_promo, 409 slot_taken,
//         429 rate_limited, 503/502 payment_unavailable
import { CONFIG, amountPaise } from "./_config.js";
import { isSlotOpen } from "../public/js/dates.js";
import {
  attachOrder, claimFreeSlot, claimSlot, clientIp, isRateLimited, jsonBody, normalizePromo, refOf,
  requireMethod, send, serverError, transitionBooking, validateBooking,
} from "./_lib.js";
import { createPayment, paymentsConfigured, siteUrl } from "./_phonepe.js";

export default async function handler(req, res) {
  if (!requireMethod(req, res, "POST")) return;

  const body = jsonBody(req);
  if (body.website) return send(res, 400, { error: "invalid_request" }); // honeypot field, humans leave it empty

  const parsed = validateBooking(body);
  if (parsed.error) return send(res, 400, { error: "invalid_field", field: parsed.error });

  const { date, time } = body;
  const nowMs = Date.now();
  if (!isSlotOpen(date, time, nowMs, CONFIG)) return send(res, 400, { error: "invalid_slot" });

  const code = normalizePromo(body.promoCode);
  if (code === null) return send(res, 400, { error: "invalid_promo" });

  try {
    // Every hold blocks a slot for everyone else, so keep one visitor from grabbing them all.
    const ip = clientIp(req);
    if (await isRateLimited("book", ip, 6, 600)) return send(res, 429, { error: "rate_limited" });

    const id = crypto.randomUUID();
    const ref = refOf(id);

    if (code) {
      if (await isRateLimited("promo", ip, 10, 900)) return send(res, 429, { error: "rate_limited" });
      const result = await claimFreeSlot({ id, date, time, booking: parsed.value, code, nowMs });
      if (result === "ok") return send(res, 200, { success: true, id, ref, free: true, status: "confirmed", date, time });
      if (result === "slot_taken") return send(res, 409, { error: "slot_taken" });
      return send(res, 400, { error: "invalid_promo" }); // unknown, expired, used up or already used by this email
    }

    if (!paymentsConfigured()) {
      console.error("Payment attempt while PhonePe is not configured");
      return send(res, 503, { error: "payment_unavailable" });
    }

    const hold = await claimSlot({ id, date, time, booking: parsed.value, nowMs });
    if (!hold) return send(res, 409, { error: "slot_taken" });

    try {
      const order = await createPayment({
        merchantOrderId: id,
        amount: amountPaise(),
        expireAfter: CONFIG.holdMinutes * 60,
        redirectUrl: `${siteUrl()}/?booking=${id}`, // the customer lands here after paying or giving up
        meta: { udf1: ref, udf2: `${date} ${time} IST` },
      });
      if (!(await attachOrder(id, id, order.redirectUrl))) throw new Error("could not attach order to booking");
      return send(res, 200, { success: true, id, ref, expiresAt: hold.expiresAt, payUrl: order.redirectUrl });
    } catch (err) {
      console.error("Could not create PhonePe order", err);
      await transitionBooking(id, "released", ["held"], true, Date.now()).catch((e) => console.error(e));
      return send(res, 502, { error: "payment_unavailable" });
    }
  } catch (err) {
    return serverError(res, err);
  }
}
