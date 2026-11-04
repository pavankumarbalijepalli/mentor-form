// GET /api/health — 200 once the deployment can reach Redis. Handy right after deploying.
// `payments` and `webhook` say whether the Razorpay variables are set (never their values).
import { redis, requireMethod, send } from "./_lib.js";
import { paymentsConfigured, webhookConfigured } from "./_razorpay.js";

export default async function handler(req, res) {
  if (!requireMethod(req, res, "GET")) return;
  const flags = { payments: paymentsConfigured(), webhook: webhookConfigured() };
  try {
    await redis(["PING"]);
    return send(res, 200, { ok: true, ...flags });
  } catch (err) {
    console.error(err);
    return send(res, 503, { ok: false, ...flags });
  }
}
