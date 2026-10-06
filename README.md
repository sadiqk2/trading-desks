# Option Intelligence Dashboard

A live-only Indian options research dashboard for **NIFTY** and **BANKNIFTY**, powered by the Zerodha Kite Connect API. This repository replaces the earlier NSE-scraping dashboards with a server-side Kite Connect architecture.

> **No simulated market data.** If Kite is not authenticated, a quote is missing, or an input cannot be derived, the UI shows an unavailable state (`N/A`). Live quote observations, Kite historical candles and model-derived analytics are labelled separately. Version 1 has no order-placement endpoint.

## Architecture

```text
Browser (React + TypeScript + Vite)
  ├── HTTPS /api/* ──> FastAPI ──> Kite Connect REST / KiteTicker
  └── WSS /ws/market ─────────────┘
                            ├── Redis: latest genuine ticks + pub/sub
                            ├── PostgreSQL: instruments, live ticks, snapshots, candles
                            └── deterministic analytics / historical provider boundary
```

- **One FastAPI backend** owns the Kite API key, API secret and access token. They are never sent to React or included in API responses.
- The Kite instrument dump is fetched from Kite's live instrument endpoint after authentication. Tokens are discovered from that dump; the app does not hard-code instrument tokens.
- The option chain subscribes in KiteTicker `full` mode only to the selected expiry's displayed strikes plus the underlying index. The range is ±5, ±10, ±15 or ±20 listed strikes around the live ATM.
- Redis is a latest-tick cache and pub/sub transport. PostgreSQL is the persistence layer. If either is unavailable, system health reports that fact; neither supplies substitute market values.
- `MarketDataProvider`, `LiveMarketDataProvider` and `HistoricalMarketDataProvider` isolate the strategy calculations from their data source. Stored Kite observations and Kite historical candles are separate from the live chain. Backtest-ready tables exist; the dashboard does **not** claim a completed backtest or historical performance.

## Requirements

- Docker and Docker Compose (recommended), or Python 3.12+, Node.js 20+, PostgreSQL and Redis.
- A Zerodha Kite Connect app with the callback URL configured in its app settings.
- Kite access is subject to your account, subscription and Zerodha's API terms. Do not use this app to bypass those controls.

## Kite Connect setup

1. Create/configure a Kite Connect app and copy its API key and API secret.
2. Set the callback URL in the Kite developer console. For the local Compose setup, use:

   ```text
   http://localhost:8000/api/auth/callback
   ```

   If you run the application behind a public HTTPS domain, use that domain's backend callback path and set `KITE_REDIRECT_URL` to the same URL. Keep the callback URL exactly aligned with the Kite app configuration.
3. Copy `.env.example` to `.env` and add `KITE_API_KEY` and `KITE_API_SECRET`. Never put either value in a `VITE_*` variable or frontend file.
4. Open the dashboard and choose **Connect Kite**. Kite redirects to the backend callback. The backend exchanges the one-time request token and keeps the access token in server memory. The token is not returned to the browser or written to logs. Kite access tokens generally expire daily.
5. For a backend restart that should begin with an already-issued token, set `KITE_ACCESS_TOKEN` in `.env`; remove/rotate it when it expires. The OAuth flow is preferred.

No valid credentials are bundled. Without authentication the UI intentionally stays empty and shows the setup instructions.

## Environment variables

See [`.env.example`](.env.example).

| Variable | Purpose |
|---|---|
| `KITE_API_KEY` | Server-side Kite API key |
| `KITE_API_SECRET` | Server-side Kite API secret; never returned or logged |
| `KITE_ACCESS_TOKEN` | Optional server-side daily token |
| `KITE_REDIRECT_URL` | Documented callback URL; register the same URL in the Kite app |
| `DATABASE_URL` | PostgreSQL URL for local backend runs |
| `REDIS_URL` | Redis URL for local backend runs |
| `RISK_FREE_RATE` | Configurable annual continuously-compounded rate for Black–Scholes (default `0.06`) |
| `OI_WALL_PERCENTILE` | OI wall percentile from 50 to 99 (default `90`) |
| `STALE_AFTER_SECONDS` | Tick staleness threshold (default `15`) |
| `POSTGRES_*` | Local Compose database bootstrap values; change defaults outside development |

