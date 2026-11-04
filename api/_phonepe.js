// Minimal PhonePe Payment Gateway (v2 Standard Checkout) client, no SDK needed.
// Everything PhonePe-specific lives in this file, so if PhonePe's API differs from
// what is assumed here, this is the only place to adjust.
//
// Env:
//   PHONEPE_CLIENT_ID, PHONEPE_CLIENT_SECRET   from the PhonePe Business dashboard
//   PHONEPE_CLIENT_VERSION                     defaults to "1"
//   PHONEPE_ENV                                "sandbox" or "production" (must be set explicitly)
//   PHONEPE_WEBHOOK_USERNAME / _PASSWORD       the credentials you set on the webhook in the dashboard
//   SITE_URL                                   public https URL of this site (where PhonePe sends customers back)
// Test hooks: PHONEPE_API_BASE and PHONEPE_AUTH_URL override the PhonePe hosts.
import { createHash, timingSafeEqual } from "node:crypto";

const HOSTS = {
  sandbox: {
    pg: "https://api-preprod.phonepe.com/apis/pg-sandbox",
    auth: "https://api-preprod.phonepe.com/apis/pg-sandbox/v1/oauth/token",
  },
  production: {
    pg: "https://api.phonepe.com/apis/pg",
    auth: "https://api.phonepe.com/apis/identity-manager/v1/oauth/token",
  },
};

const hosts = () =>
  process.env.PHONEPE_API_BASE
    ? { pg: process.env.PHONEPE_API_BASE, auth: process.env.PHONEPE_AUTH_URL }
    : HOSTS[process.env.PHONEPE_ENV];

export const paymentsConfigured = () =>
  Boolean(process.env.PHONEPE_CLIENT_ID && process.env.PHONEPE_CLIENT_SECRET && hosts());
export const webhookConfigured = () =>
  Boolean(process.env.PHONEPE_WEBHOOK_USERNAME && process.env.PHONEPE_WEBHOOK_PASSWORD);

// Where PhonePe sends the customer back to. Set SITE_URL in production; on Vercel
// the deployment's own URL is used as a fallback.
export function siteUrl() {
  const explicit = process.env.SITE_URL;
  const vercel = process.env.VERCEL_ENV === "production"
    ? process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL
    : process.env.VERCEL_URL;
  const raw = explicit || (vercel ? `https://${vercel}` : "http://localhost:3000");
  return raw.replace(/\/+$/, "");
}

export class PhonePeError extends Error {
  constructor(status, body) {
    super(`PhonePe ${status}: ${body?.message || body?.code || "request failed"}`);
    this.status = status;
    this.code = body?.code;
  }
}

// ---------- auth: a short-lived token, cached for the life of the warm function ----------

let cached = null; // { token, type, expiresAtMs }

async function accessToken(force = false) {
  if (!force && cached && cached.expiresAtMs - 60000 > Date.now()) return cached;
  const res = await fetch(hosts().auth, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.PHONEPE_CLIENT_ID,
      client_version: process.env.PHONEPE_CLIENT_VERSION || "1",
      client_secret: process.env.PHONEPE_CLIENT_SECRET,
      grant_type: "client_credentials",
    }),
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new PhonePeError(res.status, data);
  // expires_at is epoch seconds; tolerate milliseconds, and a missing value (assume 15 min)
  const exp = Number(data.expires_at);
  const expiresAtMs = !exp ? Date.now() + 15 * 60000 : exp > 1e12 ? exp : exp * 1000;
  cached = { token: data.access_token, type: data.token_type || "O-Bearer", expiresAtMs };
  return cached;
}

async function pp(method, path, body, retried = false) {
  if (!paymentsConfigured()) {
    throw new Error("PhonePe is not configured: set PHONEPE_CLIENT_ID, PHONEPE_CLIENT_SECRET and PHONEPE_ENV");
  }
  const { token, type } = await accessToken(retried);
  const res = await fetch(hosts().pg + path, {
    method,
    headers: { Authorization: `${type} ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !retried) return pp(method, path, body, true); // token expired early: get a fresh one once
  if (!res.ok) throw new PhonePeError(res.status, data);
  return data;
}

// ---------- payments ----------

// amount is in paise; merchantOrderId is 63 chars max of letters, digits, _ and -.
// -> { orderId, state, expireAt, redirectUrl }: send the customer to redirectUrl.
export async function createPayment({ merchantOrderId, amount, redirectUrl, expireAfter, meta }) {
  const order = await pp("POST", "/checkout/v2/pay", {
    merchantOrderId,
    amount,
    expireAfter, // seconds
    metaInfo: meta,
    paymentFlow: { type: "PG_CHECKOUT", merchantUrls: { redirectUrl } },
  });
  if (!order.redirectUrl || !/^https:\/\//.test(order.redirectUrl)) {
    throw new Error("PhonePe did not return a payment page URL");
  }
  return order;
}

// -> { orderId, state: "PENDING" | "COMPLETED" | "FAILED", amount (paise), expireAt, paymentDetails }
export const fetchOrderStatus = (merchantOrderId) =>
  pp("GET", `/checkout/v2/order/${encodeURIComponent(merchantOrderId)}/status?details=false`);

export const fetchRefundStatus = (merchantRefundId) =>
  pp("GET", `/payments/v2/refund/${encodeURIComponent(merchantRefundId)}/status`);

// Full refund. merchantRefundId is chosen by us and is the same for the same booking,
// so asking twice can't refund twice: if PhonePe rejects the repeat, we look the refund
// up and accept it as long as it hasn't failed.
export async function refundOrder({ merchantRefundId, merchantOrderId, amount }) {
  try {
    return await pp("POST", "/payments/v2/refund", { merchantRefundId, originalMerchantOrderId: merchantOrderId, amount });
  } catch (err) {
    const existing = await fetchRefundStatus(merchantRefundId).catch(() => null);
    if (existing && existing.state && existing.state !== "FAILED") return existing;
    throw err;
  }
}

// ---------- webhook ----------

// PhonePe sends an Authorization header holding the SHA-256 of "username:password".
// Tolerates a "SHA256 " prefix and letter case, since the docs and examples differ on that.
// The body is never trusted for money: the handler asks PhonePe for the order's real state.
export function verifyWebhookAuth(header) {
  if (!webhookConfigured() || typeof header !== "string") return false;
  const expected = createHash("sha256")
    .update(`${process.env.PHONEPE_WEBHOOK_USERNAME}:${process.env.PHONEPE_WEBHOOK_PASSWORD}`)
    .digest("hex");
  const got = header.trim().replace(/^sha-?256[\s:=]+/i, "").toLowerCase();
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
