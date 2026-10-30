# Mentor session booking

A one-page booking site for 1:1 mentoring sessions. Visitors pick a slot, the slot is held for 15 minutes while they pay by UPI, and the booking is saved for you to verify. Static page + Vercel serverless functions + Upstash Redis.

## How a booking flows

1. **Intake** — visitor picks a day/time (shown in IST) and fills in their details.
2. **Hold** (`POST /api/book`) — the slot is reserved for `holdMinutes` (15). Nobody else can take it; the visitor gets a reference like `7A2B2C16`, which goes in the UPI payment note.
3. **Paid** (`POST /api/confirm`) — the visitor says they've paid; the booking becomes `pending_review` and the slot is locked. They then send you the screenshot on WhatsApp.
4. **You verify** the payment in your UPI app and mark the booking `confirmed` — or `cancel` it, which frees the slot.

If the visitor goes back or the hold runs out, the slot is released automatically. Booking states: `held → pending_review → confirmed`, or `released` / `cancelled`.

> Payments are **not** verified automatically — UPI QR payments can't be checked from the website. Check each `pending_review` booking against your bank/UPI history before the session. See "Ideas" for automatic verification.

## Setup

1. Create an [Upstash Redis](https://upstash.com) database (or add the Upstash integration in Vercel).
2. In Vercel → Project → Settings → Environment Variables, set:

   | Variable | Value |
   | --- | --- |
   | `UPSTASH_REDIS_REST_URL` | from the Upstash console |
   | `UPSTASH_REDIS_REST_TOKEN` | from the Upstash console |
   | `ADMIN_TOKEN` | a long random string: `openssl rand -hex 32` |

3. Deploy. Use a Node 22 runtime (set by `package.json`).

## Changing your schedule or price

Everything lives in [`api/_config.js`](api/_config.js): weekdays, time slots, blocked dates (holidays), booking window, minimum notice, price, UPI ID, WhatsApp number, and the "what do you want help with" options. Edit it and redeploy — the page and the API both read from it, so they can't disagree.

Time slots must be written exactly like `"8:00 AM"` / `"9:00 PM"`.

## Managing bookings

Replace `$TOKEN` with your `ADMIN_TOKEN` and `$SITE` with your site URL.

```bash
# bookings waiting for you to verify payment
curl -H "Authorization: Bearer $TOKEN" "$SITE/api/admin?status=pending_review"
```

```bash
# payment verified
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"id":"<booking id>","action":"confirm"}' "$SITE/api/admin"
```

```bash
# no payment / duplicate / can't make it — frees the slot
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"id":"<booking id>","action":"cancel"}' "$SITE/api/admin"
```

Add `&all=1` to the list call to include abandoned holds. The booking `id` is in the list output; the customer-facing reference is its first 8 characters.

## Development

```bash
npm test          # unit tests + API integration tests (needs `redis-server` installed; skipped otherwise)
npx vercel dev    # run the site and API locally (needs the env vars above)
```

## Layout

```
index.html, styles.css, app.js   the page (no inline scripts/styles — see the CSP in vercel.json)
shared/dates.js                  date/slot rules used by both the page and the API
vendor/qrcode.min.js             self-hosted QR library
api/_config.js                   schedule + payment settings
api/_lib.js                      Redis helper, atomic Lua scripts, validation, rate limiting
api/{config,slots,book,confirm,release,admin}.js
test/                            node:test suites
```

## Ideas for next steps

- **Verify payments automatically** with Razorpay (Payment Links or Checkout + webhook) so a slot is only confirmed when money has actually arrived.
- **Email confirmations/reminders** (Resend or similar) with a calendar invite and meeting link.
- **Block dates from the admin API** instead of editing `blockedDates` and redeploying.
- **Self-serve reschedule/cancel** link in the confirmation, plus a stated refund policy.
- **Privacy notice** — you store names, emails and phone numbers; say so and for how long.