## Run with Docker Compose

From the repository root:

```bash
cp .env.example .env
# Edit .env and set KITE_API_KEY and KITE_API_SECRET.
docker compose up --build
```

Open <http://localhost:8080>. Compose starts PostgreSQL and Redis, runs Alembic migrations, starts FastAPI, then serves the built React app through Nginx. Nginx proxies `/api` and `/ws` to FastAPI, so browser code only uses same-origin URLs. The backend API is also bound locally at <http://localhost:8000> for development diagnostics.

Stop the stack:

```bash
docker compose down
```

Remove local database/cache data only when you explicitly intend to reset it:

```bash
docker compose down -v
```

## Run services locally (without the frontend container)

Start PostgreSQL and Redis first, then configure their local URLs in `.env`.

### Backend

```bash
cd backend
python3.12 -m venv .venv
source .venv/bin/activate       # Windows: .venv\Scripts\activate
pip install -r requirements.txt
alembic upgrade head
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000 --no-access-log
```

FastAPI docs: <http://localhost:8000/docs>. Health/status: <http://localhost:8000/api/system/status>.

### Frontend

In a second terminal, from the repository root:

```bash
cd frontend
npm install
npm run dev -- --host 0.0.0.0
```

Open <http://localhost:5173>. Vite proxies relative `/api` and `/ws` requests to the backend; no browser-facing `localhost` service URL is embedded in the app.

## WebSocket and data quality

`WS /ws/market?underlying=NIFTY&expiry=YYYY-MM-DD&strike_range=10` sends:

- one real Kite option-chain snapshot when available;
- subsequent selected-contract KiteTicker full-mode ticks;
- server heartbeat/status metadata (not market values).

The browser does not poll market quotes. It uses WebSocket updates for price, OI, depth, IV/Greeks and timestamps. A low-frequency status request is used for service health only. Each tick carries an observation timestamp and, where Kite provides it, the exchange timestamp. Staleness is evaluated from the exchange timestamp first. Kite reconnects automatically; the UI distinguishes API authentication, KiteTicker connection, dashboard WebSocket and data freshness.

Change OI is measured as:

```text
current Kite OI − first OI observed by this service for that contract on the IST trading day
```

It is **not** presented as previous-close OI. The dashboard labels the baseline and returns `N/A` until current and baseline values exist. OI totals/PCR refer only to the selected strike window, not the entire exchange chain. OI walls use the configured percentile and are not declared support/resistance.

## Option analytics

- **ATM:** nearest listed strike to the actual Kite underlying quote.
- **PCR:** selected-window total PE OI divided by selected-window CE OI; unavailable if inputs are absent.
- **OI walls:** percentile threshold on observed OI within the selected chain.
- **Price/OI activity:** deterministic LONG_BUILDUP / SHORT_BUILDUP / SHORT_COVERING / LONG_UNWINDING quadrants; labels describe the observed relationship, not expected direction.
- **IV:** Kite Connect does not include IV in its normal quote response. When spot, a genuine option price, strike and unexpired contract are available, the service calculates IV with Black–Scholes bisection. It prefers a valid bid/ask midpoint and otherwise uses the Kite LTP. Unresolvable values remain `N/A`.
- **Greeks:** Delta, Gamma, daily Theta and Vega per volatility percentage point are calculated from that IV using Black–Scholes. They are explicitly labelled calculated, not broker supplied.
- **Expected move:** `spot × annualized ATM IV × sqrt(time to expiry / 365)`. It is an estimate, not a guaranteed range.
- **Signals:** transparent deterministic score over observed spot change, selected-window PCR, near-ATM OI additions, near-ATM price/OI classification and traded-volume balance. Confidence is score alignment, not probability. Signals are disabled when the schedule is closed, inputs are stale or data is insufficient.

