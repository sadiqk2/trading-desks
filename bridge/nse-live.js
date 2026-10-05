/**
 * nse-live.js — Node entry point for the shared live NSE core.
 *
 * The implementation lives in ./nse-core.js so that the exact same fetch and
 * normalization code runs in the Node servers, the standalone bridge, and a
 * hosted edge relay (bridge/nse-worker.js). This wrapper only bridges the
 * module systems and preserves the historical `require('./nse-live')` API.
 */
'use strict';

require('./nse-core.js');

const core = globalThis.NseCore;
if (!core) throw new Error('nse-core.js did not initialise globalThis.NseCore');

module.exports = core;
