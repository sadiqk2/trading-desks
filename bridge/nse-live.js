/**
 * nse-live.js — NSE India fetch + normalise (shared module)
 *
 * Pulls the genuine NSE public endpoints used by nseindia.com's own pages and
 * normalises them into the dashboard Snapshot schemas:
 *   • option-chain-indices  → NIFTY Options Desk  (getSnapshot()  → Snapshot)
 *   • live-analysis-most-active-contracts        (getMostActive() → pulse rows)
 *   • allIndices + chart-databyindex             (spot OHLC, VIX, intraday)
 *
 * NSE sits behind Akamai and 403s data-centre IPs — run this from a normal
 * residential/Indian connection.  `NSE_FIXTURE=1` serves the bundled genuine
 * snapshot (25-Sep-2026 10:40 IST) so the whole pipeline can be tested anywhere.
 */
'use strict';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const R = 0.065, LOT = 75;
const IST = 'Asia/Kolkata';

/* ---------- small helpers ---------- */
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
function ncdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}
const npdf = (x) => 0.3989422804014327 * Math.exp(-x * x / 2);
function bsGreeks(S, K, T, r, sig, type) {
  T = Math.max(T, 1 / (365 * 48)); sig = clamp(sig, 0.03, 2.5);
  const st = sig * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + sig * sig / 2) * T) / st;
  const d2 = d1 - st;
  const px = type === 'CE' ? S * ncdf(d1) - K * Math.exp(-r * T) * ncdf(d2) : K * Math.exp(-r * T) * ncdf(-d2) - S * ncdf(-d1);
  const delta = type === 'CE' ? ncdf(d1) : ncdf(d1) - 1;
  const thetaY = -(S * npdf(d1) * sig) / (2 * Math.sqrt(T)) + (type === 'CE' ? -1 : 1) * r * K * Math.exp(-r * T) * ncdf(type === 'CE' ? d2 : -d2);
  return { px: Math.max(px, 0.05), delta, thetaDay: thetaY / 365 };
}
const istHMS = (d = new Date()) => new Intl.DateTimeFormat('en-GB', { timeZone: IST, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(d);
function istDateISO(d = new Date()) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: IST, year: 'numeric', month: '2-digit', day: '2-digit' });
  const o = {}; f.formatToParts(d).forEach(p => { if (p.type !== 'literal') o[p.type] = p.value; });
  return `${o.year}-${o.month}-${o.day}`;
}
function istWeekday(d = new Date()) {
  return new Intl.DateTimeFormat('en-US', { timeZone: IST, weekday: 'short' }).format(d);
}
function parseIstStamp(stamp) {
  // "25-Sep-2026 10:40:50" → epoch ms (assumes IST)
  const m = /^(\d{2})-([A-Za-z]{3})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/.exec(stamp || '');
  if (!m) return Date.now();
  const months = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
  const iso = `${m[3]}-${months[m[2]]}-${m[1]}T${m[4]}:${m[5]}:${m[6]}+05:30`;
  const t = new Date(iso).getTime();
  return isFinite(t) ? t : Date.now();
}
function dteFromLabel(label) {
  const t = parseIstStamp(label + ' 15:30:00');
  return t;
}

/* ---------- NSE session (cookie-warm + fetch) ---------- */
const jar = new Map();
function cookieHeader() { return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; '); }
function storeCookies(res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const c of list) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
}
async function nseGet(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      Referer: 'https://www.nseindia.com/option-chain',
      'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
      'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"Windows"',
      'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'same-origin',
      'Cache-Control': 'no-cache',
      Cookie: cookieHeader(),
    },
  });
  storeCookies(res);
  if (res.status === 403) { const e = new Error('NSE 403 (Akamai block — datacentre IP?)'); e.code = 403; throw e; }
  if (!res.ok) { const e = new Error('NSE HTTP ' + res.status); e.code = res.status; throw e; }
  return res.json();
}

/* ---------- raw fetchers ---------- */
async function fetchRealBundle() {
  // warm session cookies (the standard NSE dance)
  await nseGet('https://www.nseindia.com/').catch(() => {});
  await nseGet('https://www.nseindia.com/option-chain').catch(() => {});
  const [optionChain, allIndices, chart, mostActive] = await Promise.all([
    nseGet('https://www.nseindia.com/api/option-chain-indices?symbol=NIFTY'),
    nseGet('https://www.nseindia.com/api/allIndices'),
    nseGet('https://www.nseindia.com/api/chart-databyindex?index=NIFTY%2050').catch(() => null),
    (async () => {
      for (const u of [
        'https://www.nseindia.com/api/live-analysis-most-active-contracts?index=volume_contracts',
        'https://www.nseindia.com/api/live-analysis-most-active-contracts?index=most_active_contracts',
        'https://www.nseindia.com/api/live-analysis-most-active-contracts',
      ]) {
        try { const j = await nseGet(u); if (j && (j.data || Array.isArray(j))) return j; } catch (e) { /* try next */ }
      }
      return null;
    })(),
  ]);
  return { optionChain, allIndices, chart, mostActive, source: 'nseindia.com' };
}
function loadFixtureBundle() {
  const p = require('path').join(__dirname, 'fixture-nse-bundle.json');
  const j = JSON.parse(require('fs').readFileSync(p, 'utf8'));
  return Promise.resolve({ ...j, source: 'fixture (genuine NSE snapshot 25-Sep-2026 10:40 IST)' });
}