`RISK_FREE_RATE` is a model assumption and is configurable. It is not represented as a live government-bill quote.

## Historical data and backtesting boundary

- `GET /api/history/{instrument_token}` requests genuine Kite historical candles and stores the returned candles separately in `candles` with `data_source=kite_historical`.
- Live WebSocket observations go to `market_ticks`, `option_snapshots` and `oi_snapshots`; they are not presented as historical candles.
- `HistoricalMarketDataProvider` reads persisted Kite observations/candles, while `LiveMarketDataProvider` reads current live data. `evaluate_normalized_snapshot` is the shared deterministic strategy entry point.
- Tables for instruments, option contracts, ticks, snapshots, candles, signals, analysis-only trades, backtest runs and results are included. Historical data coverage depends on Kite availability and what has actually been collected. No performance, P&L or profitability claims are generated by this version.

## API surface

- `GET /api/system/status`
- `GET /api/market/status`
- `GET /api/auth/status`
- `GET /api/auth/login-url`
- `GET /api/auth/callback` (Kite redirect only)
- `GET /api/underlyings`
- `GET /api/expiries/{underlying}`
- `GET /api/option-chain/{underlying}/{expiry}?range=10`
- `GET /api/market/{underlying}`
- `GET /api/oi-analysis/{underlying}/{expiry}?range=10`
- `GET /api/signals/{underlying}`
- `GET /api/history/{instrument_token}?interval=minute&from_date=YYYY-MM-DD&to_date=YYYY-MM-DD`
- `GET /api/risk/calculate` (user-input math only)
- `WS /ws/market`

There is no order placement, order modification, or automatic strategy execution API.

## Tests and checks

```bash
cd backend
pip install -r requirements-dev.txt
python -m unittest discover -s tests -v
python -m compileall -q app tests

cd ../frontend
npm ci
npm run build
npm audit
```

The analytics unit tests use fixed numerical fixtures for formulas only. Those fixtures are not used as production data. No production/demo feed or mock market-data mode is provided.

## Troubleshooting

- **“Kite is not configured”** — populate `KITE_API_KEY` and `KITE_API_SECRET` in the backend environment, then restart the backend.
- **Authentication redirects back as failed** — check that the registered Kite callback exactly matches the backend callback URL, and confirm system time and API app access.
- **“Could not download the Kite instrument master”** — verify API access token validity, network access and Kite Connect permissions. The dashboard will not substitute NSE or sample data.
- **Kite authenticated but ticker disconnected** — check the Kite access-token lifetime and backend logs. KiteTicker reconnects automatically; re-authenticate if its token expired.
- **Some cells show `N/A`** — Kite may not have returned a quote/depth/OI field, the contract may be stale, or the required inputs for derived IV/Greeks are missing. This is intentional.
- **OI change is zero at first observation** — that first captured OI becomes the intraday baseline. It is not a previous-close comparison.
- **Database shows unavailable** — verify Postgres is healthy, the `DATABASE_URL` is reachable, and migrations have run (`alembic upgrade head`). Live ticks remain timestamped in process/Redis, but PostgreSQL persistence is degraded.
- **Redis shows unavailable** — verify Redis and `REDIS_URL`. The UI reports degraded cache status and never swaps in cached historical market values as live data.
- **Historical chart has no bars** — select an authenticated instrument and press **Load today**. Kite may return no candles before/after a session or for a restricted instrument/interval.

## Safety

This application is an analytics and research tool, not financial advice, an automatic profit generator, or a trading executor. Derivatives can result in losses exceeding expectations. Verify data quality and broker timestamps independently before relying on any observation.
