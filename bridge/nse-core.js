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
    // Callers re-inspect errors from lower layers; keep the message from being
    // wrapped twice (e.g. "network error reaching nseindia.com (network error …)").
    if (/^(network error reaching nseindia\.com|NSE did not respond|NSE returned an HTML page|NSE rejected the request|NSE HTTP \d)/.test(message)) {
      return { code: (error && error.code) || 'ERROR', message };
    }
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
