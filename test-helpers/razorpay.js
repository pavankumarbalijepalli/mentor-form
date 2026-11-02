// A local stand-in for api.razorpay.com so the payment paths can be tested without
// network access or real keys. It implements just the endpoints the API uses.
import { createHmac } from "node:crypto";
import http from "node:http";

export const KEY_ID = "rzp_test_mock";
export const KEY_SECRET = "mock_key_secret";
export const WEBHOOK_SECRET = "mock_webhook_secret";

const hmac = (secret, data) => createHmac("sha256", secret).update(data).digest("hex");

export async function startRazorpayMock() {
  const m = {
    orders: new Map(),
    payments: new Map(),
    calls: [],            // "METHOD /path" of every request received
    failOrders: false,    // make POST /orders return 500
    failRefunds: false,   // make refunds return 500
    n: 0,
  };

  const json = (res, status, body) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
  };
  const err = (res, status, description) => json(res, status, { error: { code: "BAD_REQUEST_ERROR", description } });

  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const auth = "Basic " + Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString("base64");
      if (req.headers.authorization !== auth) return err(res, 401, "Authentication failed");
      m.calls.push(`${req.method} ${req.url}`);
      const body = raw ? JSON.parse(raw) : {};
      let match;

      if (req.method === "POST" && req.url === "/v1/orders") {
        if (m.failOrders) return err(res, 500, "Order service down");
        if (!Number.isInteger(body.amount) || body.amount < 100) return err(res, 400, "Invalid amount");
        const order = { id: `order_${++m.n}`, entity: "order", amount: body.amount, currency: body.currency, receipt: body.receipt, notes: body.notes || {}, status: "created" };
        m.orders.set(order.id, order);
        return json(res, 200, order);
      }
      if ((match = /^\/v1\/orders\/([^/]+)\/payments$/.exec(req.url)) && req.method === "GET") {
        return json(res, 200, { items: [...m.payments.values()].filter((p) => p.order_id === match[1]) });
      }
      if ((match = /^\/v1\/payments\/([^/]+)$/.exec(req.url)) && req.method === "GET") {
        const p = m.payments.get(match[1]);
        return p ? json(res, 200, p) : err(res, 400, "The id provided does not exist");
      }
      if ((match = /^\/v1\/payments\/([^/]+)\/capture$/.exec(req.url)) && req.method === "POST") {
        const p = m.payments.get(match[1]);
        if (!p || p.status !== "authorized") return err(res, 400, "This payment has already been captured");
        if (body.amount !== p.amount) return err(res, 400, "Capture amount must be equal to the amount authorized");
        p.status = "captured";
        return json(res, 200, p);
      }
      if ((match = /^\/v1\/payments\/([^/]+)\/refund$/.exec(req.url)) && req.method === "POST") {
        if (m.failRefunds) return err(res, 500, "Refund service down");
        const p = m.payments.get(match[1]);
        if (!p) return err(res, 400, "The id provided does not exist");
        if (p.status === "refunded") return err(res, 400, "The payment has been fully refunded already");
        if (p.status !== "captured") return err(res, 400, "Only captured payments can be refunded");
        p.status = "refunded";
        p.amount_refunded = p.amount;
        return json(res, 200, { id: `rfnd_${++m.n}`, entity: "refund", payment_id: p.id, amount: p.amount, status: "processed" });
      }
      return err(res, 404, "Not found");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  process.env.RAZORPAY_API_BASE = `http://127.0.0.1:${server.address().port}/v1`;
  process.env.RAZORPAY_KEY_ID = KEY_ID;
  process.env.RAZORPAY_KEY_SECRET = KEY_SECRET;
  process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;

  // What Razorpay does when a customer pays an order: a payment appears and
  // Checkout hands the page { payment id, signature }.
  m.pay = (orderId, { status = "captured", amount } = {}) => {
    const order = m.orders.get(orderId);
    const payment = {
      id: `pay_mock${++m.n}${Math.random().toString(36).slice(2, 8)}`,
      entity: "payment", order_id: orderId, status,
      amount: amount ?? order.amount, currency: order.currency, amount_refunded: 0,
    };
    m.payments.set(payment.id, payment);
    return { paymentId: payment.id, signature: hmac(KEY_SECRET, `${orderId}|${payment.id}`) };
  };

  // A signed webhook delivery as { raw, signature }.
  m.webhook = (event, paymentId, { secret = WEBHOOK_SECRET } = {}) => {
    const payment = m.payments.get(paymentId);
    const raw = JSON.stringify({ entity: "event", event, payload: { payment: { entity: payment } } });
    return { raw, signature: hmac(secret, raw) };
  };

  m.countCalls = (prefix) => m.calls.filter((c) => c.startsWith(prefix)).length;
  m.stop = () => server.close();
  return m;
}
