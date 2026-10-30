// POST /api/confirm — the person says they've paid. Body: { id }
// Turns the hold into a booking waiting for the mentor to verify the payment.
// -> { success } | 404 | 409 slot_taken | 410 booking_closed
import { clientIp, confirmBooking, isBookingId, isRateLimited, jsonBody, requireMethod, send, serverError } from "./_lib.js";

export default async function handler(req, res) {
  if (!requireMethod(req, res, "POST")) return;

  const { id } = jsonBody(req);
  if (!isBookingId(id)) return send(res, 400, { error: "invalid_id" });

  try {
    if (await isRateLimited("confirm", clientIp(req), 30, 600)) {
      return send(res, 429, { error: "rate_limited" });
    }

    const result = await confirmBooking(id, Date.now());
    if (result === "ok") return send(res, 200, { success: true });
    if (result === "taken") return send(res, 409, { error: "slot_taken" });
    if (result === "gone") return send(res, 410, { error: "booking_closed" });
    return send(res, 404, { error: "not_found" });
  } catch (err) {
    return serverError(res, err);
  }
}
