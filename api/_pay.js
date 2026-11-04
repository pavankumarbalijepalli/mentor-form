// Turns "Razorpay says this payment exists" into a confirmed booking.
// Used by the checkout callback (/api/verify), the webhook and the status sync,
// which can all fire for the same payment; every step here is safe to repeat.
import { CONFIG } from "./_config.js";
import { capturePayment, fetchOrderPayments, fetchPayment, refundPayment } from "./_razorpay.js";
import { getBooking, payBooking, transitionBooking } from "./_lib.js";

// Don't trust the browser or the webhook body: ask Razorpay for the payment and
// check it belongs to this order, for the right amount, and is captured.
async function checkPayment(orderId, paymentId, expectedPaise) {
  let p = await fetchPayment(paymentId);
  if (p.order_id !== orderId || p.amount !== expectedPaise || p.currency !== CONFIG.currency) {
    return { ok: false, status: "mismatch" };
  }
  if (p.status === "authorized") {
    // Uncaptured payments are auto-refunded by Razorpay after a few days.
    try {
      await capturePayment(paymentId, p.amount, p.currency);
    } catch (err) {
      p = await fetchPayment(paymentId); // someone else may have captured it first
      if (p.status !== "captured") throw err;
    }
  } else if (p.status !== "captured") {
    return { ok: false, status: "not_paid" };
  }
  return { ok: true };
}

async function refundOwed(id, paymentId, nowMs) {
  try {
    await refundPayment(paymentId, { reason: "Slot no longer available", bookingId: id });
    await transitionBooking(id, "refunded", ["refund_due"], false, nowMs);
    return "refunded";
  } catch (err) {
    console.error(`Refund failed for booking ${id} (${paymentId}); left as refund_due`, err);
    return "refund_due"; // visible in the admin list; `refund` retries it
  }
}

// -> 'confirmed' | 'refunded' | 'refund_due' | 'cancelled' | 'not_paid' | 'mismatch' | 'order_mismatch' | 'not_found'
export async function settlePayment(booking, paymentId, nowMs) {
  // Already dealt with this exact payment (webhook retry, double callback): answer from our own record.
  if (booking.paymentId === paymentId) {
    if (booking.status === "refund_due") return refundOwed(booking.id, paymentId, nowMs);
    if (["confirmed", "refunded", "cancelled"].includes(booking.status)) return booking.status;
  }

  const check = await checkPayment(booking.orderId, paymentId, booking.amountPaise);
  if (!check.ok) return check.status;

  const status = await payBooking(booking.id, booking.orderId, paymentId, nowMs);
  if (status === "refund_due") return refundOwed(booking.id, paymentId, nowMs);
  if (status === "duplicate") {
    // A second payment for an order that's already settled: give it back.
    await refundPayment(paymentId, { reason: "Duplicate payment", bookingId: booking.id }).catch((e) => console.error(e));
    return (await getBooking(booking.id))?.status ?? "not_found";
  }
  return status;
}

// For a booking still waiting on payment: ask Razorpay whether its order got paid
// (covers a closed tab plus a missed webhook). -> a settlePayment status, or null.
export async function syncWithRazorpay(booking, nowMs) {
  if (!booking.orderId) return null;
  const { items = [] } = await fetchOrderPayments(booking.orderId);
  const paid = items.find((p) => p.status === "captured" || p.status === "authorized");
  return paid ? settlePayment(booking, paid.id, nowMs) : null;
}

export { refundOwed };
