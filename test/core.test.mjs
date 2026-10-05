/**
 * core.test.mjs — live-data pipeline tests (no external dependencies).
 *
 *   node test/core.test.mjs
 *
 * Covers: fetch/normalization via bridge/nse-core.js, the /api/* dispatcher,
 * the Cloudflare Worker bundle (routes, CORS, preflight), and the failure modes
 * that must never produce substitute market values (blocked host, HTML bot page,
 * missing option chain, dead session).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const { startMockNse, SPOT, EXPIRY_MAIN } = require('./mock-nse.js');
const live = require('../bridge/nse-live');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra !== undefined ? JSON.stringify(extra) : ''); } };

/** Import the generated Worker bundle from a .mjs copy (works on Node 18+). */
async function importWorkerBundle() {
  const source = fs.readFileSync(path.join(repoRoot, 'bridge', 'nse-worker.bundle.js'), 'utf8');
  const file = path.join(os.tmpdir(), `nse-worker-${process.pid}-${Date.now()}.mjs`);
  fs.writeFileSync(file, source);
  try {
    return (await import(`file://${file}`)).default;
  } finally {
    fs.unlinkSync(file);
  }
}

/* ---------- 1. normalization against a healthy mock ---------- */
console.log('\n1) Desk + Pulse normalization (mock NSE, live-shaped payloads)');
{
  const mock = await startMockNse();
  const restore = mock.install();
  try {
    const desk = await live.getDeskSnapshot();
    ok('spot comes from the source underlying value', desk.spot.ltp === SPOT, desk.spot.ltp);
    ok('change uses the source variation field', desk.spot.chg === -85.4 && desk.spot.chgPct === -0.34, [desk.spot.chg, desk.spot.chgPct]);
    ok('front expiry selected', desk.meta.expiry === EXPIRY_MAIN, desk.meta.expiry);
    ok('next-expiry rows excluded', desk.chain.length === 13, desk.chain.length);
    ok('market status resolved from /api/marketStatus', desk.meta.marketStatus === 'Open', desk.meta.marketStatus);
    ok('VIX + day range carried through', desk.spot.vix === 11.42 && desk.spot.dayHigh === 25260, [desk.spot.vix, desk.spot.dayHigh]);
    ok('options marked live + nseindia source', desk.meta.mode === 'live' && desk.meta.source === 'nseindia.com');
    ok('15m candles aggregated from chart points', desk.spot.candles15m.length > 5 && desk.spot.candles15m[0].v === null);
    ok('leg fields normalized (iv as fraction, prevOi derived)', desk.chain[0].ce.iv === 0.1375 && desk.chain[0].ce.prevOi === desk.chain[0].ce.oi - desk.chain[0].ce.oiChg);

    const pulse = await live.getMostActive();
    ok('most-active rows normalized', pulse.contracts.length === 2, pulse.contracts.length);
    ok('instrument + option type decoded', pulse.contracts[0].instrument === 'IDXOPT' && pulse.contracts[0].optType === 'Call');
    ok('futures row kept with null strike/type', pulse.contracts[1].instrument === 'IDXFUT' && pulse.contracts[1].strike === null);

    const health = await live.health();
    ok('health reports both feeds live', health.mode === 'live' && health.feeds.optionsDesk === 'live' && health.feeds.nsePulse === 'live', health);
  } finally { restore(); await mock.close(); }
}

