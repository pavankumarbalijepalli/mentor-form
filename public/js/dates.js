// Date/slot rules shared by the browser (calendar greying) and the API (the
// authority). Dates are plain "YYYY-MM-DD" strings in the mentor's timezone and
// are never run through the host's local timezone, so a visitor in London or
// New York sees the same calendar as one in Hyderabad.

export function isDateKey(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export const weekdayOf = (key) => new Date(`${key}T00:00:00Z`).getUTCDay();

export function addDays(key, n) {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Today's date key in the mentor's timezone (fixed UTC offset; IST has no DST).
export const todayKey = (nowMs, offsetMin) =>
  new Date(nowMs + offsetMin * 60000).toISOString().slice(0, 10);

// "8:00 AM" / "12:30 PM" -> minutes after midnight, or null if malformed.
export function timeToMinutes(t) {
  const m = /^(\d{1,2}):(\d{2}) (AM|PM)$/.exec(t);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 1 || h > 12 || min > 59) return null;
  return (h % 12) * 60 + (m[3] === "PM" ? 720 : 0) + min;
}

// The real instant (epoch ms) at which a slot starts.
export function slotStartMs(key, time, offsetMin) {
  return Date.parse(`${key}T00:00:00Z`) + timeToMinutes(time) * 60000 - offsetMin * 60000;
}

export function isDayOpen(key, nowMs, cfg) {
  if (!isDateKey(key)) return false;
  const today = todayKey(nowMs, cfg.utcOffsetMinutes);
  return (
    key >= today &&
    key <= addDays(today, cfg.bookingWindowDays) &&
    cfg.availableWeekdays.includes(weekdayOf(key)) &&
    !cfg.blockedDates.includes(key)
  );
}

// Day is open, time is one we offer, and it's far enough in the future.
export function isSlotOpen(key, time, nowMs, cfg) {
  return (
    isDayOpen(key, nowMs, cfg) &&
    cfg.timeSlots.includes(time) &&
    slotStartMs(key, time, cfg.utcOffsetMinutes) >= nowMs + cfg.minNoticeHours * 3600000
  );
}

// Whether anything on this day can still be booked (what the calendar greys by).
export const dayHasOpenSlot = (key, nowMs, cfg) =>
  cfg.timeSlots.some((t) => isSlotOpen(key, t, nowMs, cfg));
