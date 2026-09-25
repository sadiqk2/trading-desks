/**
 * NIFTY Options Desk — dev server
 *   • serves index.html (self-contained dashboard)
 *   • /api/health  → provider status
 *   • /api/chain   → option-chain Snapshot in the documented schema (README.md)
 *
 * LIVE DATA HOOK (architecture point #16):
 *   The dashboard consumes ONLY the normalized Snapshot schema. To go live,
 *   implement `fetchLiveSnapshot()` below (e.g. Kite Connect / Upstox / NSE via
 *   a cookie-warmed session) returning that schema and set mode:'live'. The UI
 *   needs no changes. Until then /api/chain reports mode:'sim' and the browser
 *   runs the built-in mock provider seeded from the real NSE chain of
 *   25-Sep-2026 10:40 IST.
 *
 *   node server.js        # http://localhost:8081
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 8081);
const PUBLIC_DIR = __dirname; // index.html sits at the project root (GitHub-Pages friendly)

/* ------------------------------------------------------------------
   Live adapter slot. Must resolve to the Snapshot schema in README.md:
   { meta, spot{ ltp,chg,chgPct,...,candles15m }, chain[ {strike, ce:Leg, pe:Leg} ] }
   Leg = { ltp, prevClose, chgPct, volume, oi, oiChg, iv, bid, ask, delta, thetaDay, prevOi, volAvg }
   ------------------------------------------------------------------ */
async function fetchLiveSnapshot() {
  // Example skeleton (uncomment & fill with your broker's SDK):
  //   const kite = new KiteConnect({ api_key: process.env.KITE_KEY });
  //   const oc = await kite.getOptionChain('NIFTY', expiry);
  //   return mapToSnapshot(oc);
  return null; // no live provider configured
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png',
};

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  const cors = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };

  if (p === '/api/health') {
    res.writeHead(200, { 'Content-Type': MIME['.json'], ...cors });
    res.end(JSON.stringify({
      mode: 'sim', liveConfigured: false,
      note: 'browser mock provider active (seeded from NSE 25-Sep-2026 10:40 IST)',
      serverTime: new Date().toISOString(),
    }));
    return;
  }

  if (p === '/api/chain') {
    const live = await fetchLiveSnapshot().catch(() => null);
    res.writeHead(live ? 200 : 501, { 'Content-Type': MIME['.json'], ...cors });
    res.end(JSON.stringify(live || {
      error: 'no live provider configured',
      hint: 'implement fetchLiveSnapshot() in server.js — schema in README.md',
    }));
    return;
  }

  let file = p === '/' ? '/index.html' : p;
  file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(buf);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`NIFTY Options Desk → http://0.0.0.0:${PORT}`);
});
