/**
 * nse-live.js — live NSE India fetch + normalization shared by both dashboards.
 *
 * This module is deliberately live-only: it has no fixture, cached sample, or
 * synthetic fallback. If NSE cannot be reached or returns incomplete data, the
 * caller receives an error and the dashboards show an unavailable state.
 */
'use strict';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const IST = 'Asia/Kolkata';

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

const istHMS = (date = new Date()) => new Intl.DateTimeFormat('en-GB', {
  timeZone: IST, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
}).format(date);

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

/* ---------- NSE session (cookie-warm + fetch) ---------- */
const jar = new Map();
function cookieHeader() {
  return [...jar.entries()].map(([key, value]) => `${key}=${value}`).join('; ');
}
function storeCookies(response) {
  const cookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  for (const cookie of cookies) {
    const [pair] = cookie.split(';');
    const index = pair.indexOf('=');
    if (index > 0) jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  }
}

async function nseGet(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      Referer: 'https://www.nseindia.com/option-chain',
      'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
      'Cache-Control': 'no-cache',
      Cookie: cookieHeader(),
    },
  });
  storeCookies(response);
  if (response.status === 403) {
    const error = new Error('NSE 403 (Akamai block — datacentre IP?)');
    error.code = 403;
    throw error;
  }
  if (!response.ok) {
    const error = new Error(`NSE HTTP ${response.status}`);
    error.code = response.status;
    throw error;
  }
  return response.json();
}

/* ---------- live NSE fetch ---------- */
async function fetchLiveBundle() {
  // Warm the NSE session before requesting the current market endpoints.
  await nseGet('https://www.nseindia.com/').catch(() => {});
  await nseGet('https://www.nseindia.com/option-chain').catch(() => {});

  const [optionChain, allIndices, chart, mostActive] = await Promise.all([
    nseGet('https://www.nseindia.com/api/option-chain-indices?symbol=NIFTY'),
    nseGet('https://www.nseindia.com/api/allIndices'),
    nseGet('https://www.nseindia.com/api/chart-databyindex?index=NIFTY%2050').catch(() => null),
    (async () => {
      for (const url of [
        'https://www.nseindia.com/api/live-analysis-most-active-contracts?index=volume_contracts',
        'https://www.nseindia.com/api/live-analysis-most-active-contracts?index=most_active_contracts',
        'https://www.nseindia.com/api/live-analysis-most-active-contracts',
      ]) {
        try {
          const data = await nseGet(url);
          if (data && (Array.isArray(data) || Array.isArray(data.data) || Array.isArray(data.data1))) return data;
        } catch (_) {
          // Try the next current NSE endpoint variant; no local data fallback.
        }
      }
      return null;
    })(),
  ]);

  return { optionChain, allIndices, chart, mostActive, source: 'nseindia.com' };
}

let pendingBundle = null;
async function getBundle() {
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
    const candle = buckets.get(bucketTime) || {
      t: bucketTime, o: price, h: price, l: price, c: price, v: null,
    };
    candle.h = Math.max(candle.h, price);
    candle.l = Math.min(candle.l, price);
    candle.c = price;
    buckets.set(bucketTime, candle);
  }
  return [...buckets.values()].sort((a, b) => a.t - b.t);
}

function buildDeskSnapshot(bundle) {
  const optionChain = bundle.optionChain || {};
  const records = optionChain.records || {};
  const indices = bundle.allIndices && Array.isArray(bundle.allIndices.data) ? bundle.allIndices.data : [];
  const nifty = indices.find((item) => item.index === 'NIFTY 50' || item.indexSymbol === 'NIFTY 50') || {};
  const vix = indices.find((item) => /VIX/i.test(String(item.index || item.indexSymbol || ''))) || {};
  const spot = pickNumber(records, ['underlyingValue']) ?? pickNumber(nifty, ['lastPrice', 'last']);
  if (spot === null || spot <= 0) throw new Error('NSE response did not include a valid NIFTY spot price');

  const expiry = pickExpiry(optionChain);
  const expiryMs = expiryTimestamp(expiry);
  if (!expiry || expiryMs === null) throw new Error('NSE response did not include a valid option expiry');

  const expiryISO = new Date(expiryMs).toISOString();
  const remainingMs = Math.max(0, expiryMs - Date.now());
  const timestamp = parseIstStamp(records.timestamp);
  const rawRows = Array.isArray(records.data) ? records.data : [];
  const expiryRows = rawRows.filter((item) => item && item.expiryDate === expiry);
  let incompleteRows = 0;
  const chain = expiryRows
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
  const change = pickNumber(nifty, ['change', 'netChange'])
    ?? (previousClose !== null ? spot - previousClose : null);
  const changePercent = pickNumber(nifty, ['pChange', 'changePercent'])
    ?? (previousClose !== null && previousClose !== 0 && change !== null ? (change / previousClose) * 100 : null);
  const asOf = timestamp === null ? null : new Date(timestamp).toISOString();
  const fetchedAt = new Date().toISOString();
  const hours = Math.floor(remainingMs / 3600000);
  const minutes = Math.floor((remainingMs % 3600000) / 60000);

  return {
    meta: {
      provider: 'nse',
      mode: 'live',
      source: bundle.source,
      asOf,
      fetchedAt,
      ist: timestamp === null ? '—' : `${istHMS(new Date(timestamp))} IST`,
      marketStatus: records.marketStatus || null,
      expiry,
      expiryISO,
      dteDays: remainingMs / 86400000,
      dteText: `${Math.floor(remainingMs / 86400000)}d ${String(hours % 24).padStart(2, '0')}h ${String(minutes).padStart(2, '0')}m`,
      lotSize: pickNumber(records, ['lotSize']),
      sourceChainRows: expiryRows.length,
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
      candles15m: chartToCandles(bundle.chart),
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
  const response = bundle.mostActive;
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
  const records = bundle.optionChain && bundle.optionChain.records;
  return {
    meta: {
      provider: 'nse',
      mode: 'live',
      source: bundle.source,
      asOf: sourceTime === null ? null : new Date(sourceTime).toISOString(),
      fetchedAt: new Date().toISOString(),
      marketStatus: records && records.marketStatus || null,
      sourceRows: rows.length,
      omittedIncompleteRows,
    },
    contracts,
  };
}

module.exports = {
  async getDeskSnapshot() { return buildDeskSnapshot(await getBundle()); },
  async getMostActive() { return buildMostActive(await getBundle()); },
  async health() {
    let bundle;
    try {
      bundle = await getBundle();
    } catch (error) {
      return {
        mode: 'down',
        nse: false,
        error: String(error && error.message || error),
        serverTime: new Date().toISOString(),
        note: 'NSE is unavailable. No cached sample or generated fallback is used.',
      };
    }

    const feeds = { optionsDesk: 'live', nsePulse: 'live' };
    const errors = {};
    try { buildDeskSnapshot(bundle); }
    catch (error) { feeds.optionsDesk = 'unavailable'; errors.optionsDesk = String(error && error.message || error); }
    try { buildMostActive(bundle); }
    catch (error) { feeds.nsePulse = 'unavailable'; errors.nsePulse = String(error && error.message || error); }
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
  },
  // Exposed for focused unit testing of live-data normalization.
  buildDeskSnapshot,
  buildMostActive,
  chartToCandles,
  toLeg,
  pickExpiry,
  normalizeInstrument,
  parseIstStamp,
};
