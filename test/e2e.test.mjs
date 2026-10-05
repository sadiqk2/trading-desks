/**
 * e2e.test.mjs — the real dashboards on a static host, fed by the real relay.
 *
 *   npm i -D jsdom     # one-time (optional)
 *   node test/e2e.test.mjs
 *
 * Skips cleanly when jsdom is unavailable. This reproduces the GitHub Pages
 * situation end to end: a static file host (no API) + the generated Worker
 * bundle acting as the relay + a mock NSE. The dashboards' own inline scripts
 * are executed in a browser DOM, so the assertions cover what a user sees:
 * live values with a relay, and an unavailable state — never substitute data —
 * without one.
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

let JSDOM, VirtualConsole;
try { ({ JSDOM, VirtualConsole } = await import('jsdom')); }
catch (_) {
  console.log('SKIP end-to-end tests: jsdom is not installed (npm i -D jsdom)');
  process.exit(0);
}

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const { startMockNse, EXPIRY_MAIN, SPOT } = require('./mock-nse.js');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra !== undefined ? JSON.stringify(extra) : ''); } };
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/* --- static host (repo root, like GitHub Pages) --- */
const staticHost = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://static');
  let rel = url.pathname === '/' ? 'index.html' : url.pathname;
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(repoRoot, rel);
  if (!file.startsWith(repoRoot)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (error, buffer) => {
    if (error) { res.writeHead(404, { 'Content-Type': 'text/html' }); return res.end('<!DOCTYPE html><title>404</title>'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buffer);
  });
});
const staticPort = await new Promise(resolve => staticHost.listen(0, '127.0.0.1', () => resolve(staticHost.address().port)));

/* --- mock NSE + the real Worker bundle as the relay --- */
const nse = await startMockNse();
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => realFetch(String(input).replace('https://www.nseindia.com', nse.url), init);

const bundleSource = fs.readFileSync(path.join(repoRoot, 'bridge', 'nse-worker.bundle.js'), 'utf8');
const bundleFile = path.join(repoRoot, 'test', '.worker-for-e2e.mjs');
fs.writeFileSync(bundleFile, bundleSource);
const worker = (await import(`file://${bundleFile}?v=${Date.now()}`)).default;
fs.unlinkSync(bundleFile);

const relay = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://relay');
  const response = await worker.fetch(new Request(url.href, { method: req.method }), {});
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
});
const relayPort = await new Promise(resolve => relay.listen(0, '127.0.0.1', () => resolve(relay.address().port)));

/* --- a relay that is up but cannot reach NSE --- */
const blockedRelay = http.createServer((req, res) => {
  res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({ mode: 'unavailable', error: 'NSE rejected the request (HTTP 403)', note: 'No live NSE data is available; no local fallback data is used.' }));
});
const blockedPort = await new Promise(resolve => blockedRelay.listen(0, '127.0.0.1', () => resolve(blockedRelay.address().port)));

async function loadPage(url) {
  const html = await (await realFetch(url)).text();
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(String(error.message)));
  const dom = new JSDOM(html, {
    url,
    runScripts: 'dangerously',
    resources: 'usable',       // loads ../bridge/nse-relay-client.js like a browser
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      // jsdom ships no fetch: resolve like a browser and route loopback origins
      // straight to the servers a user's machine would be running.
      window.fetch = (input, init) => realFetch(new URL(String(input), window.location.href).href, init);
      const fakeContext = () => new Proxy({}, {
        get: (target, key) => (key === 'measureText' ? (() => ({ width: 24 })) : key === 'canvas' ? {} : () => {}),
        set: () => true,
      });
      window.HTMLCanvasElement.prototype.getContext = fakeContext;
    },
  });
  return { window: dom.window, errors };
}

