/**
 * nse-relay-client.js — browser-side live data source resolver for both dashboards.
 *
 * The dashboards used to call `/api/...` on their own origin only. That works
 * when the Node server serves the page, but NSE sends no CORS headers, so a
 * purely static deployment (GitHub Pages) can never read NSE directly.
 *
 * This client resolves, in order:
 *   1. the same-origin server API (unchanged local workflow),
 *   2. a saved relay — `?relay=<url>` / `?api=<url>` in the page URL, or the
 *      last relay the user connected (localStorage),
 *   3. a dashboard server on this machine (http://localhost:8081 / :8080).
 *
 * A relay is any host exposing /api/health, /api/chain, /api/snapshot — the
 * Cloudflare Worker in bridge/nse-worker.js, the standalone bridge, another
 * Node server, or a reverse proxy. No fixtures or fabricated values are used:
 * if nothing answers, the page reports unavailable and offers the connect box.
 *
 * Public API (window.NseRelay):
 *   resolve(path, opts)      → { ok, base, label, status, payload, health, tried }
 *   probe(base, timeoutMs)   → { ok, status, health, error }
 *   remember(base) / forget() / savedBase()
 *   candidates(ports)        → ordered [{ base, label }]
 *   describe(base) / prettifyTried(tried) / deployUrl
 *   mountPanel(el, opts)     → renders the connect box (opts.onConnected called on success)
 */
