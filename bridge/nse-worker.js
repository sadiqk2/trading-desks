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
import './nse-core.js';

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
