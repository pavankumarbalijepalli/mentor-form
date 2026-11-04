import test from "node:test";
import assert from "node:assert/strict";
import { addDays, dayHasOpenSlot, isDateKey, isDayOpen, isSlotOpen, slotStartMs, timeToMinutes, todayKey } from "../public/js/dates.js";

const cfg = {
  utcOffsetMinutes: 330,
  availableWeekdays: [1, 2, 3, 4, 5, 6],
  timeSlots: ["8:00 AM", "9:00 PM"],
  blockedDates: ["2026-11-03"],
  bookingWindowDays: 30,
  minNoticeHours: 12,
};
// Fri 30 Oct 2026, 10:00 IST
const NOW = Date.parse("2026-10-30T04:30:00Z");

test("isDateKey rejects malformed and impossible dates", () => {
  assert.ok(isDateKey("2026-10-30"));
  for (const bad of ["2026-02-30", "2026-13-01", "26-10-30", "2026-1-30", "", null, undefined, 20261030, ["2026-10-30"]]) {
    assert.equal(isDateKey(bad), false, String(bad));
  }
});

test("timeToMinutes", () => {
  assert.equal(timeToMinutes("8:00 AM"), 480);
  assert.equal(timeToMinutes("9:00 PM"), 1260);
  assert.equal(timeToMinutes("12:00 AM"), 0);
  assert.equal(timeToMinutes("12:30 PM"), 750);
  for (const bad of ["25:00 PM", "8:60 AM", "8 AM", "8:00", "0:30 AM", "8:00 pm"]) assert.equal(timeToMinutes(bad), null, bad);
});

test("slotStartMs converts IST wall-clock to the real instant", () => {
  assert.equal(slotStartMs("2026-10-30", "8:00 AM", 330), Date.parse("2026-10-30T02:30:00Z"));
  assert.equal(slotStartMs("2026-10-30", "9:00 PM", 330), Date.parse("2026-10-30T15:30:00Z"));
});

test("todayKey follows the mentor's timezone, not the host's", () => {
  // 20:00 UTC on the 29th is already 01:30 on the 30th in IST
  assert.equal(todayKey(Date.parse("2026-10-29T20:00:00Z"), 330), "2026-10-30");
  assert.equal(todayKey(Date.parse("2026-10-29T18:29:00Z"), 330), "2026-10-29");
});

test("addDays crosses month and year boundaries", () => {
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
});

test("isDayOpen: weekday, blocked dates, past and booking window", () => {
  assert.equal(isDayOpen("2026-10-30", NOW, cfg), true);   // today, Friday
  assert.equal(isDayOpen("2026-11-01", NOW, cfg), false);  // Sunday
  assert.equal(isDayOpen("2026-11-03", NOW, cfg), false);  // blocked
  assert.equal(isDayOpen("2026-10-29", NOW, cfg), false);  // past
  assert.equal(isDayOpen("2026-11-28", NOW, cfg), true);   // Saturday, inside the 30-day window
  assert.equal(isDayOpen("2026-11-30", NOW, cfg), false);  // Monday, one day past the window
});

test("isSlotOpen enforces minimum notice and known times", () => {
  // now = 10:00 IST Fri. 9 PM today is 11h away (< 12h notice) -> closed.
  assert.equal(isSlotOpen("2026-10-30", "9:00 PM", NOW, cfg), false);
  assert.equal(isSlotOpen("2026-10-31", "8:00 AM", NOW, cfg), true);
  assert.equal(isSlotOpen("2026-10-31", "7:00 PM", NOW, cfg), false); // not an offered time
  assert.equal(isSlotOpen("2026-11-01", "8:00 AM", NOW, cfg), false); // Sunday
});

test("dayHasOpenSlot: a day whose times are all inside the notice window is not offered", () => {
  // 10:00 IST Friday: today's 8 AM has passed and 9 PM is only 11h away
  assert.equal(isDayOpen("2026-10-30", NOW, cfg), true);
  assert.equal(dayHasOpenSlot("2026-10-30", NOW, cfg), false);
  assert.equal(dayHasOpenSlot("2026-10-31", NOW, cfg), true);
  assert.equal(dayHasOpenSlot("2026-11-01", NOW, cfg), false); // Sunday
});