/* ---------- normalisers ---------- */
function pickExpiry(oc, wantExpiry) {
  const dates = (oc.records && oc.records.expiryDates) || [];
  if (wantExpiry && dates.includes(wantExpiry)) return wantExpiry;
  return dates[0] || null;
}

function toLeg(raw, side, S, K, expMs) {
  if (!raw) {
    return { side, ltp: 0.05, prevClose: 0.05, chgPct: 0, volume: 0, oi: 0, oiChg: 0, iv: 0.15,
      bid: 0.05, ask: 0.1, delta: side === 'CE' ? 0.01 : -0.01, thetaDay: -0.01, prevOi: 0, volAvg: 1, dead: true };
  }
  const ltp = Number(raw.lastPrice || 0);
  const chg = Number(raw.change || 0);
  const prevClose = Number(raw.previousClose ?? raw.previousPrice ?? 0) || (ltp - chg) || ltp;
  const iv = Number(raw.impliedVolatility || 0) / 100;
  const T = Math.max(expMs - Date.now(), 36e5) / (365 * 24 * 36e5);   // years to expiry
  const g = bsGreeks(S, K, T, R, iv || 0.15, side);
  const bid = Number(raw.bidprice || 0) || Math.max(0.05, ltp - Math.max(0.05, ltp * 0.02));
  const ask = Number(raw.askPrice || 0) || ltp + Math.max(0.05, ltp * 0.02);
  const oi = Number(raw.openInterest || 0), oiChg = Number(raw.changeinOpenInterest || 0);
  const volume = Number(raw.totalTradedVolume || 0);
  return {
    side, ltp, prevClose: prevClose || ltp,
    chgPct: Number(raw.pChange ?? (prevClose ? (ltp - prevClose) / prevClose * 100 : 0)),
    volume, oi, oiChg, prevOi: oi - oiChg,
    iv: iv || 0.15,
    bid, ask,
    delta: g.delta, thetaDay: g.thetaDay,
    volAvg: Math.max(1, Math.round(volume / 2)),
  };
}

function chartToCandles(chart, spot) {
  // chart-databyindex: { grapthData: [[epochMs, price], ...] }
  const pts = (chart && (chart.grapthData || chart.graphData)) || [];
  if (!Array.isArray(pts) || pts.length < 2) return [];
  const buckets = new Map();
  for (const [t, p] of pts) {
    const k = Math.floor(Number(t) / 9e5) * 9e5;
    const b = buckets.get(k) || { t: k, o: Number(p), h: Number(p), l: Number(p), c: Number(p), v: 0 };
    b.h = Math.max(b.h, Number(p)); b.l = Math.min(b.l, Number(p)); b.c = Number(p);
    b.v += 1200; buckets.set(k, b);
  }
  const out = [...buckets.values()].sort((a, b) => a.t - b.t);
  // nudge final close to the exact spot
  if (out.length && spot) {
    const shift = spot - out[out.length - 1].c;
    out.forEach((c, i) => { const w = i / (out.length - 1 || 1); c.o += shift * w; c.h += shift * w; c.l += shift * w; c.c += shift * w; });
  }
  return out;
}

function marketStatusNow() {
  const mins = (() => { const [h, m] = istHMS().split(':').map(Number); return h * 60 + m; })();
  const wd = istWeekday();
  return (wd === 'Sat' || wd === 'Sun' || mins < 555 || mins >= 930) ? 'CLOSED' : 'OPEN';
}

