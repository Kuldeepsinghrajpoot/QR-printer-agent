'use strict';
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

/**
 * Persistent settings of the Print Agent, stored as JSON in the app's data folder
 * (%APPDATA%\printer-monitor\agent-config.json on Windows).
 *
 * printerMappings: OPTIONAL manual overrides that map a dashboard printer (by its id) to the exact
 * Windows printer name. Normally not needed — printers are discovered and linked automatically.
 */
/** The dashboard this app always talks to. Fixed on purpose: it is not a setting, can't be edited and isn't shown. */
const SERVER_URL = 'https://www.qr.lexicalsoftware.in';

const DEFAULTS = {
  agentApiKey: '',
  pollIntervalSeconds: 5,
  heartbeatIntervalSeconds: 30,
  printerMappings: [],
  defaultSystemPrinterName: '',
  autoStartOnLogin: true,
  agentId: '', // random id of THIS installation (created on first start) — tells the dashboard which computer reports
};

let cache = null;
const file = () => path.join(app.getPath('userData'), 'agent-config.json');

function load() {
  if (cache) return cache;
  try {
    cache = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file(), 'utf8')) };
  } catch (_) {
    cache = { ...DEFAULTS };
  }
  delete cache.serverUrl; // an old saved URL (for example localhost) is ignored - SERVER_URL always wins
  return cache;
}

module.exports = {
  SERVER_URL,
  get: (key) => (key === 'serverUrl' ? SERVER_URL : load()[key]),
  getAll: () => ({ ...load(), serverUrl: SERVER_URL }),
  set(patch) {
    const { serverUrl, ...allowed } = patch || {}; // the server URL can never be changed
    Object.assign(load(), allowed);
    fs.writeFileSync(file(), JSON.stringify(cache, null, 2), 'utf8');
  },
};