console.log('\n1) NSE Pulse on a static host with the relay attached (?relay=)');
{
  const { window, errors } = await loadPage(`http://127.0.0.1:${staticPort}/nse-pulse/?relay=http://127.0.0.1:${relayPort}`);
  await sleep(2500);
  const doc = window.document;
  ok('page runs without script errors', errors.length === 0, errors.slice(0, 2));
  ok('live display active', !doc.body.classList.contains('no-live'), doc.body.className);
  ok('feed reports LIVE · NSE INDIA', /LIVE · NSE INDIA/.test(doc.querySelector('#feedLabel').textContent), doc.querySelector('#feedLabel').textContent);
  ok('footer names the answering source', new RegExp(`via (relay \\S+|local server :${relayPort})`).test(doc.querySelector('#ftFeed').textContent), doc.querySelector('#ftFeed').textContent);
  const rows = doc.querySelectorAll('#tbody tr[data-id]');
  ok('contract rows rendered from live data', rows.length === 2, rows.length);
  ok('turnover KPI populated from source fields', /\d/.test(doc.querySelector('#kPrem').textContent), doc.querySelector('#kPrem').textContent);
  ok('feed label is not an unavailable label', !/UNAVAILABLE/.test(doc.querySelector('#feedLabel').textContent), doc.querySelector('#feedLabel').textContent);
  window.close();
}

console.log('\n2) NIFTY Options Desk on a static host with the relay attached');
{
  const { window, errors } = await loadPage(`http://127.0.0.1:${staticPort}/nifty-options-desk/?relay=http://127.0.0.1:${relayPort}`);
  await sleep(2500);
  const doc = window.document;
  ok('page runs without script errors', errors.length === 0, errors.slice(0, 2));
  ok('spot header shows the live underlying', doc.querySelector('#hSpot').textContent.replace(/,/g, '') === String(SPOT), doc.querySelector('#hSpot').textContent);
  ok('expiry header from the live chain', doc.querySelector('#hExpiry').textContent === EXPIRY_MAIN, doc.querySelector('#hExpiry').textContent);
  ok('market status from the source', /OPEN/.test(doc.querySelector('#hStatus').textContent), doc.querySelector('#hStatus').textContent);
  ok('feed label LIVE', /LIVE · NSE INDIA/.test(doc.querySelector('#feedLbl').textContent));
  ok('chain table rendered', doc.querySelectorAll('#chainBody tr').length > 5, doc.querySelectorAll('#chainBody tr').length);
  ok('unavailable state cleared', !doc.body.classList.contains('no-live'));
  window.close();
}

console.log('\n3) Static host with no relay: unavailable + connect panel, no fabricated values');
{
  const { window, errors } = await loadPage(`http://127.0.0.1:${staticPort}/nse-pulse/`);
  await sleep(4000);
  const doc = window.document;
  ok('no script errors on the unavailable path', errors.length === 0, errors.slice(0, 3));
  ok('body marked no-live', doc.body.classList.contains('no-live'));
  const panel = doc.querySelector('#relayPanel .nser');
  ok('connect panel rendered', !!panel);
  ok('panel explains the relay deploy path', !!panel && /Deploy the Cloudflare Worker/.test(panel.textContent));
  ok('no contract rows fabricated', doc.querySelectorAll('#tbody tr[data-id]').length === 0);
  ok('detail states the real failure', /unavailable|JSON API|nseindia\.com|no live source/i.test(doc.querySelector('#feedUnavailableDetail').textContent), doc.querySelector('#feedUnavailableDetail').textContent.slice(0, 160));
  window.close();
}

console.log('\n4) Relay reachable but NSE blocked: precise error, still no data');
{
  const { window, errors } = await loadPage(`http://127.0.0.1:${staticPort}/nse-pulse/?relay=http://127.0.0.1:${blockedPort}`);
  await sleep(3000);
  const doc = window.document;
  ok('no script errors on the blocked-relay path', errors.length === 0, errors.slice(0, 3));
  ok('unavailable state', doc.body.classList.contains('no-live'));
  ok('upstream failure surfaced verbatim', /NSE rejected the request/.test(doc.querySelector('#feedUnavailableDetail').textContent), doc.querySelector('#feedUnavailableDetail').textContent.slice(0, 160));
  ok('no rows invented', doc.querySelectorAll('#tbody tr[data-id]').length === 0);
  window.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
await nse.close();
staticHost.close();
relay.close();
blockedRelay.close();
process.exit(fail ? 1 : 0);
