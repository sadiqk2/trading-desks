/**
 * mock-nse.js — an in-process stand-in for the NSE endpoints, used by the tests
 * ONLY. The payloads below are synthetic and exist purely so the fetch and
 * normalization paths can be exercised without network access.
 *
 * They are never imported by the servers, the relay, or the dashboards; nothing
 * here can become a fallback data source (the dashboards only ever read a live
 * response fetched from nseindia.com, or reject the feed).
 */
'use strict';

const http = require('http');

const EXPIRY_MAIN = '09-Oct-2026';
const EXPIRY_NEXT = '16-Oct-2026';
const SPOT = 25100.55;
const PREV_CLOSE = 25185.95;

function optionLeg(side, strike, expiry, ltp) {
  return {
    strikePrice: strike,
    expiryDate: expiry,
    underlying: 'NIFTY',
    identifier: `OPTIDXNIFTY${expiry}${side}${strike.toFixed(2)}`,
    openInterest: 100000 + strike,
    changeinOpenInterest: 500 + (strike % 7),
    pchangeinOpenInterest: 1.2,
    totalTradedVolume: 5000 + (strike % 11),
    impliedVolatility: 13.75,
    lastPrice: ltp,
    change: 4.5,
    pChange: 3.1,
    bidprice: ltp - 0.2,
    askPrice: ltp + 0.2,
    bidQty: 300,
    askQty: 400,
    underlyingValue: SPOT,
    volumeAverage: 6000,
  };
}

function optionChainRows(spread) {
  const rows = [];
  for (let k = -spread; k <= spread; k++) {
    const strike = 25000 + k * 50;
    rows.push({
      strikePrice: strike,
      expiryDate: EXPIRY_MAIN,
      CE: optionLeg('CE', strike, EXPIRY_MAIN, 100 - k),
      PE: optionLeg('PE', strike, EXPIRY_MAIN, 100 + k),
    });
  }
  // A row for the next expiry: the normalizers must ignore it for the front expiry.
  rows.push({
    strikePrice: 25100,
    expiryDate: EXPIRY_NEXT,
    CE: optionLeg('CE', 25100, EXPIRY_NEXT, 200),
    PE: optionLeg('PE', 25100, EXPIRY_NEXT, 210),
  });
  return rows;
}

function mostActiveRows() {
  return [
    {
      symbol: 'NIFTY', identifier: 'OPTIDXNIFTY09-10-2026CE25100.00', optionType: 'CE', instrumentType: 'IDXOPT',
      expiryDate: EXPIRY_MAIN, strikePrice: 25100, lastPrice: 101.35, change: 5.15, pChange: 5.35,
      openInterest: 123456, changeinOpenInterest: 4567, totalTradedVolume: 98765,
      totalTurnover: 987654321, underlyingValue: SPOT,
    },
    {
      symbol: 'BANKNIFTY', identifier: 'FUTIDXBN-SYNTH', instrumentType: 'IDXFUT', expiryDate: '29-Oct-2026',
      lastPrice: 56100, change: -120.5, pChange: -0.21, openInterest: 50000,
      changeinOpenInterest: -900, totalTradedVolume: 40000, totalTurnover: 2.2e9, underlyingValue: 56000,
    },
  ];
}

/**
 * Start the mock NSE. mode:
 *   'ok'       — every endpoint answers (default)
 *   'no-chain' — every option-chain variant 500s (feed must report unavailable)
 *   'v3-only'  — only the newer option-chain-v3 endpoint answers
 *   'html'     — API endpoints answer with an HTML bot page
 *   'timeout'  — API endpoints never answer (also sets `silent` for client tests)
 */
async function startMockNse(options) {
  const opts = options || {};
  const mode = opts.mode || 'ok';
  const hits = { chain: 0, total: 0 };

  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://mock').pathname;
    hits.total++;

    if (mode === 'timeout') return; // hang: no response, no close
    if (mode === 'html' && pathname.startsWith('/api/')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<!DOCTYPE html><title>Blocked</title>');
    }
    const isChainEndpoint = pathname === '/api/option-chain-indices' || pathname === '/api/option-chain-v3';
    if (mode === 'no-chain' && isChainEndpoint) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end('{"error":"boom"}');
    }
    if (mode === 'v3-only' && pathname === '/api/option-chain-indices') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end('{"error":"legacy endpoint retired"}');
    }

    const json = (body) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': ['nsit=synthetic; Path=/', 'nseappid=synthetic; Path=/'] });
      return res.end('<html>mock home</html>');
    }
    if (pathname === '/option-chain') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<html>mock option chain</html>');
    }
    if (pathname === '/api/option-chain-indices' || pathname === '/api/option-chain-v3') {
      hits.chain++;
      return json({
        records: {
          expiryDates: [EXPIRY_MAIN, EXPIRY_NEXT],
          data: optionChainRows(opts.spread === undefined ? 6 : opts.spread),
          timestamp: '05-Oct-2026 12:34:56',
          underlyingValue: SPOT,
          lotSize: 75,
        },
      });
    }
    if (pathname === '/api/allIndices') {
      return json({
        data: [
          { index: 'NIFTY 50', indexSymbol: 'NIFTY 50', last: SPOT, variation: -85.4, percentChange: -0.34, open: 25185, high: 25260, low: 25010, previousClose: PREV_CLOSE },
          { index: 'INDIA VIX', indexSymbol: 'INDIA VIX', last: 11.42, variation: 0.2, percentChange: 1.8, previousClose: 11.22 },
        ],
      });
    }
    if (pathname === '/api/marketStatus') {
      return json({ marketState: [{ market: 'Capital Market', marketStatus: 'Open', tradeDate: '05-Oct-2026 12:34' }] });
    }
    if (pathname === '/api/chart-databyindex') {
      return json({ grapthData: Array.from({ length: 40 }, (_, i) => [1759650000000 + i * 900000, 25000 + Math.sin(i / 5) * 40]) });
    }
    if (pathname === '/api/live-analysis-most-active-contracts') {
      return json({ timestamp: '05-Oct-2026 12:34:56', data: mostActiveRows() });
    }
    res.writeHead(404, { 'Content-Type': 'text/html' });
    res.end('not found');
  });

  const port = await new Promise((resolve) => {
    server.listen(opts.port || 0, '127.0.0.1', () => resolve(server.address().port));
  });

  return {
    port,
    hits,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
    /** Route NSE URLs at this mock by patching globalThis.fetch. */
    install(onRestore) {
      const real = globalThis.fetch;
      globalThis.fetch = (input, init) => real(String(input).replace('https://www.nseindia.com', this.url), init);
      if (onRestore) onRestore(() => { globalThis.fetch = real; });
      return () => { globalThis.fetch = real; };
    },
  };
}

module.exports = { startMockNse, optionChainRows, mostActiveRows, EXPIRY_MAIN, EXPIRY_NEXT, SPOT, PREV_CLOSE };
