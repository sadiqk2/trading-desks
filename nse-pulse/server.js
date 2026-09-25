/**
 * NSE Pulse — Most Active Contracts
 * Tiny zero-dependency Node server:
 *   - serves the self-contained dashboard (index.html)
 *   - /api/health    → feed status
 *   - /api/snapshot  → most-active-contracts snapshot (live NSE when reachable)
 *   - /api/series    → full tick series for one contract
 *
 * When NSE's Akamai WAF blocks datacenter IPs (403), the API reports live:false
 * and the dashboard automatically runs its built-in realistic tick engine
 * (seeded from the genuine 25-Sep-2026 10:40 IST NSE snapshot).
 *
 * Run:  node server.js        (PORT=8080 by default, binds 0.0.0.0)
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 8080);
const PUBLIC_DIR = __dirname; // index.html sits at the project root (GitHub-Pages friendly)
const NSE_LIVE = process.env.LIVE !== '0'; // attempt live NSE by default

/* ------------------------------------------------------------------ */
/* Optional live NSE adapter                                           */
/* ------------------------------------------------------------------ */
const NSE_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://www.nseindia.com/market-data/most-active-contracts',
};

let cookieJar = '';
let liveCache = null; // { at: ms, payload }
let liveState = { live: false, checkedAt: 0, reason: 'not-checked' };

function parseSetCookie(res) {
  const raw = res.headers['set-cookie'] || [];
  for (const c of raw) {
    const pair = c.split(';')[0];
    cookieJar += (cookieJar ? '; ' : '') + pair;
  }
}

async function nseGet(url) {
  const doFetch = globalThis.fetch;
  const res = await doFetch(url, {
    headers: { ...NSE_HEADERS, Cookie: cookieJar },
    redirect: 'follow',
  });
  parseSetCookie(res);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

async function fetchNseSnapshot() {
  // warm cookies from homepage + option chain page (standard NSE dance)
  await nseGet('https://www.nseindia.com/').catch(() => {});
  await nseGet('https://www.nseindia.com/option-chain').catch(() => {});
  const candidates = [
    'https://www.nseindia.com/api/live-analysis-most-active-contracts?index=volume_contracts',
    'https://www.nseindia.com/api/live-analysis-most-active-contracts',
  ];
  let lastErr;
  for (const u of candidates) {
    try {
      const json = await nseGet(u);
      const rows = normalizeNse(json);
      if (rows && rows.length) return rows;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('no rows');
}

/** Tolerant mapper — NSE key names vary slightly across endpoints. */
function normalizeNse(json) {
  const arr = json && (json.data || json.data1 || json);
  if (!Array.isArray(arr)) return null;
  const pick = (o, keys, dflt = 0) => {
    for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== '-') return Number(o[k]) || 0;
    return dflt;
  };
  const rows = [];
  for (const o of arr) {
    const optType = /PE|PUT/i.test(o.optionType || o.option || '') ? 'Put'
      : /CE|CALL/i.test(o.optionType || o.option || '') ? 'Call' : null;
    const inst = o.instrument || o.instrumentType || (optType ? (o.symbol || '').includes('NIFTY') ? 'IDXOPT' : 'STKOPT' : 'STKFUT');
    rows.push({
      id: o.identifier || `${inst}${o.symbol}${o.expiryDate}${optType ? (optType === 'Put' ? 'PE' : 'CE') : 'XX'}${o.strikePrice || 0}`,
      instrument: inst,
      symbol: o.symbol || '',
      expiry: o.expiryDate || o.expiry || '',
      optType,
      strike: pick(o, ['strikePrice', 'strike'], 0),
      ltp: pick(o, ['lastPrice', 'lastTradedPrice', 'ltp'], 0),
      chgPct: pick(o, ['pChange', 'pctChange', 'changePercent'], 0),
      volume: pick(o, ['numberOfContractsTraded', 'totalTradedVolume', 'volume'], 0),
      valueLakhs: pick(o, ['totalTurnover', 'value', 'turnover'], 0),
      oi: pick(o, ['openInterest', 'openInterestContracts', 'oi'], 0),
      oiChg: pick(o, ['changeInOpenInterest', 'oiChange'], 0),
      underlying: pick(o, ['underlyingValue', 'spotPrice'], 0),
    });
  }
  return rows.filter((r) => r.symbol && r.ltp > 0);
}

async function getSnapshotPayload() {
  if (NSE_LIVE) {
    const now = Date.now();
    if (liveCache && now - liveCache.at < 3000) return liveCache.payload;
    try {
      const rows = await fetchNseSnapshot();
      const payload = {
        meta: {
          mode: 'live',
          feedLabel: 'LIVE · nseindia.com most active contracts',
          asOf: new Date().toISOString(),
        },
        contracts: rows,
      };
      liveCache = { at: now, payload };
      liveState = { live: true, checkedAt: now, reason: 'ok' };
      return payload;
    } catch (e) {
      liveState = { live: false, checkedAt: now, reason: String(e && e.message || e) };
      // fall through → sim
    }
  }
  return {
    meta: {
      mode: 'sim',
      feedLabel: 'SIM · built-in tick engine (NSE blocks this host · seeded from NSE 25-Sep-2026 10:40 IST)',
      asOf: new Date().toISOString(),
    },
    contracts: null, // client runs the shared engine
  };
}

/* ------------------------------------------------------------------ */
/* Static + API server                                                 */
/* ------------------------------------------------------------------ */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;

  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  };

  if (p === '/api/health') {
    res.writeHead(200, { 'Content-Type': MIME['.json'], ...cors });
    res.end(JSON.stringify({
      live: liveState.live,
      liveAttempted: liveState.checkedAt > 0,
      reason: liveState.reason,
      mode: liveState.live ? 'live' : 'sim',
      serverTime: new Date().toISOString(),
    }));
    return;
  }

  if (p === '/api/snapshot') {
    try {
      const payload = await getSnapshotPayload();
      res.writeHead(200, { 'Content-Type': MIME['.json'], ...cors });
      res.end(JSON.stringify(payload));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': MIME['.json'], ...cors });
      res.end(JSON.stringify({ error: String(e) }));
    }
    return;
  }

  if (p === '/api/series') {
    // full series live only in sim mode (kept client-side); live mode keeps series client-side too
    res.writeHead(501, { 'Content-Type': MIME['.json'], ...cors });
    res.end(JSON.stringify({ error: 'series maintained by the dashboard engine' }));
    return;
  }

  // static files
  let file = p === '/' ? '/index.html' : p;
  file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  fs.readFile(full, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(buf);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`NSE Pulse dashboard → http://0.0.0.0:${PORT}  (live NSE attempt: ${NSE_LIVE ? 'on' : 'off'})`);
  // warm up live check once at boot
  getSnapshotPayload().then((p) => {
    console.log('feed mode:', p.meta.mode, '—', p.meta.feedLabel);
  });
});
