# Trading Desks

Self-contained market-analytics terminals that run fully client-side (also runnable locally
with the tiny Node servers in each folder).

**Live:** https://&lt;you&gt;.github.io/trading-desks/

| Desk | What it does | Live path | Local |
|------|--------------|-----------|-------|
| **NIFTY Options Desk** | Option-chain terminal — market structure with evidence, OI-based key levels, per-strike OI-interpretation (long buildup / writing / short covering / unwinding), CE·PE·RANGE setup scanner, breakout/breakdown alerts, contract selector (spread & liquidity), trade planner, risk calculator, signal log | [`/nifty-options-desk/`](nifty-options-desk/) | `cd nifty-options-desk && node server.js` → :8081 |
| **NSE Pulse** | Most-active-contracts flow — premium traded, CE-vs-PE premium chart, live tick charts, BUY/SELL/HOLD per contract, auto-refresh | [`/nse-pulse/`](nse-pulse/) | `cd nse-pulse && node server.js` → :8080 |

## Data architecture

Both apps keep a strict **data-layer / analytics / UI** split. Feeds today are realistic simulators
seeded from genuine NSE snapshots (25-Sep-2026, 10:40 IST); each project documents the normalized
schema its provider must return, so a live broker feed (Kite / Upstox / NSE proxy) drops in without
UI changes — see each folder's `README.md` and the `LiveProvider` slots.

## Publishing (GitHub Pages)

This repo is itself the Pages site (index at root, apps in subfolders). Enable with:

```bash
GITHUB_TOKEN=ghp_xxx ./publish.sh     # creates repo, pushes, enables Pages, prints live URL
```

or by hand: push to `main`, then **Settings → Pages → Deploy from a branch → main / (root)**.

---

*Educational analytics only — nothing here is investment advice or a guarantee of outcome.*
