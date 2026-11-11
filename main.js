const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { scanPrinters } = require('./scanner');
const agentConfig = require('./agent/config');
const worker = require('./agent/worker');
const { getMachineInfo } = require('./agent/machine');
const updater = require('./agent/updater');

let mainWindow = null;
let tray = null;
let isQuitting = false;

// ---------------------------------------------------------------------------
// Printer scan (Windows: PowerShell script; other OS: mock data for UI dev)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 760,
    minHeight: 540,
    title: 'QRtoPrint - Powered by Lexical Software',
    icon: path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    backgroundColor: '#0f1419',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const win = mainWindow;
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Crash recovery: rebuild the window if its renderer process dies or hangs.
  win.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit') return;
    logCrash('Renderer process gone: ' + details.reason);
    recreateWindow(win);
  });

  let hangTimer = null;
  win.on('unresponsive', () => {
    clearTimeout(hangTimer);
    hangTimer = setTimeout(() => {
      logCrash('Window unresponsive for 10 seconds');
      recreateWindow(win);
    }, 10000);
  });
  win.on('responsive', () => clearTimeout(hangTimer));

  // Closing the window only hides it (when the tray icon exists) so the Print Agent keeps printing.
  win.on('close', (e) => {
    if (!isQuitting && tray) {
      e.preventDefault();
      win.hide();
    }
  });

  win.on('closed', () => {
    clearTimeout(hangTimer);
    if (mainWindow === win) mainWindow = null;
  });
}

function recreateWindow(oldWin) {
  if (oldWin.isDestroyed()) return;
  createWindow(); // open the new window first so 'window-all-closed' doesn't quit the app
  oldWin.destroy();
}

// ---------------------------------------------------------------------------
// Print Agent (polls the dashboard server and prints paid orders)
// ---------------------------------------------------------------------------

function showWindow() {
  if (!mainWindow) createWindow();
  else {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
}

function agentStatusLabel(status) {
  if (!status.configured) return 'Not set up — open the Print Agent tab';
  if (status.lastError) return 'Error: ' + status.lastError;
  if (status.lastSyncAt) return 'Synced ' + new Date(status.lastSyncAt).toLocaleTimeString();
  return 'Starting…';
}

function refreshTray() {
  if (!tray) return;
  const status = worker.getStatus();
  tray.setToolTip('QRtoPrint Agent — ' + agentStatusLabel(status));
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'QRtoPrint - Powered by Lexical Software', enabled: false },
      { label: agentStatusLabel(status), enabled: false },
      { label: 'Queued retries: ' + status.queueLength, enabled: false },
      { type: 'separator' },
      { label: 'Open', click: showWindow },
      { label: 'Sync now', click: () => { void worker.pollOnce(); void worker.heartbeatOnce(); } },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ])
  );
}

function pushAgentStatus(status) {
  refreshTray();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('agent:status', status);
}

function applyLoginItem() {
  // Only register the installed app — never the dev copy of electron.exe.
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!agentConfig.get('autoStartOnLogin') });
}

const num = (v, min, fallback) => Math.max(min, Number(v) || fallback);

/** Only known keys with sane types are persisted — the renderer can't write arbitrary data. */
function cleanAgentConfig(input) {
  const c = input || {};
  const out = {};
  // serverUrl is fixed in config.js, and the agent key is only changed through 'agent:set-key' - never through here.
  if ('pollIntervalSeconds' in c) out.pollIntervalSeconds = num(c.pollIntervalSeconds, 3, 5);
  if ('heartbeatIntervalSeconds' in c) out.heartbeatIntervalSeconds = num(c.heartbeatIntervalSeconds, 10, 30);
  if ('defaultSystemPrinterName' in c) out.defaultSystemPrinterName = String(c.defaultSystemPrinterName || '');
  if ('autoStartOnLogin' in c) out.autoStartOnLogin = !!c.autoStartOnLogin;
  if ('printerMappings' in c && Array.isArray(c.printerMappings)) {
    out.printerMappings = c.printerMappings
      .filter((m) => m && m.dbPrinterId && m.systemPrinterName)
      .map((m) => ({
        dbPrinterId: String(m.dbPrinterId).trim(),
        systemPrinterName: String(m.systemPrinterName),
        type: ['bw', 'color', 'both'].includes(m.type) ? m.type : 'both',
      }));
  }
  return out;
}

