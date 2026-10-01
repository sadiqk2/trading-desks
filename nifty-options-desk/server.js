/**
 * NIFTY Options Desk — live-only development server.
 *
 * Serves index.html and exposes the shared NSE adapter. There is no mock or
 * local fallback: if NSE is unavailable, the API reports that state and the UI
 * displays no market analytics until verified live data returns.
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
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
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

  if (pathname === '/api/chain') {
    try {
      const snapshot = await live.getDeskSnapshot();
      return sendJson(res, 200, snapshot);
    } catch (error) {
      return sendJson(res, 502, {
        mode: 'unavailable',
        error: String(error && error.message || error),
        note: 'No live NSE data is available; no local fallback data is used.',
      });
    }
  }

  const requestPath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, requestPath));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== path.join(PUBLIC_DIR, 'index.html')) {
    res.writeHead(403);
    res.end();
    return;
  }

  fs.readFile(filePath, (error, buffer) => {
    if (error) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(buffer);
  });
});

server.listen(PORT, '0.0.0.0', async () => {
  console.log(`NIFTY Options Desk → http://0.0.0.0:${PORT}`);
  const health = await live.health();
  const feedAvailable = health.feeds ? health.feeds.optionsDesk === 'live' : health.mode === 'live';
  console.log(feedAvailable
    ? `feed: LIVE — ${health.source}`
    : `feed: UNAVAILABLE — ${(health.errors && health.errors.optionsDesk) || health.error || health.note}`);
});
