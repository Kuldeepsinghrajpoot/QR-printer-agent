import { app } from 'electron';
import { execFile } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Printer scan (Windows: PowerShell script; other OS: mock data for UI dev).
// Shared by the Printers tab AND the Print Agent (which uses it to report real
// printer health — connected / offline / paper jam / out of paper / low ink —
// to the dashboard).
// ---------------------------------------------------------------------------


function getScriptPath() {
  // PowerShell can't read files inside app.asar, so copy the script to the
  // temp folder (with a UTF-8 BOM so Windows PowerShell 5.1 reads it correctly).
  const src = fs.readFileSync(path.join(__dirname, 'scan.ps1'), 'utf8');
  const dest = path.join(app.getPath('temp'), 'printer-monitor-scan.ps1');
  fs.writeFileSync(dest, '﻿' + src, 'utf8');
  return dest;
}

function mockScan() {
  const base = { driver: 'Mock Driver', isShared: false, jobs: 0, location: '', comment: '', errors: [], tonerLevel: 'unknown', ipAddress: '' };
  return {
    scannedAt: new Date().toISOString(),
    spooler: 'Running',
    printers: [
      { ...base, name: 'HP LaserJet Pro M404', port: 'IP_192.168.1.20', portType: 'Network (TCP/IP)', ipAddress: '192.168.1.20', tcpPort: 9100, isDefault: true, isVirtual: false, colorCapable: false, connection: 'connected', detail: 'Reachable at 192.168.1.20:9100', status: 'Idle', paperLevel: 'ok' },
      { ...base, name: 'Canon PIXMA G3010', port: 'USB001', portType: 'USB', isDefault: false, isVirtual: false, colorCapable: true, connection: 'connected', detail: 'USB device detected', status: 'Printing', paperLevel: 'low', errors: ['Low paper'], jobs: 2 },
      { ...base, name: 'Epson L3150 (office)', port: 'WSD-1234', portType: 'Network (WSD)', isDefault: false, isVirtual: false, connection: 'disconnected', detail: 'Windows reports the printer as offline', status: 'Offline', paperLevel: 'unknown' },
      { ...base, name: 'Brother HL-L2350DW', port: 'IP_192.168.1.31', portType: 'Network (TCP/IP)', ipAddress: '192.168.1.31', tcpPort: 9100, isDefault: false, isVirtual: false, connection: 'connected', detail: 'Reachable at 192.168.1.31:9100', status: 'Idle', paperLevel: 'empty', tonerLevel: 'low', errors: ['Out of paper', 'Low toner'] },
      { ...base, name: 'Microsoft Print to PDF', port: 'PORTPROMPT:', portType: 'Virtual', isDefault: false, isVirtual: true, connection: 'virtual', detail: 'Virtual printer (no physical device)', status: 'Ready', paperLevel: 'na', tonerLevel: 'na' },
      { ...base, name: 'OneNote (Desktop)', port: 'nul:', portType: 'Virtual', isDefault: false, isVirtual: true, connection: 'virtual', detail: 'Virtual printer (no physical device)', status: 'Ready', paperLevel: 'na', tonerLevel: 'na' },
    ],
  };
}

function scanPrintersOnce() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32' || process.env.PRINTER_MONITOR_MOCK === '1') {
      return resolve({ ok: true, mock: true, data: mockScan() });
    }

    let scriptPath;
    try {
      scriptPath = getScriptPath();
    } catch (err) {
      return resolve({ ok: false, error: 'Could not prepare scan script: ' + err.message });
    }

    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { windowsHide: true, maxBuffer: 20 * 1024 * 1024, timeout: 45000, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) {
          return resolve({ ok: false, error: (stderr && stderr.trim()) || error.message });
        }
        try {
          const json = stdout.replace(/^﻿/, '').trim();
          const data = JSON.parse(json);
          if (!Array.isArray(data.printers)) data.printers = data.printers ? [data.printers] : [];
          resolve({ ok: true, mock: false, data });
        } catch (err) {
          resolve({ ok: false, error: 'Could not read scan output: ' + err.message });
        }
      }
    );
  });
}

// One scan at a time: if the window and the agent ask together they share the same PowerShell run.
let inflight = null;
let last = null; // { at, result } of the last successful scan

function scanPrinters() {
  if (inflight) return inflight;
  inflight = scanPrintersOnce()
    .then((result) => {
      if (result.ok) last = { at: Date.now(), result };
      return result;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** The last successful scan if it is newer than maxAgeMs, otherwise null. */
function getCachedScan(maxAgeMs) {
  return last && Date.now() - last.at <= maxAgeMs ? last.result : null;
}

export { scanPrinters, getCachedScan };
