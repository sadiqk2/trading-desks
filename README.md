# Trading Desks

Two browser dashboards for NSE market data. **Displayed market values come from live NSE API responses only.** There are no bundled market snapshots, fixtures, seeded values, synthetic ticks, or simulated feed modes. If the live request fails or required data is incomplete, the dashboard reports the feed as unavailable instead of substituting values.

| App | Purpose | Local server |
|---|---|---|
| **NIFTY Options Desk** | NSE option-chain observations, source-derived levels and indicators, scenario planning, and a risk calculator | `node nifty-options-desk/server.js` → port 8081 |
| **NSE Pulse** | NSE most-active contracts with source-reported price, OI, volume, and turnover fields | `node nse-pulse/server.js` → port 8080 |

Set `PORT` to choose a different port. Both servers bind to `0.0.0.0` and serve their own dashboard and same-origin API.

## Live data requirements

The Node servers request current data from `nseindia.com` through [`bridge/nse-live.js`](bridge/nse-live.js). Run an app server on a network that can reach NSE. NSE or its CDN may block some hosts; in that case the API returns an error and the UI shows an unavailable state. Static GitHub Pages hosting cannot run these Node APIs, so it will show the unavailable message rather than fake live data.

```bash
node nifty-options-desk/server.js
# open http://localhost:8081

node nse-pulse/server.js
# open http://localhost:8080
```

An optional standalone HTTP bridge is also available:

```bash
node bridge/nse-bridge.js
# /api/health, /api/chain, and /api/snapshot on port 8082
```

The dashboards do not silently probe the bridge or switch to another provider. The bridge likewise has no fixture mode or generated-data fallback. A successful response is not proof that every optional source field is populated: missing values are left blank/unavailable, and incomplete option-chain or most-active rows are counted in response metadata and surfaced by the dashboards.

## Data handling

- Market snapshots are requested directly from NSE; there is no saved response cache used as a fallback after a failed request.
- Market API requests use `no-store`; the adapter does not reuse a completed snapshot after a failed request. Concurrent calls may share one in-flight NSE request, but completed responses are fetched again on the next request.
- Option-chain candles in the Options Desk are aggregated from NSE chart price points. That source provides no volume for those points, so candle volume stays unavailable.
- NSE Pulse charts use only successful contract quotes received during the current browser session; they do not invent history between requests.
- Analytical thresholds and scenario formulas are code logic, not hardcoded prices, quotes, or market snapshots. Scenario levels are explicitly estimates and are not recommendations or orders.

## Repository layout

```text
index.html                 Static landing page
nifty-options-desk/        Options-chain dashboard and local server
nse-pulse/                 Most-active-contracts dashboard and local server
bridge/nse-live.js         Shared live NSE fetch and normalization
bridge/nse-bridge.js       Optional standalone live API bridge
publish.sh                GitHub Pages helper
```

## Checks

```bash
node --check bridge/nse-live.js
node --check bridge/nse-bridge.js
node --check nifty-options-desk/server.js
node --check nse-pulse/server.js
```

The HTML dashboards contain inline JavaScript; their scripts can be extracted and checked with Node as part of local validation. Successful syntax checks do not guarantee NSE will accept requests from a particular network.

## Risk notice

These pages provide descriptive and scenario-based analytics, not investment advice. Derivatives trading involves substantial risk of loss.
