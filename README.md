# ThDpst Matches — Volatility 100

Monochrome Deriv Matches bot for **Volatility 100**, **Volatility 10**, and their **1-second** variants. It reads the last 1,000 digits, checks the spread rule, and places live **DIGITMATCH** trades on your Deriv account.

## What it does

1. Connect with **Deriv Auth 2.0** (or paste an API token on the iPhone home-screen app).
2. Select a standard or 1-second Volatility 100/10 index and buffer its own 1,000 ticks before trading that same symbol.
3. Find the most and second-most common digits. Enter only when their difference is ≤ 0.3%.
4. Buy DIGITMATCH using the second-most digit as the barrier.
5. On a loss, wait and re-analyse. Stop when take profit or stop loss is reached.
6. Optionally enable 1.5× martingale: the next stake increases after each loss and returns to the base stake after a win. It increases risk and cannot guarantee recovery.
7. **Balance updates after every trade** in the app and on Deriv — no fake paper balances while connected.
8. **Cross-device alerts** — turn **NOTIF** on on each device (same Deriv account). Bot start/stop and trade results sync live via Realtime, catch up when you reopen the app, and use Web Push when the app is closed (needs VAPID keys + the SQL migration in `supabase/migrations/`).
9. **Next-digit forecast** — adapts to the latest 1,000 digits and tracks exact live forecast accuracy, without claiming future results are guaranteed.

## Auth & PWA

| Surface | How to connect |
|--------|----------------|
| Desktop / Android browser or PWA | **Sign in with Deriv Auth 2.0** (redirect must match the registered URI). |
| iPhone installed PWA | Paste a Deriv API token with **Read** + **Trade** (Safari and the app do not share OAuth storage). |

Registered redirect URI (must match Deriv portal exactly):

`https://thdpstmatches.vercel.app/`

## Setup

```sh
npm install
npm run dev
```

Copy `.env` values as needed:

- `VITE_DERIV_CLIENT_ID` — Auth 2.0 app / client id
- `VITE_DERIV_REDIRECT_URI` — exact redirect URI from the Deriv portal
- Supabase keys (optional email session)
- `VITE_VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` — Web Push for closed-app alerts

**One-time for closed-app push:** run `supabase/migrations/20261021_push_alerts.sql` in your Supabase SQL editor (Lovable Cloud), and set the VAPID keys on the host (Vercel / Lovable).

```sh
npm test
npm run build
```

## Strategy rules

- Window: last **1,000** ticks
- Spread: most − second-most ≤ **0.3%** (configurable)
- Entry digit = most common; match barrier = second most
- Re-analyse after a loss; stop at the configured take-profit or stop-loss target

## Stack

TanStack Start, React, Tailwind, Deriv Auth 2.0 + WebSocket trading, PWA service worker.
