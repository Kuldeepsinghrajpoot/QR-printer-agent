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
const DEFAULTS = {
  serverUrl: 'http://localhost:3000',
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
  return cache;
}

module.exports = {
  get: (key) => load()[key],
  getAll: () => ({ ...load() }),
  set(patch) {
    Object.assign(load(), patch);
    fs.writeFileSync(file(), JSON.stringify(cache, null, 2), 'utf8');
  },
};