function buildDeskSnapshot(bundle) {
  const oc = bundle.optionChain || {};
  const rec = oc.records || {};
  const idxList = (bundle.allIndices && bundle.allIndices.data) || [];
  const nifty = idxList.find(x => x.index === 'NIFTY 50' || x.indexSymbol === 'NIFTY 50') || {};
  const vix = idxList.find(x => /VIX/i.test(x.index || '')) || {};
  const S = Number(rec.underlyingValue || nifty.lastPrice || 0);
  const expiry = pickExpiry(oc, bundle.wantExpiry);
  const expMs = dteFromLabel(expiry);
  const expiryISO = new Date(expMs).toISOString();
  const leftMs = Math.max(0, expMs - Date.now());
  const stamp = rec.timestamp || bundle.stamp || (istDateISO() + ' ' + istHMS() + ':00');

  const rows = (rec.data || [])
    .filter(r => r.expiryDate === expiry)
    .map(r => ({ strike: Number(r.strikePrice), CE: r.CE, PE: r.PE || r.pe }))
    .filter(r => isFinite(r.strike))
    .sort((a, b) => a.strike - b.strike);

  const chain = rows.map(r => {
    const row = {
      strike: r.strike,
      ce: toLeg(r.CE, 'CE', S, r.strike, expMs),
      pe: toLeg(r.PE, 'PE', S, r.strike, expMs),
    };
    row.CE = row.ce; row.PE = row.pe;   // alias refs — the engine indexes both cases
    return row;
  });

  const chg = Number(nifty.change ?? (S - Number(nifty.previousClose || S)));
  return {
    meta: {
      provider: 'nse', mode: 'live', source: bundle.source,
      asOf: new Date(parseIstStamp(stamp)).toISOString(),
      ist: istHMS() + ' IST', marketStatus: marketStatusNow(),
      expiry, expiryISO,
      dteDays: leftMs / 864e5,
      dteText: `${Math.floor(leftMs / 864e5)}d ${String(Math.floor((leftMs % 864e5) / 36e5)).padStart(2, '0')}h ${String(Math.floor((leftMs % 36e5) / 6e4)).padStart(2, '0')}m`,
      lotSize: LOT,
    },
    spot: {
      ltp: S,
      chg,
      chgPct: Number(nifty.pChange ?? (nifty.previousClose ? chg / nifty.previousClose * 100 : 0)),
      prevClose: Number(nifty.previousClose || S - chg),
      dayOpen: Number(nifty.open || S), dayHigh: Number(nifty.high || S), dayLow: Number(nifty.low || S),
      candles15m: chartToCandles(bundle.chart, S),
      vix: Number(vix.last || 13.5),
    },
    chain,
  };
}

/* most-active-contracts rows in the shape nse-pulse's mergeRemote() consumes */
function buildMostActive(bundle) {
  const arr = (bundle.mostActive && (bundle.mostActive.data || bundle.mostActive)) || [];
  const pick = (o, keys, d = 0) => { for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== '-') return Number(o[k]) || 0; return d; };
  const rows = [];
  for (const o of (Array.isArray(arr) ? arr : [])) {
    const optType = /PE|PUT/i.test(o.optionType || o.option || '') ? 'Put'
      : /CE|CALL/i.test(o.optionType || o.option || '') ? 'Call' : null;
    if (!o.symbol || !o.lastPrice) continue;
    rows.push({
      id: o.identifier || `${o.symbol}${o.expiryDate}${optType || 'XX'}${o.strikePrice || 0}`,
      instrument: o.instrumentType || o.instrument || (optType ? 'OPTIDX' : 'FUTSTK'),
      symbol: o.symbol,
      expiry: o.expiryDate || o.expiry || '',
      optType,
      strike: pick(o, ['strikePrice', 'strike'], 0),
      ltp: pick(o, ['lastPrice', 'lastTradedPrice', 'ltp'], 0),
      chgPct: pick(o, ['pChange', 'pctChange'], 0),
      volume: pick(o, ['numberOfContractsTraded', 'totalTradedVolume', 'volume'], 0),
      valueLakhs: pick(o, ['totalTurnover', 'turnover', 'value'], 0),
      oi: pick(o, ['openInterest'], 0),
      oiChg: pick(o, ['changeinOpenInterest', 'changeInOpenInterest'], 0),
      underlying: pick(o, ['underlyingValue'], 0),
    });
  }
  return {
    meta: { provider: 'nse', mode: 'live', source: bundle.source, asOf: new Date().toISOString(), ist: istHMS() + ' IST', marketStatus: marketStatusNow() },
    contracts: rows,
  };
}

async function getBundle(opts = {}) {
  if (process.env.NSE_FIXTURE === '1' || opts.fixture) return loadFixtureBundle();
  return fetchRealBundle();
}

module.exports = {
  async getDeskSnapshot(opts = {}) { return buildDeskSnapshot(await getBundle(opts)); },
  async getMostActive(opts = {}) { return buildMostActive(await getBundle(opts)); },
  async health(opts = {}) {
    try {
      const b = await getBundle(opts);
      return {
        mode: 'live', source: b.source, nse: b.source === 'nseindia.com',
        fixture: b.source !== 'nseindia.com',
        serverTime: new Date().toISOString(), note: 'live NSE data ready',
      };
    } catch (e) {
      return { mode: 'down', nse: false, error: String(e.message || e), serverTime: new Date().toISOString(),
        note: 'NSE unreachable from this network — run the bridge on a residential/Indian connection' };
    }
  },
  // exposed for tests
  buildDeskSnapshot, buildMostActive, chartToCandles, toLeg, pickExpiry, bsGreeks,
};
