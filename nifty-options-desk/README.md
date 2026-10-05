# NIFTY Options Desk

An NSE option-chain dashboard for descriptive market-structure analysis, source-derived indicators and levels, scenario planning, and user-entered risk calculations. It does not place orders or guarantee outcomes.

## Run locally

From the repository root:

```bash
node nifty-options-desk/server.js
# open http://localhost:8081
```

Or from this directory:

```bash
node server.js
```

Set `PORT` to change the port. The server binds to `0.0.0.0` and serves both the page and its same-origin API.

## Live NSE data only

The app requests `/api/chain` from its own server and validates the response metadata before rendering. `/api/health` is available as a diagnostic endpoint. The server uses the shared adapter at `../bridge/nse-live.js` to request current NSE endpoints. It does not use a fixture, saved snapshot, mock provider, generated price series, or fallback feed. If NSE is unreachable or required fields are missing, the desk clears its displayed market snapshot and reports the feed unavailable.

GitHub Pages is static hosting, so it cannot read NSE directly (NSE sends no CORS headers). The page therefore looks for a live source in order: its own server (same origin) → a relay passed as `?relay=<origin>` or connected once with the on-page **“Connect a live source”** box → a dashboard server running on this machine (`http://localhost:8081`). Every candidate runs the same live-only adapter, and a snapshot is accepted only when its metadata is `mode: "live"` from `source: "nseindia.com"`. See the repository README for the one-click relay deployment. When nothing answers, the desk lists the attempted sources and their errors.

## Data and calculations

The adapter returns the current NSE option expiry, spot quote, option-chain rows, market status, and available source metadata. Incomplete expiry rows are omitted from calculations and their count is displayed. Optional fields that NSE does not provide remain unavailable; for example, chart-derived candles have no volume because the NSE chart endpoint supplies price points only.

The desk derives classifications, indicators, option-chain levels, setup conditions, and scenario values from the received live snapshot. These calculations include rule thresholds; those thresholds are analysis logic, not hardcoded NSE quotes or market history. Entry/stop/target values are labeled as scenario estimates, never as observed trades or simulated outcomes. The signal log records observations from successful live snapshots only.

## Shared live adapter

To inspect its standalone API instead, run from the repository root:

```bash
node bridge/nse-bridge.js
# /api/health, /api/chain, /api/snapshot on port 8082
```

The dashboard uses this bridge only when it is explicitly configured (bridge running on the viewer's machine, or a relay origin saved in the browser). It never accepts unrelated JSON, fixtures, or saved snapshots, and shows an unavailable state on failure.

## Risk notice

This tool is for education and observation, not investment advice or an order-management system. Derivatives trading involves substantial risk of loss.
