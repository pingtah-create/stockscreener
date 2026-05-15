# Deployment notes — what to set up after pulling these changes

This document is for you (or future-you) to operationalise the four new things
landed in this batch:

1. About / Disclaimer pages
2. Plausible analytics
3. Broker affiliate links
4. Price alerts (Supabase + Vercel cron + Resend email)

---

## 1. Supabase — schema changes

Run these in the Supabase SQL editor. RLS must stay disabled on both tables
(everything is server-side with the anon key).

```sql
-- Add email column to users table (for alert delivery)
alter table users
  add column if not exists email text;

-- Add alerts column to portfolios table (JSON array of alert objects)
alter table portfolios
  add column if not exists alerts jsonb default '[]'::jsonb;

-- Optional: index for the cron's "not null" scan
create index if not exists idx_portfolios_alerts_notnull
  on portfolios ((alerts is not null));
```

Each alert object has shape:
```json
{
  "id":          "AAPL-above-200",
  "ticker":      "AAPL",
  "direction":   "above",      // or "below"
  "target":      200.00,
  "created_at":  "2026-05-15T12:00:00Z",
  "triggered_at": null
}
```

---

## 2. Resend (email delivery)

1. Sign up at https://resend.com (free tier: 3,000 emails/month, 100/day).
2. Verify a sending domain — easiest is `stockdash.app` if you own it, otherwise
   use Resend's `onboarding@resend.dev` (only works to your verified address).
3. Create an API key and add to Vercel env:
   ```
   RESEND_API_KEY=re_...
   RESEND_FROM=alerts@stockdash.app          # whichever domain you verified
   ```

If `RESEND_API_KEY` is unset the cron still runs but `_resend_send()` returns
`False` and the alert stays in place — no spam, no crash.

---

## 3. Vercel cron

`vercel.json` already declares:
```json
"crons": [{ "path": "/api/cron/alerts", "schedule": "*/15 * * * *" }]
```

This fires every 15 min on Vercel's free Hobby plan (max 2 crons, daily
schedules only above that — `*/15` is fine).

Add a secret so randos can't spam your alert checker:
```
CRON_SECRET=<some long random string>
```

Vercel automatically attaches the header `X-Cron-Secret` from the env var to
cron requests (`Authorization: Bearer ${CRON_SECRET}` actually — but for our
hand-rolled scheme we read either `X-Cron-Secret` header or `?secret=` query
param). If you want the official Vercel header, change the check in
`api_cron_alerts()` to read `Authorization` instead.

Quick local test (with the server running):
```bash
curl -X POST http://localhost:5000/api/cron/alerts?secret=$CRON_SECRET
```

---

## 4. Plausible analytics

1. Add your domain at https://plausible.io.
2. Set the env var on Vercel:
   ```
   PLAUSIBLE_DOMAIN=stockdash.app
   ```
3. That's it. The script tag is conditionally injected by Flask only when the
   env var is set, so local dev stays clean.

Custom events (already wired):
- `Broker Click` — fired when a user clicks Tiger/Webull/IBKR links. Props:
  `{ broker, ticker }`.

---

## 5. Broker affiliate IDs

The links in `templates/stock.html` are currently placeholder homepage URLs.
Replace them once you have affiliate codes:

| Broker | Current URL | Where to apply |
|--------|-------------|----------------|
| Tiger Brokers | `https://www.tigerbrokers.com.sg/` | Tiger has a referral program in their app — generate your referral link and paste it. |
| Webull | `https://www.webull.com/` | https://www.webull.com/activity/share/referFriend |
| Interactive Brokers | `https://www.interactivebrokers.com/` | https://www.interactivebrokers.com/en/index.php?f=1340 (IB Referral) |

Add `?utm_source=stockdash` to any of them for easy attribution in your own
analytics regardless of the broker's tracking.

---

## 6. Testing checklist

Run `python app.py` and verify locally:

- [ ] `/about` and `/disclaimer` render
- [ ] Disclaimer badge bottom-right of every page links to `/disclaimer`
- [ ] Signup form has an optional email field
- [ ] On `/stock/AAPL`, the `⊕ Trade` button opens the broker popup
- [ ] On `/stock/AAPL`, setting a price alert hits `POST /api/alerts` (check Network tab)
- [ ] `GET /api/alerts` returns the saved alerts
- [ ] `POST /api/account/email` with `{"email": "you@example.com"}` returns `{ok: true}`
- [ ] `POST /api/cron/alerts?secret=$CRON_SECRET` returns `{ok: true, users_checked, emails_sent}`
