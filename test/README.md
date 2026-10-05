# Tests

Optional local checks for the live-data path. Nothing here ships with the dashboards or the relay.

```bash
# no dependencies
node test/core.test.mjs          # fetch/normalization, /api dispatcher, Worker bundle
node bridge/build-worker.js      # regenerate bridge/nse-worker.bundle.js after edits

# optional (browser-DOM tests): one-time install
npm i -D jsdom
node test/relay-client.test.mjs  # which live source the page picks, and why
node test/e2e.test.mjs           # real dashboard pages on a static host + real relay + mock NSE
```

The jsdom tests skip themselves with a message when `jsdom` is not installed.

## What is covered

| Test | Scope |
|---|---|
| `core.test.mjs` | Normalization against a healthy feed (spot/basis, front expiry, VIX, candles, most-active rows), the `/api/*` dispatcher, and the failure modes that must report unavailable: blocked/HTTP error, HTML bot page, missing option chain, connection refused, stalled exchange (health budget). Also loads the generated Worker bundle and asserts routes, CORS, `Cache-Control: no-store`, the private-network preflight header, and the `?relay=` landing links. |
| `relay-client.test.mjs` | Browser-side source resolution: same-origin → saved relay → local server, normalisation of pasted origins, rejecting unrelated JSON endpoints, refusing to save loopback servers, passing a blocked relay's upstream error through verbatim, and the connect panel (idempotent re-mount, remembered origin, single refresh trigger). |
| `e2e.test.mjs` | The real `nse-pulse/index.html` and `nifty-options-desk/index.html` executed in a DOM against a static host (like GitHub Pages) and the real Worker relay: live values render with a relay, and the unavailable state (never substitute data) shows without one. |

## About `mock-nse.js`

`test/mock-nse.js` is a synthetic stand-in for the NSE endpoints so the pipeline can be exercised without network access. Its payloads exist only inside the test process and are never imported by the servers, the relay, or the dashboards — there is no code path that could serve them to a user. Live-only behaviour is asserted explicitly: a non-live payload, an HTML page, or a missing option chain must all end in an unavailable state.
