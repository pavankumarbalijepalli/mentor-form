// A local stand-in for PhonePe's PG API, built from the documented behaviour:
// form-encoded OAuth token request, "O-Bearer" auth, create payment -> hosted
// payment page URL, order status (PENDING/COMPLETED/FAILED), refunds by merchantRefundId.
// It tests OUR logic; it can't prove PhonePe really behaves this way (see the README checklist).
import { createHash } from "node:crypto";
import http from "node:http";

export const CLIENT_ID = "test_client";
export const CLIENT_SECRET = "test_secret";
export const WEBHOOK_USER = "hook_user";
export const WEBHOOK_PASS = "hook_pass";

export async function startPhonePeMock() {
  const m = {
    orders: new Map(),    // merchantOrderId -> order
    refunds: new Map(),   // merchantRefundId -> refund
    calls: [],            // "METHOD /path" of every request that reached the API
    tokensIssued: 0,
    failAuth: false, failPay: false, failRefunds: false,
    n: 0,
  };
  const validTokens = new Set();

  const json = (res, status, body) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
  };
  const err = (res, status, code, message) => json(res, status, { success: false, code, message });

  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = new URL(req.url, "http://x");
      const path = url.pathname;

      if (req.method === "POST" && path === "/auth/token") {
        m.calls.push("POST /auth/token");
        if (m.failAuth) return err(res, 401, "AUTH_FAILED", "bad credentials");
        const form = new URLSearchParams(raw);
        const ok = req.headers["content-type"]?.startsWith("application/x-www-form-urlencoded") &&
          form.get("client_id") === CLIENT_ID && form.get("client_secret") === CLIENT_SECRET &&
          form.get("client_version") === "1" && form.get("grant_type") === "client_credentials";
        if (!ok) return err(res, 401, "AUTH_FAILED", "invalid client credentials");
        const token = `tok_${++m.tokensIssued}`;
        validTokens.add(token);
        const now = Math.floor(Date.now() / 1000);
        return json(res, 200, { access_token: token, token_type: "O-Bearer", issued_at: now, expires_at: now + 3600 });
      }

      const bearer = /^O-Bearer (.+)$/.exec(req.headers.authorization || "");
      if (!bearer || !validTokens.has(bearer[1])) return err(res, 401, "UNAUTHORIZED", "invalid token");
      m.calls.push(`${req.method} ${path}`);
      const body = raw ? JSON.parse(raw) : {};
      let match;

      if (req.method === "POST" && path === "/pg/checkout/v2/pay") {
        if (m.failPay) return err(res, 500, "INTERNAL_SERVER_ERROR", "down");
        const bad =
          !/^[A-Za-z0-9_-]{1,63}$/.test(body.merchantOrderId || "") ? "merchantOrderId" :
          !Number.isInteger(body.amount) || body.amount < 100 ? "amount" :
          !(body.expireAfter >= 300 && body.expireAfter <= 5184000) ? "expireAfter" :
          body.paymentFlow?.type !== "PG_CHECKOUT" ? "paymentFlow.type" :
          !/^https?:\/\//.test(body.paymentFlow?.merchantUrls?.redirectUrl || "") ? "redirectUrl" : null;
        if (bad) return err(res, 400, "BAD_REQUEST", `invalid ${bad}`);
        if (m.orders.has(body.merchantOrderId)) return err(res, 400, "DUPLICATE", "merchantOrderId already used");
        const order = {
          orderId: `OMO${++m.n}`, merchantOrderId: body.merchantOrderId, amount: body.amount, state: "PENDING",
          expireAt: Date.now() + body.expireAfter * 1000, redirectUrl: `https://pay.phonepe.test/${body.merchantOrderId}`,
          returnUrl: body.paymentFlow.merchantUrls.redirectUrl, expireAfter: body.expireAfter, meta: body.metaInfo, paymentDetails: [],
        };
        m.orders.set(order.merchantOrderId, order);
        return json(res, 200, { orderId: order.orderId, state: "PENDING", expireAt: order.expireAt, redirectUrl: order.redirectUrl });
      }

      if ((match = /^\/pg\/checkout\/v2\/order\/([^/]+)\/status$/.exec(path)) && req.method === "GET") {
        const o = m.orders.get(decodeURIComponent(match[1]));
        if (!o) return err(res, 404, "ORDER_NOT_FOUND", "no such order");
        return json(res, 200, { orderId: o.orderId, state: o.state, amount: o.amount, expireAt: o.expireAt, paymentDetails: o.paymentDetails });
      }

      if (req.method === "POST" && path === "/pg/payments/v2/refund") {
        if (m.failRefunds) return err(res, 500, "INTERNAL_SERVER_ERROR", "refunds down");
        const o = m.orders.get(body.originalMerchantOrderId);
        if (!o) return err(res, 404, "ORDER_NOT_FOUND", "no such order");
        if (o.state !== "COMPLETED") return err(res, 400, "BAD_REQUEST", "order not paid");
        if (m.refunds.has(body.merchantRefundId)) return err(res, 400, "DUPLICATE", "merchantRefundId already used");
        if (body.amount !== o.amount) return err(res, 400, "BAD_REQUEST", "only full refunds in this mock");
        const refund = { refundId: `OMR${++m.n}`, merchantRefundId: body.merchantRefundId, amount: body.amount, state: "PENDING" };
        m.refunds.set(body.merchantRefundId, refund);
        return json(res, 200, { refundId: refund.refundId, amount: refund.amount, state: "PENDING" });
      }
      if ((match = /^\/pg\/payments\/v2\/refund\/([^/]+)\/status$/.exec(path)) && req.method === "GET") {
        const r = m.refunds.get(decodeURIComponent(match[1]));
        return r ? json(res, 200, { merchantRefundId: r.merchantRefundId, state: r.state, amount: r.amount }) : err(res, 404, "NOT_FOUND", "no such refund");
      }
      return err(res, 404, "NOT_FOUND", "unknown endpoint");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  process.env.PHONEPE_API_BASE = `${base}/pg`;
  process.env.PHONEPE_AUTH_URL = `${base}/auth/token`;
  process.env.PHONEPE_CLIENT_ID = CLIENT_ID;
  process.env.PHONEPE_CLIENT_SECRET = CLIENT_SECRET;
  process.env.PHONEPE_WEBHOOK_USERNAME = WEBHOOK_USER;
  process.env.PHONEPE_WEBHOOK_PASSWORD = WEBHOOK_PASS;
  process.env.SITE_URL = "https://mentor.test";

  // The customer pays (or not) on PhonePe's page.
  m.complete = (merchantOrderId, { amount } = {}) => {
    const o = m.orders.get(merchantOrderId);
    o.state = "COMPLETED";
    if (amount != null) o.amount = amount;
    o.paymentDetails = [{ transactionId: `TX${++m.n}`, paymentMode: "UPI_INTENT", state: "COMPLETED" }];
  };
  m.fail = (merchantOrderId) => {
    const o = m.orders.get(merchantOrderId);
    o.state = "FAILED";
    o.paymentDetails = [{ transactionId: `TX${++m.n}`, paymentMode: "UPI_INTENT", state: "FAILED" }];
  };
  m.expireTokens = () => validTokens.clear();

  // A webhook delivery: { body, authorization }. `claim` is what the body says (not necessarily true).
  m.webhook = (merchantOrderId, { event = "checkout.order.completed", state = "COMPLETED", user = WEBHOOK_USER, pass = WEBHOOK_PASS, prefix = "" } = {}) => ({
    body: { event, payload: { merchantOrderId, state } },
    authorization: prefix + createHash("sha256").update(`${user}:${pass}`).digest("hex"),
  });

  m.countCalls = (prefix) => m.calls.filter((c) => c.startsWith(prefix)).length;
  m.stop = () => server.close();
  return m;
}
