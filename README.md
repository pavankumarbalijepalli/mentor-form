# bunnybethinking — book a 1:1 session

A one-page booking site: visitors pick a slot, the slot is held for 15 minutes while they pay through Razorpay, and the booking is confirmed automatically once the payment is verified. Static page in `public/`, serverless functions in `api/`, bookings in Upstash Redis. Styled with the **Sage and Stone** design system.

## Deploy on Vercel

1. **Push this repo to GitHub** (it already is) and, in Vercel, **Add New → Project → import it**. Leave the framework as *Other*: `vercel.json` already sets the output directory (`public`) and skips the build step.
2. **Add a Redis database.** In the project: *Storage → Create → Upstash for Redis* (any region; the free tier is plenty) and connect it. Vercel adds `KV_REST_API_URL` and `KV_REST_API_TOKEN`, which the API understands. Using your own Upstash database instead? Set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.
3. **Set up Razorpay** (next section) and add its three variables.
4. **Add `ADMIN_TOKEN`**: a long random string (`openssl rand -hex 32`). It protects `/api/admin`; leave it unset to switch the admin endpoint off.
5. **Deploy**, then open `https://<your-site>/api/health`. You want `{"ok":true,"payments":true,"webhook":true}`: Redis is reachable and the Razorpay variables are present.
6. Make one real **test-mode booking** (below), then switch to live keys.
7. *Optional:* put the functions in the region nearest your database (`"regions": ["bom1"]` in `vercel.json` for Mumbai) and add your domain under *Settings → Domains*.

Environment variables are read at deploy time: redeploy after changing them.

## Razorpay setup

1. Create a Razorpay account. **Test mode** works immediately with no KYC; live payments need KYC to be approved.
2. *Account & Settings → API keys → Generate key* (in test mode first). Set `RAZORPAY_KEY_ID` (`rzp_test_...`) and `RAZORPAY_KEY_SECRET` in Vercel.
3. *Account & Settings → Webhooks → Add new webhook*:
   - **URL:** `https://<your-site>/api/webhook`
   - **Secret:** any long random string. Put the same value in Vercel as `RAZORPAY_WEBHOOK_SECRET`.
   - **Events:** `payment.captured` and `order.paid` (add `payment.authorized` too if your capture setting is *manual*).
   
   The webhook is the safety net for customers who pay and then close the tab. Without it, those bookings are only recovered if the customer comes back to the page.
