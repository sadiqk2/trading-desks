# Trading Desks

Two browser dashboards for NSE market data. **Displayed market values come from live NSE API responses only.** There are no bundled market snapshots, fixtures, seeded values, synthetic ticks, or simulated feed modes. If the live request fails or required data is incomplete, the dashboard reports the feed as unavailable instead of substituting values.

| App | Purpose | Local server |
|---|---|---|
| **NIFTY Options Desk** | NSE option-chain observations, source-derived levels and indicators, scenario planning, and a risk calculator | `node nifty-options-desk/server.js` → port 8081 |
| **NSE Pulse** | NSE most-active contracts with source-reported price, OI, volume, and turnover fields | `node nse-pulse/server.js` → port 8080 |

Set `PORT` to choose a different port. Both servers bind to `0.0.0.0` and serve their own dashboard and same-origin API.

## Where the live data can come from

NSE's JSON endpoints send **no CORS headers**, so a static page (GitHub Pages) can never read them directly, and a host that cannot reach `nseindia.com` cannot fetch them either. The dashboards therefore resolve a live source in this order and use the first one that works:

1. **Same-origin API** — the app's own Node server (`/api/chain`, `/api/snapshot`). This is the original local workflow and needs no configuration.
2. **A saved relay** — `?relay=<origin>` in the page URL, or the last relay someone connected with the **“Connect a live source”** box on the dashboard (kept in that browser's `localStorage`).
3. **A dashboard server on this machine** — `http://localhost:8081` (Options Desk) or `http://localhost:8080` (NSE Pulse), detected automatically.

Every path runs the *same* live-only code, `bridge/nse-core.js`, so a relay cannot introduce sample rows or cached snapshots: a response is only accepted when its metadata says `mode: "live"` and `source: "nseindia.com"`, and the dashboards clear the market display on anything else. When nothing answers, the dashboard shows an unavailable state plus the attempted sources and why each failed — never invented values.

## Getting live data on GitHub Pages (no local setup)

1. Deploy the relay — one click, free, no install:
   **[Deploy the Cloudflare Worker →](https://deploy.workers.cloudflare.com/?url=https://github.com/sadiqk2/trading-desks)**
   (or `npx wrangler deploy`, or paste `bridge/nse-worker.bundle.js` into a Worker in the Cloudflare dashboard).
2. Open the Worker's own page (e.g. `https://nse-live-relay.<you>.workers.dev/`). It links straight to both dashboards with the relay attached (`…/nifty-options-desk/?relay=https://nse-live-relay.<you>.workers.dev`).
3. Or paste that origin into the **“Connect a live source”** box on either dashboard. It is remembered in that browser, so a normal bookmark works afterwards.

The relay returns exactly the API shape the servers return and adds `Access-Control-Allow-Origin: *`, so the static pages behave like a locally served dashboard. It is live-only: nothing is cached or stored, and completed responses are never reused.

## Running the Node servers (most reliable, works offline of any relay)

```bash
node nifty-options-desk/server.js   # → http://localhost:8081
node nse-pulse/server.js            # → http://localhost:8080
```

The Node servers fetch NSE directly (cookieless first, session warm-up only if the exchange rejects a request) and expose the same `/api/*` routes as the relay, with CORS and Chrome private-network (PNA) preflight enabled so a page served from GitHub Pages can also use them.

An optional standalone HTTP bridge is available too:

```bash
node bridge/nse-bridge.js
# /api/health, /api/chain, and /api/snapshot on port 8082
```

## Repository layout

```text
index.html                 Static landing page
nifty-options-desk/        Options-chain dashboard and local server
nse-pulse/                 Most-active-contracts dashboard and local server
bridge/nse-core.js         Shared live-only fetch + normalization (Node, Workers, any host)
bridge/nse-live.js         Node entry point (wraps nse-core)
bridge/nse-worker.js       Cloudflare Worker relay (CORS + /api/*)
bridge/nse-worker.bundle.js  Generated single-file worker (paste-ready)
bridge/build-worker.js     Rebuilds the bundle from nse-core + nse-worker
bridge/nse-bridge.js       Optional standalone live API bridge (port 8082)
bridge/nse-relay-client.js Browser-side data source resolver + connect panel
wrangler.toml              Deploy config for the one-click relay
publish.sh                 GitHub Pages helper
```

## Data handling

- Market snapshots are requested directly from NSE; there is no saved response cache used as a fallback after a failed request.
- Market API requests use `no-store`; the adapter does not reuse a completed snapshot after a failed request. Concurrent calls may share one in-flight NSE request, but completed responses are fetched again on the next request.
- If the option-chain endpoint is rejected, the adapter warms an NSE session and retries, and it tries the current endpoint variants (`option-chain-indices`, `option-chain-v3`) before reporting failure.
- A failure in a secondary endpoint (all indices, market status, intraday chart, most-active) degrades that field to unavailable — it does not take the whole feed down. The option chain is required for the Options Desk and most-active rows are required for NSE Pulse.
- Option-chain candles in the Options Desk are aggregated from NSE chart price points. That source provides no volume for those points, so candle volume stays unavailable.
- NSE Pulse charts use only successful contract quotes received during the current browser session; they do not invent history between requests.
- Analytical thresholds and scenario formulas are code logic, not hardcoded prices, quotes, or market snapshots. Scenario levels are explicitly estimates and are not recommendations or orders.

## Checks

```bash
node --check bridge/nse-core.js
node --check bridge/nse-worker.js
node --check bridge/nse-relay-client.js
node --check bridge/nse-bridge.js
node --check nifty-options-desk/server.js
node --check nse-pulse/server.js
node bridge/build-worker.js      # regenerate bridge/nse-worker.bundle.js after edits

node test/core.test.mjs          # data pipeline, /api dispatcher, Worker bundle (no deps)
npm i -D jsdom                   # optional, for the browser-DOM tests
node test/relay-client.test.mjs  # which live source the page picks, and why
node test/e2e.test.mjs           # real dashboard pages on a static host + real relay
```

See [`test/README.md`](test/README.md) for what each test asserts. The HTML dashboards contain inline JavaScript; their scripts can be extracted and checked with Node as part of local validation. Successful syntax checks do not guarantee NSE will accept requests from a particular network.

## Risk notice

These pages provide descriptive and scenario-based analytics, not investment advice. Derivatives trading involves substantial risk of loss.
