// POST /api/book — reserve a slot for CONFIG.holdMinutes while the person pays.
// Body: { date, time, name, email, whatsapp, focus, context }
// -> { success, id, ref, expiresAt } | 400 | 409 slot_taken | 429
import { CONFIG } from "./_config.js";
import { isSlotOpen } from "../public/js/dates.js";
import {
  claimSlot, clientIp, isRateLimited, jsonBody, refOf, requireMethod, send, serverError, validateBooking,
} from "./_lib.js";

export default async function handler(req, res) {
  if (!requireMethod(req, res, "POST")) return;

  const body = jsonBody(req);
  if (body.website) return send(res, 400, { error: "invalid_request" }); // honeypot field, humans leave it empty

  const parsed = validateBooking(body);
  if (parsed.error) return send(res, 400, { error: "invalid_field", field: parsed.error });

  const { date, time } = body;
  const now = Date.now();
  if (!isSlotOpen(date, time, now, CONFIG)) return send(res, 400, { error: "invalid_slot" });

  try {
    // Every hold blocks a slot for everyone else, so keep one visitor from grabbing them all.
    if (await isRateLimited("book", clientIp(req), 6, 600)) {
      return send(res, 429, { error: "rate_limited" });
    }

    const id = crypto.randomUUID();
    const hold = await claimSlot({ id, date, time, booking: parsed.value, nowMs: now });
    if (!hold) return send(res, 409, { error: "slot_taken" });

    return send(res, 200, { success: true, id, ref: refOf(id), expiresAt: hold.expiresAt });
  } catch (err) {
    return serverError(res, err);
  }
}
