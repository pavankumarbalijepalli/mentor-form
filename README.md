# bunnybethinking — book a 1:1 session

A one-page booking site: visitors pick a slot, the slot is held for 15 minutes while they pay by UPI, and the booking is saved for you to verify. Static page in `public/`, serverless functions in `api/`, bookings in Upstash Redis. Styled with the **Sage and Stone** design system.

## Deploy on Vercel

1. **Push this repo to GitHub** (it already is) and, in Vercel, **Add New → Project → import it**. Leave the framework as *Other*: `vercel.json` already sets the output directory (`public`) and skips the build step.
2. **Add a Redis database.** In the project: *Storage → Create → Upstash for Redis* (any region; free tier is plenty). Connect it to the project. Vercel adds `KV_REST_API_URL` and `KV_REST_API_TOKEN`, which the API understands. Using your own Upstash database instead? Set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.
3. **Add `ADMIN_TOKEN`** under *Settings → Environment Variables*: a long random string (`openssl rand -hex 32`). It protects `/api/admin`; leave it unset to switch the admin endpoint off.
4. **Deploy**, then open `https://<your-site>/api/health`. `{"ok":true}` means the functions can reach Redis. Then make one real test booking, and cancel it from the admin API (below).
5. *Optional:* point the functions at the region nearest your database (`"regions": ["bom1"]` in `vercel.json` for Mumbai) and add your domain under *Settings → Domains*.

Environment variables are read at deploy time: redeploy after changing them.

## How a booking flows

1. **Details** — visitor picks a day/time (shown in IST) and fills in their details.
2. **Hold** (`POST /api/book`) — the slot is reserved for 15 minutes; nobody else can take it. The visitor gets a reference like `7A2B2C16`, which goes in the UPI payment note.
3. **Paid** (`POST /api/confirm`) — the visitor says they've paid; the booking becomes `pending_review` and the slot is locked. They send you the screenshot on WhatsApp.
4. **You verify** the payment in your UPI app, then mark the booking `confirmed`, or `cancel` it to free the slot.

Going back, or letting the hold run out, releases the slot. States: `held → pending_review → confirmed`, or `released` / `cancelled`.

> Payments are **not** verified automatically — a UPI QR payment can't be checked from the website. Compare each `pending_review` booking with your UPI history before the session.

## Changing your schedule or price

Everything is in [`api/_config.js`](api/_config.js): weekdays, time slots, blocked dates (holidays), booking window, minimum notice, price, UPI ID, WhatsApp number and the "what do you want help with" options. Edit it and redeploy. The page and the API both read it, so they can't disagree. Time slots must look exactly like `"8:00 AM"` / `"9:00 PM"`.

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
# no payment / duplicate / can't make it: frees the slot
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"id":"<booking id>","action":"cancel"}' "$SITE/api/admin"
```

Add `&all=1` to the list call to include abandoned holds. The customer's reference is the first 8 characters of the booking `id`.

## Design

Colours, type, spacing and radii come from the Sage and Stone design system and live in [`public/tokens.css`](public/tokens.css) under the system's own token names. The brand rules the page follows: spacing only in 8/16/24/40px, no shadows, `border` is decoration only (controls get an `ink-muted` edge), JetBrains Mono for code-like text only, and one light theme. The theme has no error colour, so errors are marked with an "Error:" label and an `ink` outline rather than red.

Apple Garamond (the display face) isn't on Google Fonts, so the title falls back to EB Garamond everywhere except Apple devices that have it.

## Development

```bash
npm test          # date rules + API integration tests (the API tests need `redis-server` installed; skipped otherwise)
npx vercel dev    # run site + API locally (needs the Redis variables above, e.g. via `vercel env pull`)
```

## Layout

```
public/            what the browser gets (Vercel's output directory)
  index.html  styles.css  tokens.css  app.js
  js/dates.js      date/slot rules shared by the page and the API
  vendor/          self-hosted QR library
api/               serverless functions
  _config.js       schedule + payment settings
  _lib.js          Redis helper, atomic Lua scripts, validation, rate limiting
  config, slots, book, confirm, release, admin, health
test/              node:test suites
vercel.json        output dir, security headers + strict CSP
```

## Ideas for next steps

- **Verify payments automatically** with Razorpay (Payment Links, or Checkout plus a webhook) so a slot is only confirmed when money has arrived.
- **Email confirmations and reminders** with the meeting link.
- **Block dates from the admin API** instead of editing `blockedDates` and redeploying.
- **A reschedule/cancel link** and a stated refund policy.
- **A privacy line**: you store names, emails and phone numbers; say for how long.
