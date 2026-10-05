/**
 * nse-worker.bundle.js — GENERATED FILE, do not edit.
 * Source: bridge/nse-core.js + bridge/nse-worker.js
 * Rebuild: node bridge/build-worker.js
 *
 * Paste this whole file into a Cloudflare Worker (dashboard → Workers → Create
 * → paste → Deploy), or deploy the repo with the one-click button / wrangler.
 * Live-only: no fixtures, saved snapshots, or generated market values.
 */
/**
 * nse-core.js — shared live-only NSE fetch + normalization core.
 *
 * This one file runs unmodified in three places:
 *   1. Node (the two app servers and the standalone bridge) — via `require('./nse-live.js')`.
 *   2. Cloudflare Workers (or any edge/serverless ESM host) — `import './nse-core.js'`.
 *   3. Any other host with a standards-compliant `fetch`.
 *
 * It attaches its API to `globalThis.NseCore`; it deliberately does not use
 * `require`, `module.exports`, `process`, or Node-only APIs, so the same code
 * path serves NSE data from a laptop and from a hosted relay.
 *
 * Live-only policy: there are no fixtures, sample rows, saved snapshots, or
 * synthetic ticks anywhere in this file. If NSE cannot be reached or returns
 * incomplete data, the caller receives a classified error and the dashboards
 * report the feed as unavailable instead of substituting values.
 */
