/**
 * nse-bridge.js — local NSE data bridge (zero dependencies, Node ≥ 18)
 *
 *   node bridge/nse-bridge.js            # live NSE (run on your own machine / Indian IP)
 *
 * Endpoints (CORS + Private-Network enabled for clients that explicitly call this bridge):
 *   GET /api/health   → feed status
 *   GET /api/chain    → NIFTY Options Desk Snapshot (schema in README)
 *   GET /api/snapshot → NSE Pulse most-active-contracts snapshot
 *
 * This bridge provides raw live API access for clients that explicitly call it.
 * The dashboards use their same-origin Node servers and do not silently fall back
 * to this bridge or to any local fixture.
 */
'use strict';

const http = require('http');
const live = require('./nse-live');

const PORT = Number(process.env.BRIDGE_PORT || 8082);
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Requested-With',
  'Access-Control-Allow-Private-Network': 'true',   // Chrome PNA preflight (public page → loopback)
  'Access-Control-Max-Age': '86400',
  'Cache-Control': 'no-store',
};

const server = http.createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0];
  const send = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...CORS });
    res.end(JSON.stringify(obj));
  };
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }

  try {
    if (url === '/api/health') {
      const health = await live.health();
      return send(health.mode === 'live' ? 200 : 503, health);
    }
    if (url === '/api/chain') {
      const snap = await live.getDeskSnapshot();
      return send(200, snap);
    }
    if (url === '/api/snapshot') {
      const snap = await live.getMostActive();
      return send(200, snap);
    }
    send(404, { error: 'unknown endpoint — try /api/health, /api/chain, /api/snapshot' });
  } catch (e) {
    send(502, {
      error: String(e.message || e),
      code: e.code || 0,
      hint: e.code === 403
        ? 'NSE Akamai blocked this host (datacentre IP). Run the bridge on your home/office connection in India.'
        : 'fetch failed — check connectivity to www.nseindia.com',
    });
  }
});

server.listen(PORT, '0.0.0.0', async () => {
  console.log(`NSE bridge → http://127.0.0.1:${PORT}  (CORS + private-network enabled)`);
  const h = await live.health();
  if (h.mode === 'live') {
    console.log(`feed: LIVE — ${h.source}`);
    const snap = await live.getDeskSnapshot().catch(() => null);
    if (snap) console.log(`NIFTY ${snap.spot.ltp}  ·  expiry ${snap.meta.expiry} (${snap.meta.dteText})  ·  ${snap.chain.length} strikes  ·  market ${snap.meta.marketStatus}`);
  } else {
    console.log(`feed: UNAVAILABLE — ${h.error || h.note}`);
    console.log('→ run from a residential/Indian connection. No fixture or generated fallback is enabled.');
  }
});
