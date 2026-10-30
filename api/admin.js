// Mentor-only booking management. Send `Authorization: Bearer <ADMIN_TOKEN>`.
//   GET  /api/admin[?status=pending_review][&all=1]  -> { bookings }, newest first
//   POST /api/admin  { id, action: "confirm" | "cancel" }
// "confirm" marks a payment as verified; "cancel" frees the slot for others.
// Disabled (404) until the ADMIN_TOKEN environment variable is set.
import { timingSafeEqual } from "node:crypto";
import {
  clientIp, isBookingId, isRateLimited, jsonBody, redis, send, serverError, transitionBooking,
} from "./_lib.js";

function authorized(req) {
  const expected = process.env.ADMIN_TOKEN;
  const m = /^Bearer (.+)$/.exec(req.headers?.authorization || "");
  if (!expected || !m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  if (!process.env.ADMIN_TOKEN) return send(res, 404, { error: "not_found" });

  try {
    if (await isRateLimited("admin", clientIp(req), 60, 600)) {
      return send(res, 429, { error: "rate_limited" });
    }
    if (!authorized(req)) return send(res, 401, { error: "unauthorized" });

    const now = Date.now();

    if (req.method === "GET") {
      const { status, all } = req.query || {};
      let bookings = (await redis(["HVALS", "bookings"])).map((v) => JSON.parse(v));
      // Abandoned holds are noise unless asked for.
      if (!all) bookings = bookings.filter((b) => b.status !== "held" || b.holdExpiresAt > now);
      if (status) bookings = bookings.filter((b) => b.status === status);
      bookings.sort((x, y) => (y.createdAt || "").localeCompare(x.createdAt || ""));
      return send(res, 200, { bookings });
    }

    if (req.method === "POST") {
      const { id, action } = jsonBody(req);
      if (!isBookingId(id)) return send(res, 400, { error: "invalid_id" });

      const result =
        action === "confirm" ? await transitionBooking(id, "confirmed", ["pending_review"], false, now)
        : action === "cancel" ? await transitionBooking(id, "cancelled", ["held", "pending_review", "confirmed"], true, now)
        : null;
      if (result === null) return send(res, 400, { error: "invalid_action" });
      if (result === "not_found") return send(res, 404, { error: "not_found" });
      if (result !== "ok") return send(res, 409, { error: result });
      return send(res, 200, { success: true });
    }

    res.setHeader("Allow", "GET, POST");
    return send(res, 405, { error: "method_not_allowed" });
  } catch (err) {
    return serverError(res, err);
  }
}
