/**
 * relay-client.test.mjs — browser-side data source resolution.
 *
 *   npm i -D jsdom     # one-time (optional)
 *   node test/relay-client.test.mjs
 *
 * Skips cleanly when jsdom is unavailable. Verifies the rules that decide which
 * live source a dashboard uses on a static host, and that it never accepts an
 * unrelated JSON endpoint, a non-live payload, or loopback servers as saved relays.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

let JSDOM;
try { ({ JSDOM } = await import('jsdom')); }
catch (_) {
  console.log('SKIP relay-client tests: jsdom is not installed (npm i -D jsdom)');
  process.exit(0);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const code = fs.readFileSync(path.join(here, '..', 'bridge', 'nse-relay-client.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra !== undefined ? JSON.stringify(extra) : ''); } };

const HTML_404 = () => new Response('<!DOCTYPE html><title>404</title>', { status: 404, headers: { 'content-type': 'text/html' } });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const PAGES = 'https://sadiqk2.github.io/trading-desks/nse-pulse/';
const health = { mode: 'live', source: 'nseindia.com', nse: true, feeds: { optionsDesk: 'live', nsePulse: 'live' } };
const snapshot = { meta: { mode: 'live', source: 'nseindia.com' }, contracts: [{ id: 'A', ltp: 1 }] };

function env(url, handlers) {
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body><div id="relayPanel"></div></body></html>',
    { url, pretendToBeVisual: true, runScripts: 'dangerously' });
  const { window } = dom;
  const calls = [];
  window.fetch = async (input) => {
    const target = String(input);
    calls.push(target);
    for (const handler of handlers) if (target.startsWith(handler.match)) return handler.reply(target);
    return HTML_404();
  };
  const tag = window.document.createElement('script');
  tag.textContent = code;
  window.document.head.appendChild(tag);
  return { window, calls };
}

console.log('\n1) Static host: same-origin 404, local dashboard server answers');
{
  const { window, calls } = env(PAGES, [
    { match: 'http://localhost:8080/api/health', reply: () => json(health) },
    { match: 'http://localhost:8080/api/snapshot', reply: () => json(snapshot) },
  ]);
  const res = await window.NseRelay.resolve('/api/snapshot', { ports: [8080, 8081] });
  ok('resolves through the local server', res.ok && res.base === 'http://localhost:8080', res.base);
  ok('label identifies it', res.label === 'local server :8080', res.label);
  ok('verified live payload flagged', res.live === true);
  ok('no wasted attempts after a winner', res.tried.length === 0, res.tried);
  ok('loopback servers are not saved to localStorage', window.localStorage.getItem('tradingDesks.relayBase') === null);
  ok('no second data download', !calls.some(c => c.includes('127.0.0.1') && c.includes('/api/snapshot')));
}

console.log('\n2) Saved relay (?relay=) wins and is remembered');
{
  const { window } = env(PAGES + '?relay=my-relay.workers.dev/', [
    { match: 'https://my-relay.workers.dev/api/health', reply: () => json(health) },
    { match: 'https://my-relay.workers.dev/api/snapshot', reply: () => json(snapshot) },
  ]);
  ok('base normalised to https, no trailing slash', window.NseRelay.savedBase() === 'https://my-relay.workers.dev', window.NseRelay.savedBase());
  ok('persisted for next visit', window.localStorage.getItem('tradingDesks.relayBase') === 'https://my-relay.workers.dev');
  const res = await window.NseRelay.resolve('/api/snapshot', { ports: [8080] });
  ok('relay used', res.ok && res.base === 'https://my-relay.workers.dev' && res.live === true, res.base);
}

console.log('\n3) Relay up but NSE blocked: precise error, never "live"');
{
  const { window } = env(PAGES + '?relay=https://relay.example', [
    { match: 'https://relay.example/api/health', reply: () => json({ mode: 'down', nse: false, error: 'NSE rejected the request (HTTP 403)', code: 'BLOCKED' }, 503) },
    { match: 'https://relay.example/api/snapshot', reply: () => json({ mode: 'unavailable', error: 'NSE rejected the request (HTTP 403)', note: 'No live NSE data is available; no local fallback data is used.' }, 502) },
  ]);
  const res = await window.NseRelay.resolve('/api/snapshot', { ports: [] });
  ok('relay answered (not skipped)', res.ok && res.base === 'https://relay.example', res.base);
  ok('marked not live', res.live === false && res.status === 502);
  ok('carries the upstream failure for the UI', /NSE rejected/.test(res.payload.error), res.payload.error);
}

console.log('\n4) A live source anywhere beats a blocked saved relay');
{
  const { window } = env(PAGES + '?relay=https://blocked-relay.example', [
    { match: 'https://blocked-relay.example/api/health', reply: () => json({ mode: 'down', nse: false, error: 'network error reaching nseindia.com' }, 503) },
    { match: 'https://blocked-relay.example/api/snapshot', reply: () => json({ mode: 'unavailable', error: 'network error reaching nseindia.com' }, 502) },
    { match: 'http://localhost:8080/api/health', reply: () => json(health) },
    { match: 'http://localhost:8080/api/snapshot', reply: () => json(snapshot) },
  ]);
  const res = await window.NseRelay.resolve('/api/snapshot', { ports: [8080] });
  ok('live local server selected', res.ok && res.live === true && res.base === 'http://localhost:8080', [res.base, res.live]);
}

console.log('\n5) Relay without /api/health still works on a live payload');
{
  const { window } = env(PAGES + '?relay=https://data-only.example', [
    { match: 'https://data-only.example/api/snapshot', reply: () => json(snapshot) },
  ]);
  const res = await window.NseRelay.resolve('/api/snapshot', { ports: [] });
  ok('accepted on the payload alone', res.ok && res.live === true && res.base === 'https://data-only.example', [res.base, res.live]);
}

console.log('\n6) Unrelated JSON endpoints are rejected');
{
  const { window } = env(PAGES + '?relay=https://not-our-api.example', [
    { match: 'https://not-our-api.example/api/health', reply: () => json({ message: 'Not Found' }, 404) },
    { match: 'https://not-our-api.example/api/snapshot', reply: () => json({ message: 'Not Found' }, 404) },
  ]);
  const res = await window.NseRelay.resolve('/api/snapshot', { ports: [] });
  ok('not accepted as a source', !res.ok && res.payload === undefined, res.error);
}

console.log('\n7) Nothing answers: actionable failure report');
{
  const { window } = env(PAGES, []);
  const res = await window.NseRelay.resolve('/api/snapshot', { ports: [8080, 8081] });
  ok('fails cleanly', !res.ok);
  ok('lists every attempted source', res.tried.length === 5, res.tried.map(t => t.label));
  ok('summary explains the failure', /No live source answered/.test(res.error), res.error);
}

console.log('\n8) Connect panel');
{
  const { window } = env(PAGES, [
    { match: 'https://typed-relay.workers.dev/api/health', reply: () => json(health) },
  ]);
  const panel = window.document.getElementById('relayPanel');
  let connected = null;
  window.NseRelay.mountPanel(panel, { ports: [8080], tried: [{ label: 'same-origin server', base: '', error: 'HTTP 404 · no live NSE API answered here' }], onConnected: base => { connected = base; } });
  ok('panel rendered into the page', !!panel.querySelector('.nser') && !!panel.querySelector('input'));
  ok('attempt report shown', /same-origin server: HTTP 404/.test(panel.querySelector('.nser-status').textContent));
  ok('explains the relay deploy path', /Deploy the Cloudflare Worker/.test(panel.textContent));

  const input = panel.querySelector('input');
  input.value = 'typed-relay.workers.dev';
  window.NseRelay.mountPanel(panel, { ports: [8080], tried: [{ label: 'same-origin server', base: '', error: 'again 404' }] });
  ok('re-mount keeps what the user typed', panel.querySelector('input').value === 'typed-relay.workers.dev');
  ok('re-mount refreshes the attempt report', /again 404/.test(panel.querySelector('.nser-status').textContent));
  ok('one input, not duplicated', panel.querySelectorAll('input').length === 1);

  panel.querySelector('button').dispatchEvent(new window.Event('click'));
  await new Promise(resolve => setTimeout(resolve, 60));
  ok('connect saves the normalised origin', window.localStorage.getItem('tradingDesks.relayBase') === 'https://typed-relay.workers.dev');
  ok('onConnected fires so the dashboards can refresh', connected === 'https://typed-relay.workers.dev');
  ok('status reports the connection', /Connected/.test(panel.querySelector('.nser-status').textContent));
}

console.log('\n9) Base normalisation');
{
  const { window } = env(PAGES, []);
  const normalise = window.NseRelay.normaliseBase;
  ok('bare host → https', normalise('relay.example') === 'https://relay.example');
  ok('localhost → http with port', normalise('localhost:8081') === 'http://localhost:8081');
  ok('127.0.0.1 → http with port', normalise('127.0.0.1:8082') === 'http://127.0.0.1:8082');
  ok('trailing slashes stripped', normalise('https://x.dev///') === 'https://x.dev');
  ok('empty stays empty', normalise('') === '');
  ok('loopback detection', window.NseRelay.isLoopback('http://localhost:8080') && !window.NseRelay.isLoopback('https://relay.example'));
  ok('deploy link exposed', /deploy\.workers\.cloudflare\.com/.test(window.NseRelay.deployUrl));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