(function () {
  'use strict';

  var STORE_KEY = 'tradingDesks.relayBase';
  var DEPLOY_URL = 'https://deploy.workers.cloudflare.com/?url=https://github.com/sadiqk2/trading-desks';
  var PROBE_TIMEOUT_MS = 7000;
  var active = null; // { base, label } — the source that last answered

  function readQueryBase() {
    try {
      var params = new URLSearchParams(window.location.search);
      var raw = params.get('relay') || params.get('api');
      var base = normaliseBase(raw);
      if (base) { remember(base); return base; }
    } catch (_) { /* URLSearchParams unavailable: ignore */ }
    return '';
  }

  function normaliseBase(value) {
    if (value === null || value === undefined) return '';
    var base = String(value).trim().replace(/\/+$/, '');
    if (!base) return '';
    if (!/^https?:\/\//i.test(base)) {
      var loopback = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(base);
      base = (loopback ? 'http://' : 'https://') + base;
    }
    return base;
  }

  function describe(base) {
    if (!base) return 'same-origin server';
    try {
      var url = new URL(base);
      if (/^(localhost|127\.0\.0\.1|\[::1\])$/i.test(url.hostname)) return 'local server' + (url.port ? ' :' + url.port : '');
      return 'relay ' + url.host;
    } catch (_) { return base; }
  }

  function storedBase() {
    try { return normaliseBase(window.localStorage.getItem(STORE_KEY)); } catch (_) { return ''; }
  }

  function savedBase() { return readQueryBase() || storedBase(); }

  function remember(base) {
    var clean = normaliseBase(base);
    try {
      if (clean) window.localStorage.setItem(STORE_KEY, clean);
      else window.localStorage.removeItem(STORE_KEY);
    } catch (_) { /* private mode: keep it in memory only */ }
    active = clean ? { base: clean, label: describe(clean) } : { base: '', label: describe('') };
    return clean;
  }

  function forget() {
    try { window.localStorage.removeItem(STORE_KEY); } catch (_) {}
    active = null;
  }

  function candidates(ports) {
    var list = [];
    var seen = {};
    function push(base, label) {
      var key = base || 'same-origin';
      if (seen[key]) return;
      seen[key] = true;
      list.push({ base: base, label: label });
    }
    push('', 'same-origin server');
    var stored = savedBase();
    if (stored) push(stored, describe(stored));
    (ports || []).forEach(function (port) {
      push('http://localhost:' + port, 'local server :' + port);
      push('http://127.0.0.1:' + port, 'local server :' + port);
    });
    return list;
  }

  async function probe(base, timeoutMs) {
    var limit = timeoutMs || PROBE_TIMEOUT_MS;
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, limit) : null;
    var started = Date.now();
    try {
      var response = await fetch(base + '/api/health', {
        cache: 'no-store',
        signal: controller ? controller.signal : undefined,
      });
      var text = await response.text();
      var body = null;
      try { body = JSON.parse(text); } catch (_) {}
      var looksLikeFeed = body && typeof body === 'object'
        && (typeof body.mode === 'string' || body.nse !== undefined || body.feeds !== undefined);
      if (!looksLikeFeed) {
        return { ok: false, error: 'HTTP ' + response.status + ' · no live NSE API answered here' };
      }
      return { ok: true, status: response.status, health: body, ms: Date.now() - started, base: base, label: describe(base) };
    } catch (error) {
      var message = String((error && error.message) || error);
      return {
        ok: false,
        error: (error && error.name === 'AbortError')
          ? 'no reply within ' + Math.round(limit / 1000) + 's'
          : message,
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function isLoopback(base) {
    return /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(base);
  }

  function probeTimeout(base, requested) {
    if (requested) return requested;
    // A dashboard server either answers on this machine immediately or is not
    // running: short timeout, so a dead candidate cannot stall the first load.
    return isLoopback(base) ? 2500 : PROBE_TIMEOUT_MS;
  }

  async function fetchDataset(base, path) {
    try {
      var response = await fetch(base + path, { cache: 'no-store' });
      var text = await response.text();
      var payload = null;
      try { payload = JSON.parse(text); } catch (_) {}
      if (!payload || typeof payload !== 'object') {
        return { error: 'HTTP ' + response.status + ' · response was not JSON' };
      }
      return { status: response.status, payload: payload };
    } catch (error) {
      return { error: String((error && error.message) || error) };
    }
  }

  function isLivePayload(payload) {
    return !!(payload && payload.meta && payload.meta.mode === 'live' && payload.meta.source === 'nseindia.com');
  }

  function accept(candidate, outcome, probeResult, tried, live) {
    // Only remote relays are worth remembering: a loopback dashboard server is
    // found automatically and must not become a stale saved source.
    if (candidate.base && !isLoopback(candidate.base)) remember(candidate.base);
    else active = { base: candidate.base, label: candidate.label };
    return {
      ok: true,
      base: candidate.base,
      label: candidate.label,
      status: outcome.status,
      payload: outcome.payload,
      live: !!live,
      health: probeResult && probeResult.ok ? probeResult.health : null,
      tried: tried,
    };
  }

  async function resolve(path, opts) {
    var options = opts || {};

    // Build the candidate list first: reading a `?relay=`/saved base sets
    // `active` as a side effect, and the priority order below must not depend on
    // when that happens (that bug silently dropped the saved relay on first load).
    var list = candidates(options.ports);
    var order = [];
    if (active) order.push(active);
    list.forEach(function (candidate) {
      if (!active || candidate.base !== active.base) order.push(candidate);
    });

    // Probe all candidates in parallel (worst case = one timeout), then walk them
    // in priority order. Candidates that pass the health check come first; the
    // rest are still tried — a relay may implement /api/chain without /api/health.
    var probed = await Promise.all(order.map(function (candidate) {
      return probe(candidate.base, probeTimeout(candidate.base, options.timeoutMs))
        .then(function (result) { return { candidate: candidate, result: result }; });
    }));
    var ranked = probed.filter(function (entry) { return entry.result.ok; })
      .concat(probed.filter(function (entry) { return !entry.result.ok; }));

    var tried = [];
    var liveHit = null;      // first candidate serving a verified live payload
    var answeredHit = null;  // first candidate answering with our API shape (may report unavailable)
    var reachableError = null;

    for (var i = 0; i < ranked.length; i++) {
      var candidate = ranked[i].candidate;
      var probeResult = ranked[i].result;
      var outcome = await fetchDataset(candidate.base, path);

      if (outcome.error) {
        tried.push({ label: candidate.label, base: candidate.base, error: outcome.error });
        if (probeResult.ok && !reachableError) {
          reachableError = { label: candidate.label, health: probeResult.health, error: outcome.error };
        }
        if (!probeResult.ok && !answeredHit) { /* keep looking; this host is not our API */ }
        continue;
      }

      var live = isLivePayload(outcome.payload);
      // A host that did not pass the health check is trusted only when it serves
      // a verified live payload; an unrelated JSON endpoint never counts.
      var shapedLikeApi = probeResult.ok && outcome.payload && typeof outcome.payload === 'object'
        && (outcome.payload.meta !== undefined || Array.isArray(outcome.payload.contracts)
          || typeof outcome.payload.mode === 'string' || typeof outcome.payload.error === 'string');

      if (live && !liveHit) {
        liveHit = { candidate: candidate, probeResult: probeResult, outcome: outcome };
        break; // ranked order is priority order: the first live payload wins
      }
      if (shapedLikeApi && !answeredHit) answeredHit = { candidate: candidate, probeResult: probeResult, outcome: outcome };
    }

    var winner = liveHit || answeredHit;
    if (winner) return accept(winner.candidate, winner.outcome, winner.probeResult, tried, !!liveHit);

    var summary = '';
    if (reachableError) {
      var reason = (reachableError.health && (reachableError.health.error || reachableError.health.note)) || reachableError.error;
      summary = 'Live source reachable (' + reachableError.label + '), but NSE data is unavailable: ' + reason;
    } else if (tried.length) {
      summary = 'No live source answered · ' + tried[0].label + ': ' + tried[0].error;
    } else {
      summary = 'No live data source is configured for this page.';
    }

    return { ok: false, tried: tried, path: path, error: summary, reachable: reachableError ? reachableError.label : null };
  }

  function prettifyTried(tried) {
    if (!tried || !tried.length) return [];
    return tried.map(function (item) { return item.label + ': ' + item.error; });
  }

  function ensureStyle() {
    if (document.getElementById('nser-style')) return;
    var style = document.createElement('style');
    style.id = 'nser-style';
    style.textContent = [
      '.nser{margin-top:14px;border-top:1px solid var(--line,rgba(132,142,156,.28));padding-top:12px}',
      '.nser-h{font-size:12px;font-weight:800;letter-spacing:.08em;color:var(--txt,#eaecef);text-transform:uppercase}',
      '.nser-p{font-size:12px;line-height:1.65;color:var(--muted,#848e9c);margin:8px 0 10px}',
      '.nser-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}',
      '.nser input{flex:1 1 260px;min-width:190px;background:#0f141a;border:1px solid var(--line,rgba(132,142,156,.35));border-radius:6px;color:var(--txt,#eaecef);font:12px/1.4 "Roboto Mono",ui-monospace,Menlo,monospace;padding:8px 10px}',
      '.nser button{background:linear-gradient(135deg,#d8b24b,#b9902f);border:0;border-radius:6px;color:#191306;font-size:11.5px;font-weight:800;letter-spacing:.06em;padding:9px 14px;cursor:pointer}',
      '.nser button:disabled{opacity:.6;cursor:default}',
      '.nser a{color:#d8b24b;font-size:11.5px;text-decoration:none;border-bottom:1px dotted rgba(216,178,75,.5)}',
      '.nser-status{font-size:11.5px;line-height:1.6;color:var(--muted,#848e9c);margin-top:10px;white-space:pre-wrap}',
      '.nser-status b{color:var(--txt,#eaecef)}',
      '.nser code{font-family:"Roboto Mono",ui-monospace,Menlo,monospace;font-size:11px;background:#0f141a;border:1px solid var(--line,rgba(132,142,156,.3));border-radius:4px;padding:1px 5px;color:var(--txt,#eaecef)}',
    ].join('\n');
    document.head.appendChild(style);
  }

  function paintStatus(statusEl, options) {
    if (!statusEl) return;
    var lines = prettifyTried(options.tried);
    var headline = options.headline || (lines.length ? 'Attempted sources' : '');
    statusEl.textContent = '';
    if (headline) {
      var bold = document.createElement('b');
      bold.textContent = headline;
      statusEl.appendChild(bold);
    }
    lines.forEach(function (line) {
      statusEl.appendChild(document.createTextNode('\n· ' + line));
    });
  }

  function mountPanel(container, opts) {
    if (!container) return;
    var options = opts || {};
    ensureStyle();

    // Re-mounting happens on every failed refresh: keep the user's typing and
    // only refresh the attempt report.
    var mounted = container.querySelector('.nser');
    if (mounted) {
      paintStatus(mounted.querySelector('.nser-status'), options);
      return;
    }

    container.innerHTML = '';

    var wrap = document.createElement('div');
    wrap.className = 'nser';

    var heading = document.createElement('div');
    heading.className = 'nser-h';
    heading.textContent = 'Connect a live NSE source';
    wrap.appendChild(heading);

    var copy = document.createElement('p');
    copy.className = 'nser-p';
    copy.innerHTML = 'NSE sends no CORS headers, so this page cannot read the exchange directly — it needs a '
      + '<b>relay</b> or a local server that can reach <code>nseindia.com</code>. '
      + 'Anything you enter here is stored in this browser only; no market values are cached or invented. '
      + 'One-click relay: <a href="' + DEPLOY_URL + '" target="_blank" rel="noopener">Deploy the Cloudflare Worker</a> '
      + '(free, no local install) and paste the <code>…workers.dev</code> origin below. '
      + 'Running <code>node nifty-options-desk/server.js</code> or <code>node nse-pulse/server.js</code> locally is detected automatically.';
    wrap.appendChild(copy);

    var row = document.createElement('div');
    row.className = 'nser-row';

    var input = document.createElement('input');
    input.type = 'text';
    input.spellcheck = false;
    input.placeholder = 'https://nse-live-relay.<you>.workers.dev   or   http://localhost:8081';
    input.value = storedBase();
    input.setAttribute('aria-label', 'Relay or server origin');

    var button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'CONNECT';

    var clear = document.createElement('a');
    clear.href = '#';
    clear.textContent = 'forget saved source';
    clear.style.display = storedBase() ? '' : 'none';

    row.appendChild(input);
    row.appendChild(button);
    row.appendChild(clear);
    wrap.appendChild(row);

    var status = document.createElement('div');
    status.className = 'nser-status';
    wrap.appendChild(status);
    container.appendChild(wrap);

    function setStatus(headline, lines) {
      status.textContent = '';
      if (headline) {
        var bold = document.createElement('b');
        bold.textContent = headline;
        status.appendChild(bold);
      }
      (lines || []).forEach(function (line) { status.appendChild(document.createTextNode('\n· ' + line)); });
    }

    paintStatus(status, options);

    clear.addEventListener('click', function (event) {
      event.preventDefault();
      forget();
      input.value = '';
      clear.style.display = 'none';
      setStatus('Saved source cleared.', []);
    });

    async function connect() {
      var base = normaliseBase(input.value);
      if (!base) { setStatus('Nothing to connect', ['Enter a relay origin such as https://nse-live-relay.you.workers.dev']); return; }
      button.disabled = true;
      setStatus('Testing ' + base + ' …', []);
      var probed = await probe(base, options.timeoutMs);
      button.disabled = false;
      if (!probed.ok) {
        remember('');
        setStatus('Could not reach ' + base, [probed.error]);
        return;
      }
      remember(base);
      clear.style.display = '';
      var healthy = probed.health && probed.health.mode && probed.health.mode !== 'down';
      setStatus(
        healthy ? 'Connected — loading live data…' : 'Relay reachable, but it cannot reach NSE right now; retrying anyway',
        ['health: ' + String(probed.health.mode || 'unknown') + (probed.health.source ? ' · source ' + probed.health.source : '')]
      );
      if (typeof options.onConnected === 'function') options.onConnected(base);
    }

    button.addEventListener('click', connect);
    input.addEventListener('keydown', function (event) { if (event.key === 'Enter') connect(); });
  }

  window.NseRelay = {
    resolve: resolve,
    isLoopback: isLoopback,
    probe: probe,
    remember: remember,
    forget: forget,
    savedBase: savedBase,
    storedBase: storedBase,
    candidates: candidates,
    describe: describe,
    prettifyTried: prettifyTried,
    mountPanel: mountPanel,
    deployUrl: DEPLOY_URL,
    normaliseBase: normaliseBase,
  };
})();