4. Check *Settings → Payment capture* is **automatic**. (If it's manual the server captures payments itself, but automatic is simpler.)
5. **Test it end to end** with test keys: book a slot and pay with one of the test UPI IDs or cards in Razorpay's test-payments docs (for example `success@razorpay`). Then open `/api/admin?status=confirmed` to see the booking, and in the Razorpay dashboard check the webhook's delivery log shows `200`.
6. **Going live:** generate *live* keys and a *live* webhook (test and live are separate in Razorpay), swap all three variables in Vercel, redeploy.

How a payment is made safe: the server creates the order for the price in `api/_config.js` (the browser never sends an amount), checks Razorpay's signature on the way back using the order it stored, and then asks Razorpay itself for the payment before confirming anything.

## How a booking flows

1. **Details**: the visitor picks a day/time (shown in IST) and fills in their details. A valid promo code books the session for free right here and skips payment.
2. **Hold** (`POST /api/book`): the slot is reserved for 15 minutes and a Razorpay order is created.
3. **Pay**: Razorpay Checkout opens (UPI, cards, netbanking). On success the page calls `POST /api/verify`, and the booking becomes `confirmed`.
4. **If the page never hears about the payment** (closed tab, lost connection), two things still confirm it: Razorpay's webhook, and a status check when the customer returns.
5. **If they pay after the 15 minutes and someone else took the slot**, they're refunded automatically. If that refund call fails, the booking shows as `refund_due` in the admin list and you can retry it.

Going back or letting the hold run out releases the slot. States: `held → confirmed`, `released`, `cancelled`, and `refund_due → refunded`.

> You are not notified of new bookings yet. Razorpay can email you for each payment (*Settings → Notifications*), and promo bookings only show up in the admin list. See "Ideas".

## Changing your schedule or price

Everything is in [`api/_config.js`](api/_config.js): weekdays, time slots, blocked dates (holidays), booking window, minimum notice, price (`amount`, in rupees), your WhatsApp number and the "what do you want help with" options. Edit it and redeploy. The page and the API both read it, so they can't disagree. Time slots must look exactly like `"7:00 PM"` / `"7:30 PM"`. Closed a day (holiday, travel)? Add it to `blockedDates` as `"YYYY-MM-DD"`.

## Promo codes (free sessions)

A valid code makes the session ₹0 and confirms it immediately. Codes are stored in Redis, not in the code, so create them after deploying and share them whenever you like. Each code can have a use limit and an expiry date, and **each email address can use a code once**.

Replace `$TOKEN` with your `ADMIN_TOKEN` and `$SITE` with your site URL.

```bash
# create a code: 25 uses, valid through 31 Dec 2026 (maxUses and expires are optional)
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"action":"promo_create","code":"FRESHER2026","maxUses":25,"expires":"2026-12-31"}' "$SITE/api/admin"
```

```bash
# see every code and how many times it's been used
curl -H "Authorization: Bearer $TOKEN" "$SITE/api/admin?view=promos"
```

```bash
# turn a code off (e.g. it leaked)
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"action":"promo_disable","code":"FRESHER2026"}' "$SITE/api/admin"
```

Codes are case-insensitive (3-32 letters, numbers, `-` or `_`). People can't tell *why* a code was refused (wrong, expired, used up, or already used by their email), and guessing is rate-limited. Cancelling a free booking frees the slot but doesn't give the code its use back.

## Managing bookings

```bash
# paid bookings (also try status=refund_due, or add &all=1 to include abandoned holds)
curl -H "Authorization: Bearer $TOKEN" "$SITE/api/admin?status=confirmed"
```

```bash
# refund a paid booking through Razorpay and free its slot
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"action":"refund","id":"<booking id>"}' "$SITE/api/admin"
```

```bash
# free a slot without refunding (e.g. you're rescheduling them); free bookings use this too
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"action":"cancel","id":"<booking id>"}' "$SITE/api/admin"
```

The customer's reference is the first 8 characters of the booking `id`, and it's also the order receipt in the Razorpay dashboard.

## Design

Colours, type, spacing and radii come from the Sage and Stone design system and live in [`public/tokens.css`](public/tokens.css) under the system's own token names. The brand rules the page follows: spacing only in 8/16/24/40px, no shadows, `border` is decoration only (controls get an `ink-muted` edge), JetBrains Mono for code-like text only, and one light theme. The theme has no error colour, so errors are marked with an "Error:" label and an `ink` outline rather than red.

Apple Garamond (the display face) isn't on Google Fonts, so the title falls back to EB Garamond everywhere except Apple devices that have it.

## Development

```bash
npm test          # date rules + API tests with a mock Razorpay (the API tests need `redis-server` installed; skipped otherwise)
npx vercel dev    # run site + API locally (needs the Redis variables above, e.g. via `vercel env pull`)
```

## Layout

```
public/            what the browser gets (Vercel's output directory)
  index.html  styles.css  tokens.css  app.js
  js/dates.js      date/slot rules shared by the page and the API
api/               serverless functions
  _config.js       schedule + payment settings
  _lib.js          Redis helper, atomic Lua scripts, validation, rate limiting
  config, slots, book, verify, webhook, status, release, admin, health
  _razorpay.js     Razorpay REST client + signature checks (no SDK)
  _pay.js          verifies a payment with Razorpay, then confirms or refunds
test/              node:test suites
vercel.json        output dir, security headers + strict CSP
```

## Ideas for next steps

- **Notify yourself of each booking** (email via Resend, or a WhatsApp/Telegram message) and email the customer a confirmation with the meeting link.
- **Block dates from the admin API** instead of editing `blockedDates` and redeploying.
- **A reschedule/cancel link** and a stated refund policy.
- **A privacy line**: you store names, emails and phone numbers; say for how long.
