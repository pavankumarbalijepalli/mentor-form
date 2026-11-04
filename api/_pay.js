// Turns "PhonePe says this order is paid" into a confirmed booking.
// Used by the webhook and the status check, which can both fire for the same
// payment; every step here is safe to repeat.
//
// Nothing the browser or a webhook body claims is believed: we always ask PhonePe
// for the order's own state, and require it to be COMPLETED for the amount we asked for.
import { fetchOrderStatus, refundOrder } from "./_phonepe.js";
import { getBooking, payBooking, transitionBooking } from "./_lib.js";

// PhonePe order states -> what the page cares about
export async function checkOrder(booking) {
  const order = await fetchOrderStatus(booking.orderId);
  if (order.state === "COMPLETED") {
    if (order.amount !== booking.amountPaise) {
      console.error(`Order ${booking.orderId} completed for ${order.amount} paise, expected ${booking.amountPaise}`);
      return { payment: "mismatch" };
    }
    return { payment: "completed", paymentId: order.orderId };
  }
  return { payment: order.state === "FAILED" ? "failed" : "pending" };
}

// One refund id per booking, so repeating a refund can never pay out twice.
export const refundBooking = (booking) =>
  refundOrder({ merchantRefundId: `rf-${booking.id}`, merchantOrderId: booking.orderId, amount: booking.amountPaise });

async function refundOwed(booking, nowMs) {
  try {
    await refundBooking(booking);
    await transitionBooking(booking.id, "refunded", ["refund_due"], false, nowMs);
    return "refunded";
  } catch (err) {
    console.error(`Refund failed for booking ${booking.id}; left as refund_due`, err);
    return "refund_due"; // visible in the admin list; the `refund` action retries it
  }
}

// -> { status: booking status after settling, payment: "completed" | "pending" | "failed" | "mismatch" }
export async function settlePayment(booking, nowMs) {
  // Already dealt with: answer from our own record without bothering PhonePe.
  if (booking.paymentId) {
    if (booking.status === "refund_due") return { status: await refundOwed(booking, nowMs), payment: "completed" };
    if (["confirmed", "refunded", "cancelled"].includes(booking.status)) return { status: booking.status, payment: "completed" };
  }

  const check = await checkOrder(booking);
  if (check.payment !== "completed") return { status: booking.status, payment: check.payment };

  let status = await payBooking(booking.id, booking.orderId, check.paymentId, nowMs);
  if (status === "refund_due") {
    status = await refundOwed({ ...booking, paymentId: check.paymentId }, nowMs);
  } else if (status === "duplicate" || status === "order_mismatch" || status === "not_found") {
    status = (await getBooking(booking.id))?.status ?? "not_found";
  }
  return { status, payment: "completed" };
}
