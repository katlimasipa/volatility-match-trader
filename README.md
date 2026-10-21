# ThDpst Matches — Volatility 100

Monochrome Deriv Matches bot for **Volatility 100**. It reads the last 1,000 digits, checks the spread rule, and places live **DIGITMATCH** trades on your Deriv account.

## What it does

1. Connect with **Deriv Auth 2.0** (or paste an API token on the iPhone home-screen app).
2. Buffer 1,000 ticks from Volatility 100.
3. Find the most and second-most common digits. Enter only when their difference is ≤ 0.3%.
4. Buy DIGITMATCH using the second-most digit as the barrier (3 runs per cycle).
5. On a loss, wait and re-analyse. Stop on take profit, stop loss, or end of cycle.
6. **Balance updates after every trade** in the app and on Deriv — no fake paper balances while connected.
7. **Cross-device alerts** — turn notifications on on each device. When you start the bot (or a trade settles) on one phone/desktop, the others on the same Deriv account get the alert too (app must be open or in the background on that device).

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

```sh
npm test
npm run build
```

## Strategy rules

- Window: last **1,000** ticks
- Spread: most − second-most ≤ **0.3%** (configurable)
- Entry digit = most common; match barrier = second most
- **3** runs per cycle; re-analyse after a loss

## Stack

TanStack Start, React, Tailwind, Deriv Auth 2.0 + WebSocket trading, PWA service worker.
