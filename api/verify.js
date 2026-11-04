// POST /api/verify — Razorpay Checkout's success callback.
// Body: { id, razorpay_payment_id, razorpay_signature }
// The order id comes from our own booking record, never from the browser.
// -> 200 { status: "confirmed", ref, date, time } | 400 bad_signature | 402 not_paid
//    | 409 slot_taken (paid after the hold lapsed and the slot went elsewhere: refunded) | 404
import { clientIp, getBooking, isBookingId, isRateLimited, jsonBody, requireMethod, send, serverError } from "./_lib.js";
import { verifyCheckoutSignature } from "./_razorpay.js";
import { settlePayment } from "./_pay.js";

export default async function handler(req, res) {
  if (!requireMethod(req, res, "POST")) return;

  const { id, razorpay_payment_id: paymentId, razorpay_signature: signature } = jsonBody(req);
  if (!isBookingId(id) || !/^pay_[A-Za-z0-9]{6,40}$/.test(paymentId || "") || typeof signature !== "string" || signature.length > 200) {
    return send(res, 400, { error: "invalid_request" });
  }

  try {
    if (await isRateLimited("verify", clientIp(req), 30, 600)) return send(res, 429, { error: "rate_limited" });

    const booking = await getBooking(id);
    if (!booking) return send(res, 404, { error: "not_found" });
    if (!booking.orderId) return send(res, 409, { error: "no_payment_expected" });
    if (!verifyCheckoutSignature(booking.orderId, paymentId, signature)) {
      return send(res, 400, { error: "bad_signature" });
    }

    const status = await settlePayment(booking, paymentId, Date.now());
    if (status === "confirmed") {
      return send(res, 200, { status, ref: booking.id.slice(0, 8).toUpperCase(), date: booking.date, time: booking.time });
    }
    if (status === "refunded" || status === "refund_due") return send(res, 409, { error: "slot_taken", status });
    if (status === "cancelled") return send(res, 409, { error: "booking_closed" });
    if (status === "not_paid") return send(res, 402, { error: "not_paid" });
    return send(res, 400, { error: "payment_mismatch" });
  } catch (err) {
    return serverError(res, err);
  }
}
