// Single source of truth for the schedule and payment details. The API enforces
// these rules; the browser fetches the public ones from GET /api/config.
// Edit here and redeploy — nothing in this file is secret.

export const CONFIG = {
  // Slot times and dates are in this timezone. Fixed offset (IST has no DST).
  timezone: "Asia/Kolkata",
  utcOffsetMinutes: 330,

  sessionMinutes: 60,
  amount: 1500,
  upiId: "bunnyistaken@ybl",
  payeeName: "Balijepalli V N S S Pavan",
  // WhatsApp number with country code, digits only
  whatsappNumber: "917673977636",

  // 0=Sun ... 6=Sat
  availableWeekdays: [1, 2, 3, 4, 5, 6],

  // Offered on every available day, written exactly "H:MM AM|PM" (used as a DB key)
  timeSlots: ["8:00 AM", "9:00 PM"],

  // Dates to close even though the weekday is normally open: "YYYY-MM-DD"
  blockedDates: [],

  // How many days ahead people can book
  bookingWindowDays: 30,

  // A slot stops being bookable this long before it starts
  minNoticeHours: 12,

  // How long a slot is reserved while the person is paying
  holdMinutes: 15,

  focusOptions: [
    "Career transition into AI/ML",
    "Interview prep",
    "Personalized learning path",
    "Something else",
  ],
};

// What the browser is allowed to know.
export const publicConfig = () => ({
  timezone: CONFIG.timezone,
  utcOffsetMinutes: CONFIG.utcOffsetMinutes,
  sessionMinutes: CONFIG.sessionMinutes,
  amount: CONFIG.amount,
  upiId: CONFIG.upiId,
  payeeName: CONFIG.payeeName,
  whatsappNumber: CONFIG.whatsappNumber,
  availableWeekdays: CONFIG.availableWeekdays,
  timeSlots: CONFIG.timeSlots,
  blockedDates: CONFIG.blockedDates,
  bookingWindowDays: CONFIG.bookingWindowDays,
  minNoticeHours: CONFIG.minNoticeHours,
  holdMinutes: CONFIG.holdMinutes,
  focusOptions: CONFIG.focusOptions,
});
