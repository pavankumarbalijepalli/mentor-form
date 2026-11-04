# bunnybethinking — book a 1:1 session

A one-page booking site: visitors pick a slot, the slot is held for 15 minutes while they pay on PhonePe, and the booking is confirmed automatically once PhonePe says the payment went through. Static page in `public/`, serverless functions in `api/`, bookings in Upstash Redis. Styled with the **Sage and Stone** design system.

## Deploy on Vercel

1. **Push this repo to GitHub** (it already is) and, in Vercel, **Add New → Project → import it**. Leave the framework as *Other*: `vercel.json` already sets the output directory (`public`) and skips the build step.
2. **Add a Redis database.** In the project: *Storage → Create → Upstash for Redis* (any region; the free tier is plenty) and connect it. Vercel adds `KV_REST_API_URL` and `KV_REST_API_TOKEN`, which the API understands. Using your own Upstash database instead? Set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.
3. **Set up PhonePe** (next section) and add its variables.
4. **Add `ADMIN_TOKEN`**: a long random string (`openssl rand -hex 32`). It protects `/api/admin`; leave it unset to switch the admin endpoint off.
5. **Deploy**, then open `https://<your-site>/api/health`. You want `{"ok":true,"payments":true,"webhook":true,"siteUrl":"https://<your-site>"}`: Redis is reachable, the PhonePe variables are present, and `siteUrl` is where PhonePe will send customers back to. If `siteUrl` isn't your real address, set `SITE_URL`.
6. Make one real **test-mode booking** (below), then switch to live keys.
7. *Optional:* put the functions in the region nearest your database (`"regions": ["bom1"]` in `vercel.json` for Mumbai) and add your domain under *Settings → Domains*.

Environment variables are read at deploy time: redeploy after changing them.

## PhonePe setup

1. **Get a PhonePe Payment Gateway merchant account.** This is PhonePe's *business* payment gateway (PhonePe for Business), not the personal app. Live payments need PhonePe to approve your business onboarding, so start early. Their developer docs also describe a **sandbox** with test credentials you can use before approval.
2. **Get your API credentials** from the PhonePe Business dashboard (developer settings): a **Client ID**, a **Client Secret** and a **Client Version**. Sandbox and production have different credentials.
3. **Add these variables in Vercel** (Production and Preview), then redeploy:

   | Variable | Value |
   | --- | --- |
   | `PHONEPE_CLIENT_ID` | your Client ID |
   | `PHONEPE_CLIENT_SECRET` | your Client Secret |
   | `PHONEPE_CLIENT_VERSION` | your Client Version (defaults to `1` if you leave it out) |
   | `PHONEPE_ENV` | `sandbox` while testing, `production` when live. It must be set: payments stay off if it isn't. |
   | `SITE_URL` | your site's public address, e.g. `https://book.example.com`. PhonePe sends customers back here after they pay. |

4. **Set up the webhook** in the PhonePe dashboard so bookings are still confirmed when a customer pays and closes the tab:
   - **URL:** `https://<your-site>/api/webhook`
   - **Username / password:** choose any pair, and put them in Vercel as `PHONEPE_WEBHOOK_USERNAME` and `PHONEPE_WEBHOOK_PASSWORD`.
   - **Events:** order completed and order failed.
5. **Test in sandbox first.** Use the sandbox credentials and `PHONEPE_ENV=sandbox`, book a slot, pay with PhonePe's test instruments, and check the three things in the checklist below.
6. **Going live:** put the *production* credentials in Vercel, set `PHONEPE_ENV=production`, redeploy, and make one real booking for yourself.

How a payment is made safe: the server creates the order for the price in `api/_config.js` (the browser never sends an amount). When the customer comes back, or the webhook arrives, the server asks PhonePe itself for the order's state and only confirms if PhonePe says it is `COMPLETED` for the right amount. A webhook body is never believed on its own.

### First-test checklist (important)

I built this from PhonePe's published docs, but could not reach PhonePe from where I work, so none of it has run against the real PhonePe API. The code is tested against a local stand-in that behaves the way I understood the docs. Please confirm these in the **sandbox** before going live:

1. **A booking can be created and the customer reaches PhonePe's payment page.** If `/api/book` returns an error, the cause is in the server log (Vercel → Logs). The request is in `createPayment()` in `api/_phonepe.js`.
2. **After paying, the customer lands back on your site and sees "You're booked".** If it stays on "Checking your payment…", check the log for the order-status call.
3. **The webhook is accepted.** In the PhonePe dashboard's webhook log it should show success. If it shows `401`, the header format PhonePe sends differs from what `verifyWebhookAuth()` expects; payments still confirm when the customer returns to the page.
4. **A refund works.** Make a test booking, then run the `refund` admin command below.

Things I deliberately did **not** do, because the docs I could see were unclear or conflicting:
- **UPI-only checkout.** PhonePe has a payment-mode setting, but the docs describe two different formats. Customers see whatever payment methods your PhonePe account has enabled. Ask PhonePe to limit your account to UPI, or tell me once sandbox works and I'll add it.
- **Retry behaviour.** I assume that after a failed attempt the same payment page can be used again until the order expires. If PhonePe makes the order final on failure, the customer goes "Back" and books again.

## How a booking flows

1. **Details**: the visitor picks a day/time (shown in IST) and fills in their details. A valid promo code books the session for free right here and skips payment.
2. **Hold** (`POST /api/book`): the slot is reserved for 15 minutes and a PhonePe order is created.
3. **Pay**: the customer is sent to PhonePe's payment page. When they finish (or give up) PhonePe sends them back to `/?booking=<id>`, and the page asks the server for the result (`GET /api/status`), waiting up to a minute for PhonePe to settle.
4. **If the customer never comes back** (closed tab, lost connection), PhonePe's webhook confirms it. If they reload instead, the status check does. The page won't offer "Pay" again until they've checked whether the first payment went through.
5. **If they pay after the 15 minutes and someone else took the slot**, they're refunded automatically. If that refund call fails, the booking shows as `refund_due` in the admin list and you can retry it.

Going back or letting the hold run out releases the slot. States: `held → confirmed`, `released`, `cancelled`, and `refund_due → refunded`.

> You are not notified of new bookings yet. PhonePe's dashboard shows each payment, and promo bookings only show up in the admin list. See "Ideas".

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
# refund a paid booking through PhonePe and free its slot
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"action":"refund","id":"<booking id>"}' "$SITE/api/admin"
```

```bash
# free a slot without refunding (e.g. you're rescheduling them); free bookings use this too
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"action":"cancel","id":"<booking id>"}' "$SITE/api/admin"
```

The customer's reference is the first 8 characters of the booking `id`, and it's attached to the order's details in PhonePe.

## Design

Colours, type, spacing and radii come from the Sage and Stone design system and live in [`public/tokens.css`](public/tokens.css) under the system's own token names. The brand rules the page follows: spacing only in 8/16/24/40px, no shadows, `border` is decoration only (controls get an `ink-muted` edge), JetBrains Mono for code-like text only, and one light theme. The theme has no error colour, so errors are marked with an "Error:" label and an `ink` outline rather than red.

Apple Garamond (the display face) isn't on Google Fonts, so the title falls back to EB Garamond everywhere except Apple devices that have it.

## Development

```bash
npm test          # date rules + API tests with a mock PhonePe (the API tests need `redis-server` installed; skipped otherwise)
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
  config, slots, book, status, webhook, release, admin, health
  _phonepe.js      PhonePe REST client + webhook check (no SDK): all PhonePe specifics live here
  _pay.js          asks PhonePe whether an order is paid, then confirms or refunds
test/              node:test suites
vercel.json        output dir, security headers + strict CSP
```

## Ideas for next steps

- **Notify yourself of each booking** (email via Resend, or a WhatsApp/Telegram message) and email the customer a confirmation with the meeting link.
- **Block dates from the admin API** instead of editing `blockedDates` and redeploying.
- **A reschedule/cancel link** and a stated refund policy.
- **A privacy line**: you store names, emails and phone numbers; say for how long.
