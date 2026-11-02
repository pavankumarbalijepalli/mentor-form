// GET /api/health — 200 once the deployment can reach Redis. Handy right after deploying.
import { redis, requireMethod, send } from "./_lib.js";

export default async function handler(req, res) {
  if (!requireMethod(req, res, "GET")) return;
  try {
    await redis(["PING"]);
    return send(res, 200, { ok: true });
  } catch (err) {
    console.error(err);
    return send(res, 503, { ok: false });
  }
}
