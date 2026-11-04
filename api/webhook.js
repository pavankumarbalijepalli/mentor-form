// POST /api/webhook — PhonePe's server-to-server notification (set up in the PhonePe dashboard).
// Settles bookings whose customer paid but never came back to the page.
//
// PhonePe authenticates with an Authorization header (SHA-256 of "username:password").
// That only proves who is calling, so the body is not believed either: we ask PhonePe
// for the order's real state before confirming anything. Which event it is doesn't matter.
import { getBooking, isBookingId, jsonBody, requireMethod, send, serverError } from "./_lib.js";
import { verifyWebhookAuth, webhookConfigured } from "./_phonepe.js";
import { settlePayment } from "./_pay.js";

export default async function handler(req, res) {
  if (!requireMethod(req, res, "POST")) return;

  if (!webhookConfigured()) {
    console.error("Webhook received but PHONEPE_WEBHOOK_USERNAME / PHONEPE_WEBHOOK_PASSWORD are not set");
    return send(res, 503, { error: "webhook_not_configured" });
  }
  if (!verifyWebhookAuth(req.headers?.authorization)) return send(res, 401, { error: "unauthorized" });

  try {
    const payload = jsonBody(req).payload || {};
    const orderId = payload.merchantOrderId || payload.originalMerchantOrderId;
    // Orders we didn't create (the account may serve other things) are not ours to touch.
    const booking = isBookingId(orderId) ? await getBooking(orderId) : null;
    if (!booking || !booking.orderId) return send(res, 200, { ignored: true });

    const result = await settlePayment(booking, Date.now());
    return send(res, 200, { ok: true, ...result });
  } catch (err) {
    return serverError(res, err); // a 5xx makes PhonePe retry the delivery
  }
}
