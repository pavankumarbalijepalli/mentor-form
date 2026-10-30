// GET /api/slots?date=YYYY-MM-DD
// -> { date, slots: [{ time, status }] }, status = open | booked | held | closed
import { CONFIG } from "./_config.js";
import { isDateKey, isDayOpen, isSlotOpen } from "../shared/dates.js";
import { redis, requireMethod, send, serverError, slotField, slotState } from "./_lib.js";

export default async function handler(req, res) {
  if (!requireMethod(req, res, "GET")) return;

  const date = req.query?.date;
  if (!isDateKey(date)) return send(res, 400, { error: "invalid_date" });

  const now = Date.now();
  if (!isDayOpen(date, now, CONFIG)) return send(res, 200, { date, slots: [] });

  try {
    const values = await redis(["HMGET", "slots", ...CONFIG.timeSlots.map((t) => slotField(date, t))]);
    const slots = CONFIG.timeSlots.map((time, i) => {
      const state = slotState(values[i], now);
      if (state !== "free") return { time, status: state };
      return { time, status: isSlotOpen(date, time, now, CONFIG) ? "open" : "closed" };
    });
    return send(res, 200, { date, slots });
  } catch (err) {
    return serverError(res, err);
  }
}
