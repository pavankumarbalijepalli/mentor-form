// Minimal Razorpay REST client (no SDK needed) plus signature checks.
// Env: RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET
// RAZORPAY_API_BASE overrides the API host (used by the tests' mock server).
import { createHmac, timingSafeEqual } from "node:crypto";

const base = () => process.env.RAZORPAY_API_BASE || "https://api.razorpay.com/v1";
export const keyId = () => process.env.RAZORPAY_KEY_ID || "";
const keySecret = () => process.env.RAZORPAY_KEY_SECRET || "";

export const paymentsConfigured = () => Boolean(keyId() && keySecret());
export const webhookConfigured = () => Boolean(process.env.RAZORPAY_WEBHOOK_SECRET);

export class RazorpayError extends Error {
  constructor(status, body) {
    super(`Razorpay ${status}: ${body?.error?.description || "request failed"}`);
    this.status = status;
    this.code = body?.error?.code;
  }
}

async function rzp(method, path, body) {
  if (!paymentsConfigured()) throw new Error("Razorpay is not configured: set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET");
  const res = await fetch(base() + path, {
    method,
    headers: {
      Authorization: "Basic " + Buffer.from(`${keyId()}:${keySecret()}`).toString("base64"),
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new RazorpayError(res.status, data);
  return data;
}

// amount is in paise; receipt is max 40 chars; notes max 15 pairs of <=256 chars
export const createOrder = ({ amount, currency, receipt, notes }) =>
  rzp("POST", "/orders", { amount, currency, receipt, notes });
export const fetchOrderPayments = (orderId) => rzp("GET", `/orders/${encodeURIComponent(orderId)}/payments`);
export const fetchPayment = (paymentId) => rzp("GET", `/payments/${encodeURIComponent(paymentId)}`);
export const capturePayment = (paymentId, amount, currency) =>
  rzp("POST", `/payments/${encodeURIComponent(paymentId)}/capture`, { amount, currency });

// Full refund. Treats "already refunded" as success so retries are safe.
export async function refundPayment(paymentId, notes) {
  try {
    return await rzp("POST", `/payments/${encodeURIComponent(paymentId)}/refund`, { speed: "normal", notes });
  } catch (err) {
    const p = await fetchPayment(paymentId).catch(() => null);
    if (p && (p.status === "refunded" || (p.amount_refunded >= p.amount && p.amount > 0))) return p;
    throw err;
  }
}

const hmacHex = (secret, data) => createHmac("sha256", secret).update(data).digest("hex");

function safeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// Checkout's success callback: HMAC_SHA256(order_id + "|" + payment_id, key_secret).
// `orderId` must come from our own records, never from the browser.
export const verifyCheckoutSignature = (orderId, paymentId, signature) =>
  Boolean(keySecret()) && safeEqualHex(hmacHex(keySecret(), `${orderId}|${paymentId}`), signature);

// Webhooks: HMAC_SHA256(raw request body, webhook secret) in X-Razorpay-Signature.
export const verifyWebhookSignature = (rawBody, signature) =>
  webhookConfigured() && safeEqualHex(hmacHex(process.env.RAZORPAY_WEBHOOK_SECRET, rawBody), signature);
