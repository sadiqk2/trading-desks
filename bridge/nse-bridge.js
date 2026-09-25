/**
 * nse-bridge.js — local NSE data bridge (zero dependencies, Node ≥ 18)
 *
 *   node bridge/nse-bridge.js            # live NSE (run on your own machine / Indian IP)
 *   NSE_FIXTURE=1 node bridge/nse-bridge.js   # demo the pipeline with the bundled genuine snapshot
 *
 * Endpoints (CORS + Private-Network enabled so the GitHub Pages site can call it):
 *   GET /api/health   → feed status
 *   GET /api/chain    → NIFTY Options Desk Snapshot (schema in README)
 *   GET /api/snapshot → NSE Pulse most-active-contracts snapshot
 *
 * Both dashboards probe  http://127.0.0.1:8082  automatically and switch their
 * badge to LIVE when this bridge is running — from localhost OR from
 * https://sadiqk2.github.io/trading-desks/ in Chrome/Edge/Firefox.
 */
'use strict';

const http = require('http');
const live = require('./nse-live');

const PORT = Number(process.env.BRIDGE_PORT || 8082);
const cache = new Map();          // key → { at, data }
const TTL = 2500;

async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.data;
  const data = await fn();
  cache.set(key, { at: Date.now(), data });
  return data;
}

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
    if (url === '/api/health') return send(200, await live.health());
    if (url === '/api/chain') {
      const snap = await cached('chain', () => live.getDeskSnapshot());
      return send(200, snap);
    }
    if (url === '/api/snapshot') {
      const snap = await cached('ma', () => live.getMostActive());
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
    console.log('→ run from a residential/Indian connection, or demo with:  NSE_FIXTURE=1 node bridge/nse-bridge.js');
  }
});