function registerAgentIpc() {
  // The window never receives the agent key (or the fixed server URL) - only whether a key has been added.
  ipcMain.handle('agent:get-config', () => {
    const { agentApiKey, serverUrl, ...safe } = agentConfig.getAll();
    return { ...safe, hasAgentKey: !!agentApiKey };
  });
  // Adds the agent key, or REPLACES the old one. Returns only a flag, never the key itself.
  ipcMain.handle('agent:set-key', (_e, key) => {
    const k = String(key || '').trim();
    if (!k) throw new Error('The key is empty');
    agentConfig.set({ agentApiKey: k });
    worker.restart(); // reconnect with the new key
    return { hasAgentKey: true };
  });
  ipcMain.handle('agent:save-config', (_e, cfg) => {
    agentConfig.set(cleanAgentConfig(cfg));
    applyLoginItem();
    worker.restart(); // pick up the new URL / key / intervals
    return true;
  });
  ipcMain.handle('agent:get-machine', () => getMachineInfo());
  ipcMain.handle('agent:get-status', () => worker.getStatus());
  ipcMain.handle('agent:get-activity', () => worker.getActivity());
  ipcMain.handle('agent:get-printers', () => worker.getPrinterOverview());
  ipcMain.handle('agent:test-print', (_e, name, mode) => worker.testPrint(String(name || ''), mode === 'bw' ? 'bw' : 'color'));
  ipcMain.handle('agent:sync-now', async () => {
    await worker.pollOnce();
    await worker.heartbeatOnce();
    return worker.getStatus();
  });
}

function startAgent() {
  registerAgentIpc();
  try {
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png')));
    tray.on('click', showWindow);
  } catch (err) {
    tray = null; // no tray -> closing the window quits, as before
    logCrash('Tray icon unavailable: ' + err.message);
  }
  worker.setStatusListener(pushAgentStatus);
  refreshTray();
  applyLoginItem();
  worker.start(); // does nothing until an agent key has been entered
}

// ---------------------------------------------------------------------------
// Auto-restart (crash recovery for the main process)
// ---------------------------------------------------------------------------

const MAX_AUTO_RESTARTS = 5;      // give up after this many quick restarts in a row
const STABLE_UPTIME_SECONDS = 60; // running this long counts as stable and resets the counter

function logCrash(message) {
  try {
    const file = path.join(app.getPath('userData'), 'crash.log');
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${message}\n`);
  } catch (_) { /* logging must never throw */ }
  console.error(message);
}

function getRestartCount() {
  const arg = process.argv.find((a) => a.startsWith('--restart-count='));
  return arg ? parseInt(arg.split('=')[1], 10) || 0 : 0;
}

function relaunchApp(reason) {
  logCrash('Auto-restart: ' + reason);
  const next = process.uptime() > STABLE_UPTIME_SECONDS ? 1 : getRestartCount() + 1;
  if (next > MAX_AUTO_RESTARTS) {
    dialog.showErrorBox(
      'QRtoPrint',
      'The app keeps crashing and will not restart again.\n\nDetails are in crash.log in:\n' + app.getPath('userData')
    );
    app.exit(1);
    return;
  }
  const args = process.argv.slice(1).filter((a) => !a.startsWith('--restart-count='));
  app.relaunch({ args: [...args, '--restart-count=' + next] });
  app.exit(0);
}

process.on('uncaughtException', (err) => relaunchApp('Uncaught exception: ' + ((err && err.stack) || err)));
process.on('unhandledRejection', (reason) => logCrash('Unhandled rejection: ' + ((reason && reason.stack) || reason)));

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showWindow();
  });

  app.setAppUserModelId('com.example.printermonitor');
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    ipcMain.handle('printers:scan', () => scanPrinters());
    ipcMain.handle('update:get-state', () => updater.getState());
    ipcMain.handle('update:install', () => updater.install());
    ipcMain.handle('update:check', () => updater.checkNow());
    createWindow();
    startAgent();
    updater.init({
      onState: (state) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update:state', state);
      },
      isBusy: () => worker.hasActivePrint(),
      log: logCrash,
    });
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  let offlineSent = false;
  app.on('before-quit', (e) => {
    isQuitting = true;
    updater.stop();
    if (!offlineSent) {
      // Tell the dashboard the shop is closing (max 3 s), then really quit.
      e.preventDefault();
      offlineSent = true;
      worker.stop();
      worker.goOffline().finally(() => app.quit());
      return;
    }
    worker.stop();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
