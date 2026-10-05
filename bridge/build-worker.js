#!/usr/bin/env node
/**
 * build-worker.js — generate a single-file, paste-ready relay bundle.
 *
 *   node bridge/build-worker.js
 *
 * Output: bridge/nse-worker.bundle.js — nse-core.js + nse-worker.js in one ES
 * module. Useful when deploying through the Cloudflare dashboard editor (paste
 * the file contents) instead of the repo-based one-click deploy or wrangler.
 *
 * The bundle is generated from the same sources the Node servers use, so the
 * relay can never drift from the local data path.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const dir = __dirname;
const corePath = path.join(dir, 'nse-core.js');
const workerPath = path.join(dir, 'nse-worker.js');
const outPath = path.join(dir, 'nse-worker.bundle.js');

const core = fs.readFileSync(corePath, 'utf8');
const worker = fs.readFileSync(workerPath, 'utf8');

// Drop the module import: the bundle inlines the core above the worker body.
const workerBody = worker.replace(/^\s*import\s+['"]\.\/nse-core\.js['"];\s*$/m, '');
if (workerBody === worker) {
  console.error('build-worker: could not find the nse-core import in nse-worker.js');
  process.exit(1);
}

const banner = `/**
 * nse-worker.bundle.js — GENERATED FILE, do not edit.
 * Source: bridge/nse-core.js + bridge/nse-worker.js
 * Rebuild: node bridge/build-worker.js
 *
 * Paste this whole file into a Cloudflare Worker (dashboard → Workers → Create
 * → paste → Deploy), or deploy the repo with the one-click button / wrangler.
 * Live-only: no fixtures, saved snapshots, or generated market values.
 */
`;

fs.writeFileSync(outPath, `${banner}${core.trimEnd()}\n\n/* ---------- worker entry (from bridge/nse-worker.js) ---------- */\n\n${workerBody.trimStart()}`);

const size = fs.statSync(outPath).size;
console.log(`wrote ${path.relative(process.cwd(), outPath)} (${(size / 1024).toFixed(1)} KB)`);
