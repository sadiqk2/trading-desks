/**
 * NIFTY Options Desk — live-only development server.
 *
 * Serves index.html and exposes the shared NSE adapter. There is no mock or
 * local fallback: if NSE is unavailable, the API reports that state and the UI
 * displays no market analytics until verified live data returns.
 *
 * The page prefers this server (same origin), but it can also display live data
 * through a relay or a local server on the viewer's machine — see
 * ../bridge/nse-relay-client.js. That path runs the very same adapter, so no
 * substitute data can enter the UI.
 *
 * Run: node server.js (PORT=8081 by default; binds 0.0.0.0)
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const live = require('../bridge/nse-live');

const PORT = Number(process.env.PORT || 8081);
const PUBLIC_DIR = __dirname;
const BRIDGE_DIR = path.join(__dirname, '..', 'bridge');
const CORS = live.CORS_HEADERS;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': MIME['.json'], ...CORS });
  res.end(JSON.stringify(body));
}

function sendFile(res, filePath) {
  fs.readFile(filePath, (error, buffer) => {
    if (error) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(buffer);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  // API — one shared dispatcher for the Node server, the standalone bridge,
  // and the hosted relay, so all data paths behave identically.
  if (pathname.startsWith('/api/')) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      res.end();
      return;
    }
    const { status, body } = await live.handleApi(pathname);
    return sendJson(res, status, body);
  }

  // Bridge assets (the browser-side data-source resolver) are shared by both
  // dashboards and the published static pages.
  if (pathname.startsWith('/bridge/')) {
    const name = path.basename(pathname);
    if (!/^[A-Za-z0-9._-]+\.js$/.test(name)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    return sendFile(res, path.join(BRIDGE_DIR, name));
  }

  const requestPath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, requestPath));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== path.join(PUBLIC_DIR, 'index.html')) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  sendFile(res, filePath);
});

server.listen(PORT, '0.0.0.0', async () => {
  console.log(`NIFTY Options Desk → http://0.0.0.0:${PORT}`);
  const health = await live.health();
  const feedAvailable = health.feeds ? health.feeds.optionsDesk === 'live' : health.mode === 'live';
  console.log(feedAvailable
    ? `feed: LIVE — ${health.source}`
    : `feed: UNAVAILABLE — ${(health.errors && health.errors.optionsDesk) || health.error || health.note}`);
  if (!feedAvailable) {
    console.log('       the page can still get live data from a relay or from a server on the viewer\'s machine (see /bridge/nse-relay-client.js)');
  }
});
