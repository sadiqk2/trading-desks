/**
 * NSE Pulse — live-only most-active contracts dashboard server.
 *
 * Serves the dashboard and exposes the shared NSE live adapter. It never returns
 * sample rows or generated ticks; if the NSE feed is unavailable, API requests
 * fail and the UI remains empty until real data is available.
 *
 * Run: node server.js (PORT=8080 by default; binds 0.0.0.0)
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const live = require('../bridge/nse-live');

const PORT = Number(process.env.PORT || 8080);
const PUBLIC_DIR = __dirname;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': MIME['.json'],
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  if (pathname === '/api/health') {
    const health = await live.health();
    return sendJson(res, health.mode === 'live' ? 200 : 503, health);
  }

  if (pathname === '/api/snapshot') {
    try {
      const snapshot = await live.getMostActive();
      return sendJson(res, 200, snapshot);
    } catch (error) {
      return sendJson(res, 502, {
        mode: 'unavailable',
        error: String(error && error.message || error),
        note: 'No live NSE data is available; no local fallback data is used.',
      });
    }
  }

  if (pathname === '/api/series') {
    return sendJson(res, 501, { error: 'Historical series are not provided by this live feed.' });
  }

  const requestPath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, requestPath));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== path.join(PUBLIC_DIR, 'index.html')) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }

  fs.readFile(filePath, (error, buffer) => {
    if (error) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(buffer);
  });
});

server.listen(PORT, '0.0.0.0', async () => {
  console.log(`NSE Pulse → http://0.0.0.0:${PORT}`);
  const health = await live.health();
  const feedAvailable = health.feeds ? health.feeds.nsePulse === 'live' : health.mode === 'live';
  console.log(feedAvailable
    ? `feed: LIVE — ${health.source}`
    : `feed: UNAVAILABLE — ${(health.errors && health.errors.nsePulse) || health.error || health.note}`);
});
