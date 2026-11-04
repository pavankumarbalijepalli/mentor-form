// GET /api/status?id=<booking id> — where the customer lands after PhonePe, and how
// the page recovers after a reload. If the booking is waiting for payment, ask PhonePe
// whether the order was paid meanwhile.
// -> { status, payment, ref, date, time, free, payUrl? }
//    payment: "completed" | "pending" | "failed" | null (null when not waiting on PhonePe)
//    payUrl is returned only while the booking is still held, so a failed payment can be retried.
import { clientIp, getBooking, isBookingId, isRateLimited, requireMethod, send, serverError } from "./_lib.js";
import { settlePayment } from "./_pay.js";

export default async function handler(req, res) {
  if (!requireMethod(req, res, "GET")) return;

  const id = req.query?.id;
  if (!isBookingId(id)) return send(res, 400, { error: "invalid_request" });

  try {
    // The page polls this for a minute or so while PhonePe finishes, so the limit is generous.
    if (await isRateLimited("status", clientIp(req), 120, 600)) return send(res, 429, { error: "rate_limited" });

    let booking = await getBooking(id);
    if (!booking) return send(res, 404, { error: "not_found" });

    let payment = null;
    if ((booking.status === "held" || booking.status === "released") && booking.orderId) {
      try {
        ({ payment } = await settlePayment(booking, Date.now()));
        booking = await getBooking(id);
      } catch (err) {
        console.error("Status check with PhonePe failed", err); // still report what we know
      }
    }

    return send(res, 200, {
      status: booking.status,
      payment,
      ref: booking.id.slice(0, 8).toUpperCase(),
      date: booking.date,
      time: booking.time,
      free: booking.amountPaise === 0,
      ...(booking.status === "held" && booking.payUrl ? { payUrl: booking.payUrl, holdExpiresAt: booking.holdExpiresAt } : {}),
    });
  } catch (err) {
    return serverError(res, err);
  }
}
