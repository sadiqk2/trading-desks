# NSE Pulse · Most Active Contracts

A live-only dashboard for NSE most-active contract rows. It presents source-reported LTP, daily price change, volume, turnover, open interest, and OI change when those fields are provided. Price/OI labels are descriptive observations, not buy/sell recommendations.

## Run locally

From the repository root:

```bash
node nse-pulse/server.js
# open http://localhost:8080
```

Or from this directory:

```bash
node server.js
```

Set `PORT` to choose a different port. The server binds to `0.0.0.0` and serves the page and `/api/snapshot` from the same origin.

## Live NSE data only

The server uses `../bridge/nse-live.js` to fetch NSE responses. It does not use bundled rows, fixtures, local snapshots, mock feeds, generated ticks, or a simulated mode. If the request fails or the response contains no usable contracts, the UI clears the market display and reports that live data is unavailable. Incomplete rows are counted in metadata; optional missing fields display as unavailable rather than zero.

GitHub Pages is static hosting and cannot run the Node API. To see data, open the dashboard through this server on a network that can reach NSE. NSE/CDN access may be blocked on some networks.

## What the dashboard computes

- Turnover totals, CE/PE comparison, and the leaderboard are derived only from the current most-active rows returned by NSE; the page reports coverage and does not imply that this subset is the full market.
- Price/OI labels compare the source-provided daily price change and OI change. Missing fields produce an unavailable label.
- Contract price charts contain only successful NSE quotes received in the current browser session. No historical ticks or flow buckets are fabricated. The `/api/series` endpoint explicitly returns `501` because this feed provides no historical series.
- Analytical classifications use code thresholds, but no hardcoded prices, OI figures, sample contracts, or market snapshots are embedded in the dashboard.

## Shared live adapter

To inspect the standalone bridge API, run from the repository root:

```bash
node bridge/nse-bridge.js
# /api/health, /api/chain, /api/snapshot on port 8082
```

NSE Pulse does not silently switch to the bridge or another provider; its same-origin server is the only source. Errors are surfaced instead of replaced with local data.

## Risk notice

This dashboard provides descriptive data only, not investment advice or a recommendation. Derivatives trading involves substantial risk of loss.
