# NSE Pulse · Most Active Contracts

**Live:** [sadiqk2.github.io/trading-desks/nse-pulse](https://sadiqk2.github.io/trading-desks/nse-pulse/) · part of [sadiqk2/trading-desks](https://github.com/sadiqk2/trading-desks)

A modern, elegant real-time dashboard inspired by **NSE India → Market Data → Most Active Contracts**,
with premium-flow analytics and an automatic **BUY / SELL / HOLD** signal engine.

## Features

- **Most Active Contracts** table — instrument, symbol, expiry, CE/PE, strike, LTP, %Chg,
  volume, value (₹ Cr premium for options), OI, ΔOI, sparkline trend, action signal
- **Premium-first analytics** — total premium traded, CE vs PE donut, PCR(premium),
  "Where People Pay Premium" leaderboard, real-time CE-vs-PE premium flow chart
- **Real-time chart** — LTP line + per-tick premium bars, crosshair tooltip
- **Auto refresh** — 2s / 3s / 5s / 10s with countdown ring (Space = pause, R = refresh now)
- **Buy / Sell / Hold verdict** — confidence ring + human-readable reasons
  (long/short build-up, covering/unwinding, writer pressure, momentum, premium skew)
- **Action Board** — top buy / sell / hold ideas with why

## Run

```bash
node server.js            # → http://localhost:8080  (PORT=… to change)
LIVE=0 node server.js     # skip live-NSE probing entirely
```

`index.html` is fully self-contained — you can open it directly in a browser too.

## Feed modes

| Mode | When | What you see |
|------|------|--------------|
| **LIVE** | server can reach `nseindia.com` API (residential IPs) | genuine most-active-contracts rows |
| **SIM** | NSE Akamai blocks the host (403 from data-centres/ISPs) | built-in tick engine seeded from the genuine NSE snapshot of **25-Sep-2026, 10:40 IST** (NIFTY 23,071) with realistic option-pricing dynamics (delta/theta/vega), OI build-up regimes and premium flow |

The status pill in the header always tells you which mode is live.

## Signals (educational, not investment advice)

```
score = buildup(price×OI) + momentum + trend(EMA8/21) + underlying thrust + writer pressure + premium skew
buildup:  price▲+OI▲ long build-up (+22) · price▼+OI▲ short build-up (−22)
          price▲+OI▼ short covering (+10) · price▼+OI▼ long unwinding (−10)
action:   score ≥ +22 BUY · ≤ −22 SELL · else HOLD   → confidence 52–96%
```
