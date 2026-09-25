# Trading Desks · @sadiqk2

Self-contained market-analytics terminals that run fully client-side (also runnable locally
with the tiny Node servers in each folder).

**Owner:** Sadiq Ali Khan ([@sadiqk2](https://github.com/sadiqk2))
**Live:** [https://sadiqk2.github.io/trading-desks/](https://sadiqk2.github.io/trading-desks/)

| Desk | What it does | Live URL | Local |
|------|--------------|----------|-------|
| **NIFTY Options Desk** | Option-chain terminal: market structure with evidence ladder, OI-based S/R, per-strike buildup/writing classification, CE/PE/RANGE setup scanner, breakout alerts, contract selector, trade plans and a risk calculator. | [sadiqk2.github.io/trading-desks/nifty-options-desk](https://sadiqk2.github.io/trading-desks/nifty-options-desk/) | `cd nifty-options-desk && node server.js` → :8081 |
| **NSE Pulse** | Most-active-contracts flow: premium-traded leaderboard, CE-vs-PE premium flow, live tick charts and per-contract BUY / SELL / HOLD signals with auto-refresh. | [sadiqk2.github.io/trading-desks/nse-pulse](https://sadiqk2.github.io/trading-desks/nse-pulse/) | `cd nse-pulse && node server.js` → :8080 |

## Data architecture

Both apps keep a strict **data-layer / analytics / UI** split. Feeds today are realistic simulators
seeded from genuine NSE snapshots (25-Sep-2026, 10:40 IST); each project documents the normalized
schema its provider must return, so a live broker feed (Kite / Upstox / NSE proxy) drops in without
UI changes — see each folder's `README.md` and the `LiveProvider` slots.

## Repository layout

```
sadiqk2/trading-desks            ← GitHub Pages site root
├─ index.html                    ← landing hub  → sadiqk2.github.io/trading-desks/
├─ nifty-options-desk/           ← options desk → sadiqk2.github.io/trading-desks/nifty-options-desk/
├─ nse-pulse/                    ← most active  → sadiqk2.github.io/trading-desks/nse-pulse/
└─ publish.sh                    ← create repo → push → enable Pages → print live URL
```

## Publishing (GitHub Pages)

This repo is itself the Pages site (index at root, app folders as subpaths) and redeploys
automatically on every push to `main`. To bootstrap or re-publish:

```bash
GITHUB_TOKEN=ghp_xxx ./publish.sh     # reuses sadiqk2/trading-desks, pushes, enables Pages, prints live URL
```

or by hand: push to `main`, then **Settings → Pages → Deploy from a branch → main / (root)**.

Repo: [github.com/sadiqk2/trading-desks](https://github.com/sadiqk2/trading-desks)

---

*Educational analytics only — nothing here is investment advice or a guarantee of outcome.*
