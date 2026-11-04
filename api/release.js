// POST /api/release — the person went back and abandoned their hold. Body: { id }
// Frees the slot immediately instead of waiting for the hold to expire.
// Only touches bookings still in the `held` state, so it can't undo a payment claim.
import { clientIp, isBookingId, isRateLimited, jsonBody, requireMethod, send, serverError, transitionBooking } from "./_lib.js";

export default async function handler(req, res) {
  if (!requireMethod(req, res, "POST")) return;

  const { id } = jsonBody(req);
  if (!isBookingId(id)) return send(res, 400, { error: "invalid_id" });

  try {
    if (await isRateLimited("release", clientIp(req), 30, 600)) {
      return send(res, 429, { error: "rate_limited" });
    }

    const result = await transitionBooking(id, "released", ["held"], true, Date.now());
    if (result === "not_found") return send(res, 404, { error: "not_found" });
    return send(res, 200, { success: true }); // already confirmed/released is fine
  } catch (err) {
    return serverError(res, err);
  }
}
