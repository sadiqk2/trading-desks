/**
 * nse-bridge.js — standalone NSE data bridge (zero dependencies, Node ≥ 18)
 *
 *   node bridge/nse-bridge.js            # live NSE (run on your own machine / Indian IP)
 *
 * Endpoints (CORS + Private-Network enabled for clients that explicitly call this bridge):
 *   GET /api/health   → feed status
 *   GET /api/chain    → NIFTY Options Desk snapshot
 *   GET /api/snapshot → NSE Pulse most-active-contracts snapshot
 *
 * This is the same live-only adapter the dashboards' own servers run, exposed on
 * a separate port. The dashboards do not silently switch to it: the browser
 * client (bridge/nse-relay-client.js) only uses a bridge or relay the user has
 * configured, and never substitutes fixtures for a failed request.
 */
'use strict';

const http = require('http');
const live = require('./nse-live');

const PORT = Number(process.env.BRIDGE_PORT || 8082);
const CORS = live.CORS_HEADERS;

const server = http.createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0];
  const send = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...CORS });
    res.end(JSON.stringify(obj));
  };

  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }

  const { status, body } = await live.handleApi(url);
  send(status, body);
});

server.listen(PORT, '0.0.0.0', async () => {
  console.log(`NSE bridge → http://0.0.0.0:${PORT}  (CORS + private-network enabled)`);
  const h = await live.health();
  if (h.mode === 'live') {
    console.log(`feed: LIVE — ${h.source}`);
    const snap = await live.getDeskSnapshot().catch(() => null);
    if (snap) console.log(`NIFTY ${snap.spot.ltp}  ·  expiry ${snap.meta.expiry} (${snap.meta.dteText})  ·  ${snap.chain.length} strikes  ·  market ${snap.meta.marketStatus}`);
  } else {
    console.log(`feed: UNAVAILABLE — ${h.error || h.note}`);
    console.log('→ run from a residential/Indian connection, or deploy bridge/nse-worker.js as a hosted relay. No fixture or generated fallback is enabled.');
  }
});
