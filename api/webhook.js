// POST /api/webhook — Razorpay webhook (payment.captured, payment.authorized, order.paid).
// Settles bookings whose customer paid but never came back to the page.
// The signature is an HMAC of the RAW body, so the body must not be parsed first.
// Set the same secret as RAZORPAY_WEBHOOK_SECRET in Vercel and in the Razorpay dashboard.
import { bookingIdForOrder, getBooking, requireMethod, send, serverError } from "./_lib.js";
import { verifyWebhookSignature, webhookConfigured } from "./_razorpay.js";
import { settlePayment } from "./_pay.js";

export const config = { api: { bodyParser: false } };

const EVENTS = new Set(["payment.captured", "payment.authorized", "order.paid"]);

async function readRaw(req) {
  // Read the stream before touching req.body: on Vercel, req.body parses lazily.
  if (req.readable && typeof req[Symbol.asyncIterator] === "function") {
    const chunks = [];
    for await (const c of req) chunks.push(Buffer.from(c));
    return Buffer.concat(chunks).toString("utf8");
  }
  if (typeof req.body === "string") return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString("utf8");
  return null;
}

export default async function handler(req, res) {
  if (!requireMethod(req, res, "POST")) return;

  if (!webhookConfigured()) {
    console.error("Webhook received but RAZORPAY_WEBHOOK_SECRET is not set");
    return send(res, 503, { error: "webhook_not_configured" });
  }

  try {
    const raw = await readRaw(req);
    if (raw == null) {
      console.error("Webhook: raw body unavailable, cannot verify signature");
      return send(res, 400, { error: "no_raw_body" });
    }
    if (!verifyWebhookSignature(raw, req.headers["x-razorpay-signature"])) {
      return send(res, 400, { error: "bad_signature" });
    }

    let event;
    try { event = JSON.parse(raw); } catch { return send(res, 400, { error: "invalid_json" }); }
    const payment = event?.payload?.payment?.entity;
    if (!EVENTS.has(event?.event) || !payment?.id || !payment?.order_id) return send(res, 200, { ignored: true });

    // Orders we didn't create (the Razorpay account may serve other things) are not ours to touch.
    const bookingId = await bookingIdForOrder(payment.order_id);
    const booking = bookingId && (await getBooking(bookingId));
    if (!booking) return send(res, 200, { ignored: true });

    const status = await settlePayment(booking, payment.id, Date.now());
    return send(res, 200, { ok: true, status });
  } catch (err) {
    return serverError(res, err); // a 5xx makes Razorpay retry the delivery
  }
}
