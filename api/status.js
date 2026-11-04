// GET /api/status?id=<booking id> — lets the page recover after a reload.
// If the booking is still waiting for payment, ask Razorpay whether the order
// was paid meanwhile (the customer may have paid and lost the tab).
// -> { status, ref, date, time, free }
import { clientIp, getBooking, isBookingId, isRateLimited, requireMethod, send, serverError } from "./_lib.js";
import { syncWithRazorpay } from "./_pay.js";

export default async function handler(req, res) {
  if (!requireMethod(req, res, "GET")) return;

  const id = req.query?.id;
  if (!isBookingId(id)) return send(res, 400, { error: "invalid_request" });

  try {
    if (await isRateLimited("status", clientIp(req), 60, 600)) return send(res, 429, { error: "rate_limited" });

    let booking = await getBooking(id);
    if (!booking) return send(res, 404, { error: "not_found" });

    if ((booking.status === "held" || booking.status === "released") && booking.orderId) {
      try {
        if (await syncWithRazorpay(booking, Date.now())) booking = await getBooking(id);
      } catch (err) {
        console.error("Status sync with Razorpay failed", err); // still report what we know
      }
    }

    return send(res, 200, {
      status: booking.status,
      ref: booking.id.slice(0, 8).toUpperCase(),
      date: booking.date,
      time: booking.time,
      free: booking.amountPaise === 0,
    });
  } catch (err) {
    return serverError(res, err);
  }
}
