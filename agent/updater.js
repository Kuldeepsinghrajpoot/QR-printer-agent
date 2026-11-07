'use strict';
/**
 * App updates from GitHub Releases (electron-updater).
 *
 *  - Checks quietly 20 s after start and then every 4 hours. Nothing is shown unless a NEWER release exists.
 *  - When one exists the window shows an "Update available" button (state "available").
 *  - Clicking it downloads the update (state "downloading" + percent) and then installs it and restarts the app.
 *    If an order is printing at that moment the install waits (state "waiting") so no job is cut off.
 *  - A failed background check stays silent (button stays hidden). A failure AFTER the user clicked shows
 *    "Update failed - click to retry" (state "error").
 *
 * Only the installed Windows app can update itself (electron-updater needs the packaged NSIS build).
 * Set PRINTER_MONITOR_FAKE_UPDATE=1 to see the button flow in `npm start` without a real release.
 */
const { app } = require('electron');

const FAKE = process.env.PRINTER_MONITOR_FAKE_UPDATE === '1';
const FIRST_CHECK_MS = 20 * 1000;
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
const IDLE_RECHECK_MS = 2000;

let autoUpdater = null;
let state = { state: 'none', version: '', percent: 0, error: '' };
let onState = () => {};
let isBusy = () => false;
let log = () => {};
let userStarted = false; // the user clicked the button (errors are only shown after that)
let firstTimer = null;
let timer = null;

function setState(patch) {
  state = { ...state, ...patch };
  try {
    onState(state);
  } catch (_) { /* a broken listener must never break updating */ }
}

const getState = () => state;
const inProgress = () => ['downloading', 'waiting', 'installing'].includes(state.state);

function friendlyError(err) {
  const msg = String((err && err.message) || err || '');
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|network|offline/i.test(msg)) return 'No internet connection - click to retry';
  if (/404|latest\.yml|not found/i.test(msg)) return 'Update files not found on GitHub - click to retry';
  return 'Update failed - click to retry';
}

/** Install only when no order is being printed, so a job is never cut off by the restart. */
function installWhenIdle() {
  const attempt = () => {
    if (isBusy()) {
      if (state.state !== 'waiting') setState({ state: 'waiting' });
      setTimeout(attempt, IDLE_RECHECK_MS);
      return;
    }
    setState({ state: 'installing' });
    // silent install, then start the app again
    setTimeout(() => autoUpdater.quitAndInstall(true, true), 800);
  };
  attempt();
}

async function check() {
  if (FAKE || !autoUpdater || inProgress()) return state;
  try {
    await autoUpdater.checkForUpdates();
  } catch (_) { /* the 'error' event logs it; background failures stay silent */ }
  return state;
}

/** The button was clicked: download the update, then install it. */
async function install() {
  if (inProgress()) return state;
  userStarted = true;

  if (FAKE) {
    setState({ state: 'downloading', percent: 0, error: '' });
    for (let p = 10; p <= 100; p += 15) {
      await new Promise((r) => setTimeout(r, 400));
      setState({ percent: Math.min(p, 100) });
    }
    setState({ state: 'installing' });
    setTimeout(() => setState({ state: 'none', version: '' }), 2500); // fake: nothing is really installed
    return state;
  }
  if (!autoUpdater) return state;

  setState({ state: 'downloading', percent: 0, error: '' });
  try {
    const res = await autoUpdater.checkForUpdates(); // fresh info (also covers "retry" after an error)
    if (!res || !res.isUpdateAvailable) {
      userStarted = false;
      setState({ state: 'none', version: '' });
      return state;
    }
    await autoUpdater.downloadUpdate(); // progress / downloaded / error arrive as events
  } catch (_) { /* reported by the 'error' event */ }
  return state;
}

/**
 * opts: onState(state) -> push to the window, isBusy() -> true while an order is printing, log(message).
 */
function init(opts = {}) {
  onState = opts.onState || onState;
  isBusy = opts.isBusy || isBusy;
  log = opts.log || log;

  if (FAKE) {
    firstTimer = setTimeout(() => setState({ state: 'available', version: '9.9.9' }), 3000);
    return;
  }
  if (!app.isPackaged || process.platform !== 'win32') return; // only the installed Windows app can update itself

  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (err) {
    log('Auto-update unavailable (electron-updater is not installed): ' + err.message);
    return;
  }
  autoUpdater.autoDownload = false; // download only after the user clicks
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('update-available', (info) => {
    if (inProgress()) return;
    setState({ state: 'available', version: (info && info.version) || '', percent: 0, error: '' });
  });
  autoUpdater.on('update-not-available', () => {
    if (!inProgress()) setState({ state: 'none', version: '', error: '' });
  });
  autoUpdater.on('download-progress', (p) => setState({ state: 'downloading', percent: Math.round((p && p.percent) || 0) }));
  autoUpdater.on('update-downloaded', () => {
    setState({ percent: 100 });
    installWhenIdle();
  });
  autoUpdater.on('error', (err) => {
    log('Auto-update error: ' + ((err && err.message) || err));
    if (userStarted) {
      userStarted = false;
      setState({ state: 'error', error: friendlyError(err) });
    }
  });

  firstTimer = setTimeout(() => void check(), FIRST_CHECK_MS);
  timer = setInterval(() => void check(), CHECK_EVERY_MS);
}

function stop() {
  clearTimeout(firstTimer);
  clearInterval(timer);
}

module.exports = { init, check, install, getState, stop };