/* ---------- 2. failure modes never fabricate ---------- */
console.log('\n2) Failure modes report unavailable (no fallback values)');
{
  const blocked = await startMockNse({ mode: 'no-chain' });
  let restore = blocked.install();
  try {
    const chain = await live.handleApi('/api/chain');
    ok('option-chain 500 → 502 with classified error', chain.status === 502 && chain.body.mode === 'unavailable', chain.body.code);
    ok('error names the endpoint that failed', /option-chain/.test(chain.body.error), chain.body.error);
    const health = await live.handleApi('/api/health');
    ok('health degrades to down/partial', health.body.mode !== 'live' && health.body.nse === false, health.body.mode);
    ok('no contracts/snapshot invented', chain.body.chain === undefined && chain.body.contracts === undefined);
  } finally { restore(); await blocked.close(); }

  const v3Only = await startMockNse({ mode: 'v3-only' });
  restore = v3Only.install();
  try {
    const chain = await live.handleApi('/api/chain');
    ok('falls back to the newer option-chain endpoint when the legacy one fails', chain.status === 200 && chain.body.meta.mode === 'live', chain.status);
  } finally { restore(); await v3Only.close(); }

  const html = await startMockNse({ mode: 'html' });
  restore = html.install();
  try {
    const chain = await live.handleApi('/api/chain');
    ok('HTML bot page detected as NOT_JSON', chain.status === 502 && chain.body.code === 'NOT_JSON', chain.body.code);
    ok('error message stays short and actionable', chain.body.error.length < 140 && /HTML page instead of JSON/.test(chain.body.error), chain.body.error);
  } finally { restore(); await html.close(); }

  const timeout = await startMockNse({ mode: 'timeout' });
  restore = timeout.install();
  try {
    const started = Date.now();
    const health = await live.handleApi('/api/health');
    const elapsed = Date.now() - started;
    ok('stalling NSE bounded by the health budget', health.body.mode === 'down' && elapsed < 15000, elapsed);
    ok('timeout classified', health.body.code === 'TIMEOUT', health.body.code);
  } finally { restore(); await timeout.close(); }

  restore = live; // no-op clarity
  const offlineUrl = 'http://127.0.0.1:1';
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => realFetch(String(input).replace('https://www.nseindia.com', offlineUrl), init);
  try {
    const health = await live.health();
    ok('connection refused classified as NETWORK', health.mode === 'down' && health.code === 'NETWORK', health);
  } finally { globalThis.fetch = realFetch; }
}

/* ---------- 3. dispatcher contract ---------- */
console.log('\n3) /api dispatcher contract');
{
  const mock = await startMockNse();
  const restore = mock.install();
  try {
    const unknown = await live.handleApi('/api/nope');
    ok('unknown endpoint → 404', unknown.status === 404 && /unknown endpoint/.test(unknown.body.error));
    const chain = await live.handleApi('/api/chain');
    ok('chain payload has meta/spot/chain', chain.status === 200 && chain.body.meta && chain.body.spot && Array.isArray(chain.body.chain));
    const snap = await live.handleApi('/api/snapshot');
    ok('snapshot payload has meta/contracts', snap.status === 200 && snap.body.meta && Array.isArray(snap.body.contracts));
    const health = await live.handleApi('/api/health');
    ok('health → 200 when live', health.status === 200 && health.body.mode === 'live');
    ok('completed responses are not reused (fresh NSE calls)', mock.hits.chain >= 3, mock.hits.chain);
  } finally { restore(); await mock.close(); }
}

/* ---------- 4. Cloudflare Worker bundle ---------- */
console.log('\n4) Worker relay bundle (real generated file)');
{
  const mock = await startMockNse();
  const restore = mock.install();
  const worker = await importWorkerBundle();
  const call = async (target, init) => {
    const response = await worker.fetch(new Request(`https://relay.example${target}`, init || {}), {});
    const text = await response.text();
    let body = null;
    try { body = JSON.parse(text); } catch (_) {}
    return { response, text, body };
  };

  try {
    const health = await call('/api/health');
    ok('GET /api/health → 200 + CORS *', health.response.status === 200 && health.response.headers.get('access-control-allow-origin') === '*');
    ok('responses are no-store', health.response.headers.get('cache-control') === 'no-store');

    const chain = await call('/api/chain');
    ok('GET /api/chain serves the desk snapshot', chain.response.status === 200 && chain.body.chain.length === 13 && chain.body.meta.mode === 'live');

    const snapshot = await call('/api/snapshot');
    ok('GET /api/snapshot serves most-active rows', snapshot.response.status === 200 && snapshot.body.contracts.length === 2);

    const preflight = await call('/api/chain', { method: 'OPTIONS' });
    ok('OPTIONS preflight allows private networks', preflight.response.status === 204 && preflight.response.headers.get('access-control-allow-private-network') === 'true');

    const landing = await call('/');
    ok('landing page links the dashboards with ?relay=', landing.response.status === 200 && /relay=/.test(landing.text));

    const post = await call('/api/chain', { method: 'POST' });
    ok('non-GET rejected', post.response.status === 405);

    const unknown = await call('/api/nope');
    ok('unknown route → 404 JSON', unknown.response.status === 404 && !!unknown.body.error);
  } finally { restore(); await mock.close(); }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