(function attachNseCore(root) {
  'use strict';

  const NSE_ORIGIN = 'https://www.nseindia.com';
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
  const IST_OFFSET_MS = 19800000; // +05:30, no DST
  const REQUEST_TIMEOUT_MS = 12000;
  const ATTEMPTS_PER_ENDPOINT = 2;

  /* ---------- primitives ---------- */

  const numberOrNull = (value) => {
    if (value === null || value === undefined || value === '' || value === '-') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  };

  function pickNumber(object, keys) {
    for (const key of keys) {
      const value = numberOrNull(object && object[key]);
      if (value !== null) return value;
    }
    return null;
  }

  const pad2 = (value) => String(value).padStart(2, '0');

  // IST clock without depending on Intl/ICU data (edge runtimes vary).
  function istHMS(date = new Date()) {
    const shifted = new Date(date.getTime() + IST_OFFSET_MS);
    return `${pad2(shifted.getUTCHours())}:${pad2(shifted.getUTCMinutes())}:${pad2(shifted.getUTCSeconds())}`;
  }

  function parseIstStamp(stamp) {
    if (typeof stamp !== 'string' || !stamp.trim()) return null;
    const match = /^(\d{2})-([A-Za-z]{3})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/.exec(stamp.trim());
    if (!match) {
      const parsed = Date.parse(stamp);
      return Number.isFinite(parsed) ? parsed : null;
    }
    const months = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
    const iso = `${match[3]}-${months[match[2]]}-${match[1]}T${match[4]}:${match[5]}:${match[6]}+05:30`;
    const parsed = new Date(iso).getTime();
    return Number.isFinite(parsed) ? parsed : null;
  }

  function expiryTimestamp(label) {
    if (typeof label !== 'string' || !label.trim()) return null;
    return parseIstStamp(`${label.trim()} 15:30:00`);
  }

  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  /* ---------- NSE session (cookies are best-effort; the public JSON API
     answers cookieless requests too, which is what makes hosted relays work) ---------- */

  const jar = new Map();
  let cookiesWritable = true;

  function cookieHeader() {
    return [...jar.entries()].map(([key, value]) => `${key}=${value}`).join('; ');
  }

  function storeCookies(response) {
    if (!cookiesWritable || !response || !response.headers) return;
    let cookies = [];
    if (typeof response.headers.getSetCookie === 'function') cookies = response.headers.getSetCookie() || [];
    if (!cookies.length) {
      const single = response.headers.get('set-cookie');
      if (single) cookies = [single];
    }
    if (!cookies.length) {
      // Edge runtimes strip Set-Cookie from fetch responses. That only costs the
      // warm-up optimisation, never the cookieless data path below.
      cookiesWritable = false;
      return;
    }
    for (const cookie of cookies) {
      const [pair] = String(cookie).split(';');
      const index = pair.indexOf('=');
      if (index > 0) jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
    }
  }

  function classifyError(error) {
    const message = String((error && error.message) || error || 'unknown error');
    const status = error && (error.status || error.code);
    if (message === 'NSE_TIMEOUT' || (error && error.name === 'AbortError') || /aborted|timed? ?out/i.test(message)) {
      return { code: 'TIMEOUT', message: `NSE did not respond within ${REQUEST_TIMEOUT_MS / 1000}s` };
    }
    if (status === 403 || status === 401) {
      return { code: 'BLOCKED', status, message: `NSE rejected the request (HTTP ${status}) — this host/IP looks automated to the exchange CDN` };
    }
    if (/fetch failed|network|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket|TLS|SSL|other side closed/i.test(message)) {
      return { code: 'NETWORK', message: `network error reaching nseindia.com (${message})` };
    }
    if (/NOT_JSON/.test(message)) {
      return { code: 'NOT_JSON', message: 'NSE returned an HTML page instead of JSON (bot check or maintenance page)' };
    }
    return { code: (error && error.code) || 'ERROR', message };
  }

  async function nseGet(url, options) {
    const opts = options || {};
    const attempts = opts.attempts || ATTEMPTS_PER_ENDPOINT;
    const timeoutMs = opts.timeoutMs || REQUEST_TIMEOUT_MS;
    const accept = opts.accept || 'application/json, text/plain, */*';
    let lastError = null;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
      try {
        const response = await fetch(url, {
          redirect: 'follow',
          signal: controller ? controller.signal : undefined,
          headers: {
            'User-Agent': UA,
            Accept: accept,
            'Accept-Language': 'en-US,en;q=0.9',
            Referer: `${NSE_ORIGIN}/option-chain`,
            'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin',
            'Cache-Control': 'no-cache',
            Pragma: 'no-cache',
            ...(jar.size ? { Cookie: cookieHeader() } : {}),
          },
        });
        storeCookies(response);
        if (!response.ok) {
          const error = new Error(`NSE HTTP ${response.status}`);
          error.status = response.status;
          error.code = response.status;
          throw error;
        }
        const text = await response.text();
        if (opts.raw === 'text') return text;
        try {
          return JSON.parse(text);
        } catch (_) {
          const error = new Error('NOT_JSON');
          error.code = 'NOT_JSON';
          error.detail = `NSE returned ${String(response.headers.get('content-type') || 'a non-JSON body')} for ${url}`;
          throw error;
        }
      } catch (error) {
        lastError = error;
        const classified = classifyError(error);
        const retryable = classified.code === 'TIMEOUT' || classified.code === 'NETWORK' || /HTTP 5\d\d/.test(classified.message);
        if (attempt < attempts && retryable) await sleep(400 * attempt + Math.floor(Math.random() * 250));
        else break;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    throw lastError || new Error('NSE request failed');
  }

  /* ---------- live NSE endpoints ---------- */

  const OPTION_CHAIN_VARIANTS = [
    `${NSE_ORIGIN}/api/option-chain-indices?symbol=NIFTY`,
    `${NSE_ORIGIN}/api/option-chain-v3?type=Indices&symbol=NIFTY`,
    `${NSE_ORIGIN}/api/option-chain-v3?symbol=NIFTY`,
  ];

  const MOST_ACTIVE_VARIANTS = [
    `${NSE_ORIGIN}/api/live-analysis-most-active-contracts?index=volume_contracts`,
    `${NSE_ORIGIN}/api/live-analysis-most-active-contracts?index=most_active_contracts`,
    `${NSE_ORIGIN}/api/live-analysis-most-active-contracts`,
  ];

  const ALL_INDICES_URL = `${NSE_ORIGIN}/api/allIndices`;
  const MARKET_STATUS_URL = `${NSE_ORIGIN}/api/marketStatus`;
  const CHART_URL = `${NSE_ORIGIN}/api/chart-databyindex?index=NIFTY%2050`;

  function hasOptionChainShape(payload) {
    return !!(payload && payload.records && Array.isArray(payload.records.data) && payload.records.data.length);
  }

  async function warmUpSession() {
    // Only worth doing when the runtime exposes Set-Cookie (Node). Edge
    // runtimes skip this and use the cookieless path directly. Kept short: a
    // stalling host must not turn a dashboard probe into a minute-long wait.
    if (!cookiesWritable) return false;
    const opts = { accept: 'text/html,application/xhtml+xml', attempts: 1, timeoutMs: 6000 };
    await nseGet(`${NSE_ORIGIN}/`, opts).catch(() => null);
    await nseGet(`${NSE_ORIGIN}/option-chain`, opts).catch(() => null);
    return jar.size > 0;
  }

  function shortEndpoint(url) {
    try { return new URL(url).pathname + (url.includes('?') ? url.slice(url.indexOf('?')) : ''); }
    catch (_) { return url; }
  }

  async function tryVariants(urls) {
    const failures = [];
    for (const url of urls) {
      try {
        const payload = await nseGet(url);
        if (payload && typeof payload === 'object') return payload;
        failures.push({ url, code: 'EMPTY', message: 'empty response' });
      } catch (error) {
        const classified = classifyError(error);
        failures.push({ url, code: classified.code, message: classified.message });
        // A blocked client stays blocked for the other variants on this host;
        // only a warm-up can change that.
        if (classified.code === 'BLOCKED' || classified.code === 'NETWORK' || classified.code === 'TIMEOUT') break;
      }
    }

    // Report one short, actionable sentence when every endpoint failed the same
    // way; fall back to a per-endpoint list when the causes differ.
    const sameCode = failures.length > 0 && failures.every((failure) => failure.code === failures[0].code);
    let message = 'NSE returned no usable response';
    if (sameCode && failures[0].code === 'NOT_JSON') {
      message = failures[0].message;
    } else if (sameCode && /^NSE HTTP \d+/.test(failures[0].message)) {
      message = `${shortEndpoint(failures[0].url)} → ${failures[0].message}`; // name the endpoint, drop the host
    } else if (sameCode) {
      message = failures[0].message;
    } else if (failures.length) {
      message = failures.map((failure) => `${shortEndpoint(failure.url)} → ${failure.message}`).join(' · ');
    }
    const error = new Error(message);
    error.code = sameCode ? failures[0].code : 'ENDPOINTS';
    error.details = failures;
    throw error;
  }

  async function fetchOptionChain() {
    try {
      return await tryVariants(OPTION_CHAIN_VARIANTS);
    } catch (firstError) {
      const warmed = await warmUpSession();
      if (!warmed) throw firstError;
      return tryVariants(OPTION_CHAIN_VARIANTS);
    }
  }

  async function fetchMostActiveRaw() {
    for (const url of MOST_ACTIVE_VARIANTS) {
      try {
        const data = await nseGet(url);
        if (data && (Array.isArray(data) || Array.isArray(data.data) || Array.isArray(data.data1))) return data;
      } catch (_) {
        // Try the next live endpoint variant; no local fallback exists.
      }
    }
    return null;
  }

  async function fetchLiveBundle() {
    // The option chain is the only response both dashboards need. Everything
    // else degrades to "unavailable field" instead of taking the feed down.
    const optionChain = await fetchOptionChain();
    const [allIndices, marketStatus, chart, mostActive] = await Promise.all([
      nseGet(ALL_INDICES_URL).catch(() => null),
      nseGet(MARKET_STATUS_URL).catch(() => null),
      nseGet(CHART_URL).catch(() => null),
      fetchMostActiveRaw().catch(() => null),
    ]);
    return { optionChain, allIndices, marketStatus, chart, mostActive, source: 'nseindia.com' };
  }

  let pendingBundle = null;
  async function getBundle() {
    // Concurrent callers may share one in-flight NSE request; a completed
    // response is never reused for the next request.
    if (pendingBundle) return pendingBundle;
    pendingBundle = fetchLiveBundle().finally(() => { pendingBundle = null; });
    return pendingBundle;
  }

  /* ---------- normalizers ---------- */

  function pickExpiry(optionChain) {
    const dates = optionChain && optionChain.records && optionChain.records.expiryDates;
    return Array.isArray(dates) ? dates[0] || null : null;
  }

  function toLeg(raw, side) {
    if (!raw || typeof raw !== 'object') return null;
    const ltp = pickNumber(raw, ['lastPrice', 'lastTradedPrice', 'ltp']);
    if (ltp === null || ltp <= 0) return null;

    const change = pickNumber(raw, ['change', 'netChange']);
    let prevClose = pickNumber(raw, ['previousClose', 'previousPrice', 'prevClose']);
    if (prevClose === null && change !== null) prevClose = ltp - change;
    const chgPct = pickNumber(raw, ['pChange', 'pctChange', 'changePercent'])
      ?? (prevClose !== null && prevClose !== 0 ? ((ltp - prevClose) / prevClose) * 100 : null);
    const impliedVolatility = pickNumber(raw, ['impliedVolatility', 'iv']);
    const oi = pickNumber(raw, ['openInterest', 'oi']);
    const oiChg = pickNumber(raw, ['changeinOpenInterest', 'changeInOpenInterest', 'oiChange']);
    const volume = pickNumber(raw, ['totalTradedVolume', 'numberOfContractsTraded', 'volume']);
    const bid = pickNumber(raw, ['bidprice', 'bidPrice', 'bid']);
    const ask = pickNumber(raw, ['askPrice', 'askprice', 'ask']);
    const delta = pickNumber(raw, ['delta']);
    const thetaDay = pickNumber(raw, ['thetaDay', 'theta']);
    const volAvg = pickNumber(raw, ['volumeAverage', 'averageVolume', 'volAvg']);

    return {
      side,
      ltp,
      prevClose,
      chgPct,
      volume,
      oi,
      oiChg,
      prevOi: oi !== null && oiChg !== null ? oi - oiChg : null,
      iv: impliedVolatility === null ? null : impliedVolatility / 100,
      bid,
      ask,
      delta,
      thetaDay,
      volAvg,
    };
  }

  function chartToCandles(chart) {
    // Aggregate only NSE's observed price points into 15-minute OHLC buckets;
    // the endpoint supplies no volume, so candle volume remains unavailable.
    const points = chart && (chart.grapthData || chart.graphData);
    if (!Array.isArray(points)) return [];
    const buckets = new Map();

    for (const point of points) {
      if (!Array.isArray(point) || point.length < 2) continue;
      const timestamp = numberOrNull(point[0]);
      const price = numberOrNull(point[1]);
      if (timestamp === null || price === null || timestamp <= 0 || price <= 0) continue;

      const bucketTime = Math.floor(timestamp / 900000) * 900000;
      const candle = buckets.get(bucketTime) || { t: bucketTime, o: price, h: price, l: price, c: price, v: null };
      candle.h = Math.max(candle.h, price);
      candle.l = Math.min(candle.l, price);
      candle.c = price;
      buckets.set(bucketTime, candle);
    }
    return [...buckets.values()].sort((a, b) => a.t - b.t);
  }

  function indexEntry(indices, matcher) {
    return indices.find((item) => matcher(String((item && (item.index || item.indexSymbol)) || ''))) || {};
  }

  function marketStatusFrom(marketStatus, fallback) {
    const states = marketStatus && Array.isArray(marketStatus.marketState) ? marketStatus.marketState : [];
    const capital = states.find((state) => /capital market/i.test(String((state && state.market) || '')));
    const value = (capital && capital.marketStatus) || null;
    if (value) return value;
    if (typeof fallback === 'string' && fallback.trim()) return fallback.trim();
    return null;
  }

  function buildDeskSnapshot(bundle) {
    const optionChain = (bundle && bundle.optionChain) || {};
    const records = optionChain.records || {};
    const indices = bundle && bundle.allIndices && Array.isArray(bundle.allIndices.data) ? bundle.allIndices.data : [];
    const nifty = indexEntry(indices, (name) => name === 'NIFTY 50' || name === 'NIFTY');
    const vix = indexEntry(indices, (name) => /VIX/i.test(name));
    const spot = pickNumber(records, ['underlyingValue']) ?? pickNumber(nifty, ['lastPrice', 'last']);
    if (spot === null || spot <= 0) throw new Error('NSE response did not include a valid NIFTY spot price');

    const expiry = pickExpiry(optionChain);
    const expiryMs = expiryTimestamp(expiry);
    if (!expiry || expiryMs === null) throw new Error('NSE response did not include a valid option expiry');

    const expiryISO = new Date(expiryMs).toISOString();
    const remainingMs = Math.max(0, expiryMs - Date.now());
    const timestamp = parseIstStamp(records.timestamp);
    const rawRows = Array.isArray(records.data) ? records.data : [];
    const rowsForExpiry = rawRows.filter((item) => {
      if (!item) return false;
      if (item.expiryDate === expiry) return true;
      // option-chain-v3 groups several expiries into one row.
      return Array.isArray(item.expiryDates) && item.expiryDates.includes(expiry);
    });
    let incompleteRows = 0;
    const chain = rowsForExpiry
      .map((item) => {
        const strike = pickNumber(item, ['strikePrice', 'strike']);
        if (strike === null) { incompleteRows++; return null; }
        const ce = toLeg(item.CE, 'CE');
        const pe = toLeg(item.PE || item.pe, 'PE');
        if (!ce || !pe) { incompleteRows++; return null; }
        return { strike, ce, pe, CE: ce, PE: pe };
      })
      .filter(Boolean)
      .sort((a, b) => a.strike - b.strike);
    if (!chain.length) throw new Error('NSE returned no complete option-chain rows for the current expiry');

    const previousClose = pickNumber(nifty, ['previousClose', 'prevClose']);
    const change = pickNumber(nifty, ['change', 'netChange', 'variation'])
      ?? (previousClose !== null ? spot - previousClose : null);
    const changePercent = pickNumber(nifty, ['pChange', 'percentChange', 'changePercent'])
      ?? (previousClose !== null && previousClose !== 0 && change !== null ? (change / previousClose) * 100 : null);
    const asOf = timestamp === null ? null : new Date(timestamp).toISOString();
    const fetchedAt = new Date().toISOString();
    const hours = Math.floor(remainingMs / 3600000);
    const minutes = Math.floor((remainingMs % 3600000) / 60000);

    return {
      meta: {
        provider: 'nse',
        mode: 'live',
        source: (bundle && bundle.source) || 'nseindia.com',
        asOf,
        fetchedAt,
        ist: timestamp === null ? '—' : `${istHMS(new Date(timestamp))} IST`,
        marketStatus: marketStatusFrom(bundle && bundle.marketStatus, records.marketStatus),
        expiry,
        expiryISO,
        dteDays: remainingMs / 86400000,
        dteText: `${Math.floor(remainingMs / 86400000)}d ${pad2(hours % 24)}h ${pad2(minutes)}m`,
        lotSize: pickNumber(records, ['lotSize']),
        sourceChainRows: rowsForExpiry.length,
        omittedIncompleteRows: incompleteRows,
      },
      spot: {
        ltp: spot,
        chg: change,
        chgPct: changePercent,
        prevClose: previousClose,
        dayOpen: pickNumber(nifty, ['open', 'openPrice']),
        dayHigh: pickNumber(nifty, ['high', 'dayHigh']),
        dayLow: pickNumber(nifty, ['low', 'dayLow']),
        candles15m: chartToCandles(bundle && bundle.chart),
        vix: pickNumber(vix, ['last', 'lastPrice']),
      },
      chain,
    };
  }

  function normalizeInstrument(raw, optType) {
    const value = String(raw || '').toLowerCase().replace(/[^a-z]/g, '');
    if (value.includes('idxopt') || value.includes('optidx') || value.includes('indexoption')) return 'IDXOPT';
    if (value.includes('stkopt') || value.includes('optstk') || value.includes('stockoption')) return 'STKOPT';
    if (value.includes('idxfut') || value.includes('futidx') || value.includes('indexfuture')) return 'IDXFUT';
    if (value.includes('stkfut') || value.includes('futstk') || value.includes('stockfuture')) return 'STKFUT';
    if (optType) return 'OPT';
    if (value.includes('future') || value.includes('fut')) return 'FUT';
    return String(raw || 'UNKNOWN');
  }

  function normalizeOptionType(raw) {
    const value = String(raw || '').toUpperCase();
    if (value === 'CE' || /CALL/.test(value)) return 'Call';
    if (value === 'PE' || /PUT/.test(value)) return 'Put';
    return null;
  }

  function buildMostActive(bundle) {
    const response = bundle && bundle.mostActive;
    const candidates = response ? [response.data, response.data1, response].filter(Array.isArray) : [];
    const rows = candidates.find(candidate => candidate.length > 0) || candidates[0] || [];
    const contracts = [];
    let omittedIncompleteRows = 0;

    for (const row of rows) {
      if (!row || typeof row !== 'object') { omittedIncompleteRows++; continue; }
      const symbol = String(row.symbol || row.underlying || '').trim();
      const optType = normalizeOptionType(row.optionType || row.option);
      const instrument = normalizeInstrument(row.instrumentType || row.instrument, optType);
      const expiry = String(row.expiryDate || row.expiry || '').trim();
      const strike = pickNumber(row, ['strikePrice', 'strike']);
      const ltp = pickNumber(row, ['lastPrice', 'lastTradedPrice', 'ltp']);
      if (!symbol || ltp === null || ltp <= 0) { omittedIncompleteRows++; continue; }

      const identifier = String(row.identifier || '').trim();
      const id = identifier || [instrument, symbol, expiry, optType || '', strike ?? ''].join(':');
      contracts.push({
        id,
        instrument,
        symbol,
        expiry,
        optType,
        strike,
        ltp,
        change: pickNumber(row, ['change', 'netChange']),
        chgPct: pickNumber(row, ['pChange', 'pctChange', 'changePercent']),
        volume: pickNumber(row, ['numberOfContractsTraded', 'totalTradedVolume', 'volume']),
        turnover: pickNumber(row, ['totalTurnover', 'turnover', 'value']),
        oi: pickNumber(row, ['openInterest', 'openInterestContracts', 'oi']),
        oiChg: pickNumber(row, ['changeinOpenInterest', 'changeInOpenInterest', 'oiChange']),
        underlying: pickNumber(row, ['underlyingValue', 'spotPrice']),
      });
    }

    if (!contracts.length) throw new Error('NSE returned no current most-active contracts; no fallback rows are used');
    const sourceTime = parseIstStamp(response && (response.timestamp || response.asOf || response.timeStamp));
    const records = bundle && bundle.optionChain && bundle.optionChain.records;
    return {
      meta: {
        provider: 'nse',
        mode: 'live',
        source: (bundle && bundle.source) || 'nseindia.com',
        asOf: sourceTime === null ? null : new Date(sourceTime).toISOString(),
        fetchedAt: new Date().toISOString(),
        marketStatus: marketStatusFrom(bundle && bundle.marketStatus, records && records.marketStatus),
        sourceRows: rows.length,
        omittedIncompleteRows,
      },
      contracts,
    };
  }

  function unavailableBody(error, feed) {
    const classified = classifyError(error);
    return {
      mode: 'unavailable',
      provider: 'nse',
      feed: feed || null,
      source: 'nseindia.com',
      error: classified.message,
      code: classified.code,
      note: 'No live NSE data is available; no local fallback data is used.',
      hint: classified.code === 'BLOCKED'
        ? 'NSE blocked this host. Run the dashboard server or relay on a different network, or point the page at a relay that can reach NSE.'
        : classified.code === 'NETWORK'
          ? 'This host cannot reach www.nseindia.com. Use a relay or a machine on a network with NSE access.'
          : null,
      serverTime: new Date().toISOString(),
    };
  }

  async function getDeskSnapshot() {
    return buildDeskSnapshot(await getBundle());
  }

  async function getMostActive() {
    return buildMostActive(await getBundle());
  }

  // Health is a probe: bounded so a stalling exchange cannot hang a dashboard's
  // first load. The underlying request keeps running and is shared if the data
  // endpoint is called right after.
  const HEALTH_BUDGET_MS = 10000;
  function withBudget(promise, ms) {
    let timer = null;
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('NSE_TIMEOUT'), { code: 'TIMEOUT' })), ms);
    });
    return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer); });
  }

  async function health() {
    let bundle;
    try {
      bundle = await withBudget(getBundle(), HEALTH_BUDGET_MS);
    } catch (error) {
      const classified = classifyError(error);
      return {
        mode: 'down',
        nse: false,
        error: classified.message,
        code: classified.code,
        serverTime: new Date().toISOString(),
        note: 'NSE is unavailable. No cached sample or generated fallback is used.',
      };
    }

    const feeds = { optionsDesk: 'live', nsePulse: 'live' };
    const errors = {};
    try { buildDeskSnapshot(bundle); }
    catch (error) { feeds.optionsDesk = 'unavailable'; errors.optionsDesk = String((error && error.message) || error); }
    try { buildMostActive(bundle); }
    catch (error) { feeds.nsePulse = 'unavailable'; errors.nsePulse = String((error && error.message) || error); }
    const availableFeeds = Object.values(feeds).filter(status => status === 'live').length;
    const mode = availableFeeds === 2 ? 'live' : availableFeeds === 1 ? 'partial' : 'down';
    return {
      mode,
      source: bundle.source,
      nse: true,
      feeds,
      errors,
      serverTime: new Date().toISOString(),
      note: mode === 'live' ? 'Both live dashboards have usable current NSE responses.'
        : mode === 'partial' ? 'NSE responded, but one dashboard feed is incomplete.'
          : 'NSE responded without a usable dashboard snapshot.',
    };
  }

  /* ---------- host-agnostic API dispatcher ----------
     Every host (Node server, standalone bridge, Cloudflare Worker) maps its
     /api/* routes here so the data path is identical everywhere. */

  async function handleApi(pathname) {
    if (pathname === '/api/health') {
      const body = await health();
      return { status: body.mode === 'live' ? 200 : 503, body };
    }
    if (pathname === '/api/chain') {
      try { return { status: 200, body: await getDeskSnapshot() }; }
      catch (error) { return { status: 502, body: unavailableBody(error, 'optionsDesk') }; }
    }
    if (pathname === '/api/snapshot') {
      try { return { status: 200, body: await getMostActive() }; }
      catch (error) { return { status: 502, body: unavailableBody(error, 'nsePulse') }; }
    }
    return { status: 404, body: { error: 'unknown endpoint — try /api/health, /api/chain, /api/snapshot' } };
  }

  const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Requested-With',
    'Access-Control-Allow-Private-Network': 'true',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store',
  };

  root.NseCore = {
    // data API
    getDeskSnapshot,
    getMostActive,
    health,
    handleApi,
    // exposed for focused unit testing of live-data normalization
    buildDeskSnapshot,
    buildMostActive,
    chartToCandles,
    toLeg,
    pickExpiry,
    normalizeInstrument,
    parseIstStamp,
    // diagnostics
    nseGet,
    warmUpSession,
    NSE_ORIGIN,
    CORS_HEADERS,
    REQUEST_TIMEOUT_MS,
    classifyError,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

/* ---------- worker entry (from bridge/nse-worker.js) ---------- */

/**
 * nse-worker.js — hosted NSE relay for the Trading Desks dashboards.
 *
 * Why this exists: NSE's JSON endpoints send no CORS headers, so a static page
 * (GitHub Pages, or any page that is not served by the Node dashboard server)
 * cannot read them directly. This relay does the server-side fetch and returns
 * the same API shape as the Node servers, so the dashboards work unchanged.
 *
 * It uses bridge/nse-core.js — the same live-only code the Node servers run —
 * so there is exactly one fetch/normalization path. No fixtures, no cached
 * snapshots, no generated ticks.
 *
 * Deploy (one click, no local install):
 *   https://deploy.workers.cloudflare.com/?url=https://github.com/sadiqk2/trading-desks
 * Deploy (wrangler):
 *   npx wrangler deploy
 *
 * Routes: GET /api/health · /api/chain · /api/snapshot · / (setup page)
 */

const core = globalThis.NseCore;
const DASHBOARD_BASE_FALLBACK = 'https://sadiqk2.github.io/trading-desks';

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  ...core.CORS_HEADERS,
};

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function dashboardBase(request, env, url) {
  const override = url.searchParams.get('base');
  if (override && /^https?:\/\//.test(override)) return override.replace(/\/+$/, '');
  if (env && env.DASHBOARD_BASE) return String(env.DASHBOARD_BASE).replace(/\/+$/, '');
  return DASHBOARD_BASE_FALLBACK;
}

function landing(request, env, url) {
  const origin = url.origin;
  const base = dashboardBase(request, env, url);
  const desk = `${base}/nifty-options-desk/?relay=${encodeURIComponent(origin)}`;
  const pulse = `${base}/nse-pulse/?relay=${encodeURIComponent(origin)}`;
  const localDesk = `http://localhost:8081/?relay=${encodeURIComponent(origin)}`;
  const localPulse = `http://localhost:8080/?relay=${encodeURIComponent(origin)}`;

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>NSE live relay</title>
<style>
  :root{--bg:#0b0e11;--panel:#151a21;--line:#2a313a;--txt:#eaecef;--muted:#848e9c;--acc:#d8b24b;--up:#0ecb81}
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:Inter,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:var(--bg);color:var(--txt);
       min-height:100vh;display:flex;align-items:center;justify-content:center;padding:32px 18px}
  main{width:100%;max-width:760px;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:26px}
  h1{font-size:19px;letter-spacing:.06em;margin-bottom:6px}
  h1 span{color:var(--acc)}
  p{color:var(--muted);font-size:13px;line-height:1.6;margin:10px 0}
  code,kbd{font-family:"Roboto Mono",ui-monospace,Menlo,monospace;font-size:12px;color:var(--txt);background:#0f141a;border:1px solid var(--line);border-radius:4px;padding:2px 6px}
  .links{display:grid;gap:10px;margin:18px 0}
  a.card{display:block;text-decoration:none;color:var(--txt);border:1px solid var(--line);border-radius:8px;padding:14px 16px;background:#111721}
  a.card:hover{border-color:var(--acc)}
  a.card b{display:block;font-size:13.5px;margin-bottom:3px}
  a.card small{color:var(--muted);font-size:11.5px;font-family:"Roboto Mono",ui-monospace,Menlo,monospace;word-break:break-all}
  .ok{color:var(--up);font-weight:700}
  ul{color:var(--muted);font-size:12.5px;line-height:1.7;margin:8px 0 0 18px}
</style></head>
<body><main>
  <h1>NSE LIVE <span>RELAY</span></h1>
  <p>This relay fetches current data from <code>nseindia.com</code> server-side and returns it with CORS enabled,
  so static dashboards can display live NSE data. Responses are live-only: nothing is cached, saved, or generated.</p>
  <p>Relay origin: <code>${escapeHtml(origin)}</code> · endpoints
  <code>/api/chain</code> <code>/api/snapshot</code> <code>/api/health</code></p>
  <p id="relayStatus">Checking whether this relay can reach NSE…</p>
  <div class="links">
    <a class="card" href="${escapeHtml(desk)}"><b>Open NIFTY Options Desk →</b><small>${escapeHtml(desk)}</small></a>
    <a class="card" href="${escapeHtml(pulse)}"><b>Open NSE Pulse →</b><small>${escapeHtml(pulse)}</small></a>
  </div>
  <p><b class="ok">Those links already point the dashboards at this relay</b> (via <code>?relay=</code>). You can also
  paste this origin into the “Connect live data” box on either dashboard — it is remembered for next time.</p>
  <ul>
    <li>Running the Node server instead? <kbd>node nse-pulse/server.js</kbd> or <kbd>node nifty-options-desk/server.js</kbd> —
        the page prefers a local server automatically when one answers on this machine.</li>
    <li>Worker-local links: <a href="${escapeHtml(localDesk)}">desk on localhost:8081</a> ·
        <a href="${escapeHtml(localPulse)}">pulse on localhost:8080</a></li>
    <li>Add <code>?base=…</code> to this page URL to point the links at a different dashboard deployment.</li>
  </ul>
</main>
<script>
/* Show this relay's real status: whether NSE is reachable from this host. */
(function () {
  var el = document.getElementById('relayStatus');
  function line(label, value, tone) {
    el.textContent = '';
    var label_ = document.createElement('b');
    label_.className = tone || '';
    label_.textContent = label;
    el.appendChild(label_);
    if (value) el.appendChild(document.createTextNode(' — ' + value));
  }
  fetch('/api/health', { cache: 'no-store' })
    .then(function (response) { return response.json(); })
    .then(function (health) {
      if (health && health.mode === 'live') {
        line('Relay status: LIVE', 'NSE reachable from this host (' + (health.source || 'nseindia.com') + ').', 'ok');
      } else if (health && health.mode === 'partial') {
        line('Relay status: PARTIAL', 'NSE answered, but one feed is incomplete: ' + JSON.stringify(health.errors || {}), '');
      } else {
        line('Relay status: UNAVAILABLE', ((health && (health.error || health.note)) || 'no usable NSE response') +
          ' — if the request was blocked, NSE is refusing this relay host. In that case run node nse-pulse/server.js on a machine NSE accepts, or deploy this bridge elsewhere.', '');
      }
    })
    .catch(function (error) { line('Relay status: no health response', String(error && error.message || error), ''); });
})();
</script>
</body></html>`;

  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: core.CORS_HEADERS });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return json(405, { error: 'method not allowed' });
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      return landing(request, env, url);
    }

    if (url.pathname.startsWith('/api/')) {
      try {
        const { status, body } = await core.handleApi(url.pathname);
        return json(status, body);
      } catch (error) {
        return json(502, {
          mode: 'unavailable',
          error: String((error && error.message) || error),
          note: 'No live NSE data is available; no local fallback data is used.',
        });
      }
    }

    return json(404, { error: 'unknown path — try / , /api/health, /api/chain, /api/snapshot' });
  },
};
