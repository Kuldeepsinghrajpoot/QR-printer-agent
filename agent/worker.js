'use strict';
const config = require('./config');
const queue = require('./queue');
const api = require('./api');
const { printOrder, listSystemPrinters } = require('./printer');
const { scanPrinters, getCachedScan } = require('../scanner');
const { getMachineInfo } = require('./machine');
const { createHealthTracker } = require('./health');

/** Knows when a printer must be reported offline although Windows still says it is fine (see health.js). */
const health = createHealthTracker();

let lastSyncAt = null;
let lastError = null;
let running = false;
let onStatusChange = () => {};

function setStatusListener(fn) {
  onStatusChange = fn;
}

function getStatus() {
  return { configured: !!config.get('agentApiKey'), running, lastSyncAt, lastError, queueLength: queue.getAll().length };
}

function emitStatus() {
  onStatusChange(getStatus());
}

// ---------- Activity log (shown in the "Print Agent" tab so failures are visible without a console) ----------
const activity = [];
const MAX_ACTIVITY = 40;

function log(token, level, message) {
  activity.unshift({ at: Date.now(), token: token || '', level, message });
  if (activity.length > MAX_ACTIVITY) activity.length = MAX_ACTIVITY;
  if (level === 'error') console.error(token ? `[${token}] ${message}` : message);
}

const getActivity = () => activity.slice();

// ---------- Local printers (from the Printers-tab scan) ----------

/**
 * Real (non-virtual) printers on this PC. Uses the same scan as the Printers tab — which knows whether a
 * printer is really reachable, out of paper, jammed, low on toner — and falls back to Windows' plain
 * printer list if the scan fails (or on non-Windows/mock mode).
 */
async function physicalPrinters() {
  try {
    const res = getCachedScan(10000) || (await scanPrinters());
    if (res && res.ok && !res.mock) {
      const list = res.data.printers.filter((p) => !p.isVirtual);
      if (list.length) return list.map((p) => ({ name: p.name, scan: p }));
    }
  } catch (_) { /* fall back below */ }
  const sys = await listSystemPrinters();
  return sys.map((p) => ({ name: p.name }));
}

/** Maps the scan result to the dashboard's printer status. */
function dashboardStatus(scan) {
  if (scan.connection === 'disconnected') return 'offline';
  if (scan.paperLevel === 'jam') return 'paper_jam';
  if (scan.paperLevel === 'empty') return 'out_of_paper';
  if (scan.tonerLevel === 'low' || scan.tonerLevel === 'empty') return 'low_ink';
  return 'online';
}

/**
 * Printers auto-discovered from the dashboard (matched by Windows printer name), refreshed by
 * syncPrintersOnce(). The dashboard is the source of truth for each printer's type (B&W / Color).
 */
let autoMappings = [];
let lastPrinterSyncAt = 0;

async function syncPrintersOnce(list) {
  try {
    const printers = list || (await physicalPrinters());
    if (printers.length === 0) return;
    const machine = await getMachineInfo();
    const dashboardPrinters = await api.syncPrinters(
      printers.map((p) => ({
        name: p.name,
        // connection TYPE and driver only — IP address, TCP port and port name are NOT sent to the dashboard
        ...(p.scan
          ? {
              portType: p.scan.portType || undefined,
              driver: p.scan.driver || undefined,
            }
          : {}),
      })),
      machine
    );
    autoMappings = dashboardPrinters.map((p) => ({ dbPrinterId: p.id, systemPrinterName: p.systemPrinterName, type: p.type }));
    lastPrinterSyncAt = Date.now();
  } catch (err) {
    // Non-fatal — keep using the last known mappings / manual mappings.
    console.error('Printer auto-sync failed:', err instanceof Error ? err.message : err);
  }
}

/** Manual mappings from settings win; auto-discovered ones fill the gaps. */
function allMappings() {
  const manual = (config.get('printerMappings') || []).filter((m) => m.dbPrinterId && m.systemPrinterName);
  const manualIds = new Set(manual.map((m) => m.dbPrinterId));
  // Dashboard type is authoritative even for manual rows (they can go stale).
  const typeById = new Map(autoMappings.map((m) => [m.dbPrinterId, m.type]));
  return [
    ...manual.map((m) => ({ ...m, type: typeById.get(m.dbPrinterId) || m.type })),
    ...autoMappings.filter((m) => !manualIds.has(m.dbPrinterId)),
  ];
}

/** Picks which local (Windows) printer name an order should go to. */
function resolvePrinterName(order) {
  const mappings = allMappings();

  if (order.printerId) {
    const mapped = mappings.find((m) => m.dbPrinterId === order.printerId);
    if (mapped) return mapped.systemPrinterName;
    // Assigned to a printer this agent doesn't own (another PC's printer) — leave it queued.
    return null;
  }

  // Only ONE printer on this PC -> treat it as multifunction: it takes every order.
  if (mappings.length === 1) return mappings[0].systemPrinterName;

  // B&W jobs -> a B&W printer, Color jobs -> a Color printer. A dedicated printer wins over a "both" printer.
  const exact = mappings.find((m) => m.type === order.printType);
  if (exact) return exact.systemPrinterName;
  const both = mappings.find((m) => m.type === 'both');
  if (both) return both.systemPrinterName;

  // Default printer is only a last resort when no printers are mapped at all.
  if (mappings.length === 0) return config.get('defaultSystemPrinterName') || null;
  return null;
}

/** Lists this PC's printers, their live health and whether each is linked to a dashboard printer. */
async function getPrinterOverview() {
  const list = await physicalPrinters();
  const mappings = allMappings();
  return list.map((p) => {
    const m = mappings.find((x) => x.systemPrinterName === p.name);
    let status = p.scan ? dashboardStatus(p.scan) : 'unknown';
    let detail = p.scan ? p.scan.detail : '';
    if ((status === 'online' || status === 'low_ink') && health.isOffline(p.name, p.scan)) {
      status = 'offline';
      detail = 'Not printing: jobs are waiting or a job got stuck. Check the printer is on and the USB cable is connected.';
    }
    return {
      systemPrinterName: p.name,
      type: m ? m.type : null,
      linked: !!m,
      status,
      detail,
      port: p.scan ? p.scan.port : '',
      portType: p.scan ? p.scan.portType : '',
      ipAddress: p.scan ? p.scan.ipAddress : '',
      tcpPort: p.scan ? p.scan.tcpPort || 0 : 0,
    };
  });
}

// ---------- Orders ----------

/** Retries any status updates that previously failed to reach the server. */
async function flushPendingQueue() {
  for (const item of queue.getAll()) {
    try {
      await api.reportOrderStatus(item.orderId, item.printStatus, item.printerError);
      queue.removeItem(item);
    } catch (_) {
      break; // still offline — leave it queued, try again next cycle
    }
  }
}

/** Reports status; if the network call itself fails, queues it for retry instead of losing it. */
async function safeReportStatus(orderId, printStatus, printerError) {
  try {
    await api.reportOrderStatus(orderId, printStatus, printerError);
  } catch (_) {
    queue.enqueue({ orderId, printStatus, printerError });
  }
}

const waitingLogged = new Set();

async function processOrder(order) {
  const systemPrinterName = resolvePrinterName(order);

  if (!systemPrinterName) {
    // No printer configured/assigned yet — leave it queued; the owner may assign one at any moment.
    if (!waitingLogged.has(order._id)) {
      waitingLogged.add(order._id);
      log(order.token, 'info', 'Waiting — no printer on this PC matches this order yet');
    }
    return;
  }

  // Atomically claim the order. If another agent claimed it a moment earlier the server says "not claimed"
  // and we skip it quietly — this is what prevents the same file being sent to two printers.
  let claim;
  try {
    // Also tell the dashboard which computer + printer is doing the job (shown in the Live Queue).
    claim = await api.reportOrderStatus(order._id, 'printing', undefined, {
      agentId: (await getMachineInfo()).id,
      printedOn: systemPrinterName,
    });
  } catch (err) {
    console.error(`Could not claim order ${order.token} this cycle:`, err instanceof Error ? err.message : err);
    return; // stays "queued" server-side; the next poll tries again
  }
  if (!claim.claimed) return;

  const modeText = order.printType === 'color' ? 'colour' : order.printType === 'bw' ? 'B&W' : '';
  log(order.token, 'info', `Printing${modeText ? ' ' + modeText : ''} on ${systemPrinterName}${order.duplex ? ' (duplex)' : ''}…`);
  health.printStarted(systemPrinterName);
  let printed = false;
  try {
    if (!order.fileUrl) throw new Error('Order has no file attached');
    const fileBuffer = await api.downloadFile(order.fileUrl);
    const result = await printOrder({
      fileBuffer,
      fileName: order.fileName,
      systemPrinterName,
      copies: order.copies,
      duplex: order.duplex,
      printType: order.printType, // 'color' | 'bw' - without this the printer used its own default (often grayscale)
    });
    for (const w of (result && result.warnings) || []) log(order.token, 'info', w);
    printed = true;
    await safeReportStatus(order._id, 'ready');
    log(order.token, 'ok', `Printed on ${systemPrinterName}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown print error';
    log(order.token, 'error', message);
    // Printer offline / job stuck in its queue -> report the printer offline until it prints again.
    if (err && err.printerStalled) health.printerStalled(systemPrinterName, message);
    await safeReportStatus(order._id, 'failed', message);
  } finally {
    health.printFinished(systemPrinterName, printed);
  }
}

let polling = false;

/**
 * One full poll cycle: flush retries, then fetch and process new orders. Orders are grouped by the physical
 * printer they go to; groups run in parallel, orders for the SAME printer print one at a time, in order.
 */
async function pollOnce() {
  if (!config.get('agentApiKey')) return;
  if (polling) return; // a cycle can outlast the interval (slow downloads/prints) — don't stack cycles
  polling = true;
  try {
    await flushPendingQueue();
    if (Date.now() - lastPrinterSyncAt > 60000) await syncPrintersOnce();
    const orders = await api.fetchQueuedOrders();

    const groups = new Map();
    for (const order of orders) {
      const key = resolvePrinterName(order) || '__unassigned__';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(order);
    }
    // Orders assigned to a printer and still waiting (used to spot a printer that has work but is not performing it).
    const waiting = new Map();
    for (const [name, group] of groups) if (name !== '__unassigned__') waiting.set(name, group.map((o) => String(o._id)));
    health.observeQueue(waiting);
    await Promise.all(
      Array.from(groups.values()).map(async (group) => {
        for (const order of group) await processOrder(order);
      })
    );

    lastSyncAt = Date.now();
    lastError = null;
  } catch (err) {
    lastError = err instanceof Error ? err.message : 'Sync failed';
    console.error('Poll cycle failed:', lastError);
  } finally {
    polling = false;
  }
  emitStatus();
}

// ---------- Heartbeat ----------

/** Consecutive heartbeats a printer looked unreachable (per Windows printer name). */
const missedBeats = new Map();
/** A printer is reported offline only after this many bad heartbeats in a row — avoids flapping. */
const OFFLINE_AFTER_MISSES = 3;

/** Tells the dashboard how each linked printer is doing: online / offline / paper_jam / out_of_paper / low_ink. */
async function heartbeatOnce() {
  if (!config.get('agentApiKey')) return;
  try {
    const list = await physicalPrinters();
    // An empty list almost always means the scan itself failed — don't flip every printer to offline.
    if (list.length === 0) return;
    await syncPrintersOnce(list);
    const agentId = (await getMachineInfo()).id;

    const byName = new Map(list.map((p) => [p.name, p]));
    for (const mapping of allMappings()) {
      const name = mapping.systemPrinterName;
      const entry = byName.get(name);
      // Extra offline checks on top of the scan: stuck job / has work but not printing (see health.js).
      const h = health.evaluate(name, entry && entry.scan, !entry);
      let status;
      if (entry && !(entry.scan && entry.scan.connection === 'disconnected')) {
        missedBeats.delete(name);
        status = entry.scan ? dashboardStatus(entry.scan) : 'online';
        // Only override a healthy-looking printer; a jam / out-of-paper status is more useful than "offline".
        if (h.offline && (status === 'online' || status === 'low_ink')) status = 'offline';
      } else {
        const misses = (missedBeats.get(name) || 0) + 1;
        missedBeats.set(name, misses);
        if (misses < OFFLINE_AFTER_MISSES) continue; // one-off glitch — keep the current status
        status = 'offline';
      }
      try {
        await api.reportPrinterStatus(mapping.dbPrinterId, status, agentId);
      } catch (_) { /* best-effort; next beat retries */ }
    }
  } catch (err) {
    console.error('Heartbeat cycle failed:', err);
  }
}

// ---------- Lifecycle ----------

let pollTimer = null;
let heartbeatTimer = null;
let firstBeatTimer = null;

function stop() {
  clearInterval(pollTimer);
  clearInterval(heartbeatTimer);
  clearTimeout(firstBeatTimer);
  pollTimer = heartbeatTimer = firstBeatTimer = null;
  running = false;
}

/** (Re)starts polling with the current settings. Does nothing until an agent key has been entered. */
function start() {
  stop();
  if (!config.get('agentApiKey')) {
    lastError = null;
    emitStatus();
    return;
  }
  running = true;
  const pollMs = Math.max(3, Number(config.get('pollIntervalSeconds')) || 5) * 1000;
  const heartbeatMs = Math.max(10, Number(config.get('heartbeatIntervalSeconds')) || 30) * 1000;

  void pollOnce();
  firstBeatTimer = setTimeout(() => void heartbeatOnce(), 4000);
  pollTimer = setInterval(() => void pollOnce(), pollMs);
  heartbeatTimer = setInterval(() => void heartbeatOnce(), heartbeatMs);
  emitStatus();
}

module.exports = {
  isBusy: () => health.isBusy(),
  start,
  stop,
  restart: start,
  pollOnce,
  heartbeatOnce,
  getStatus,
  getActivity,
  getPrinterOverview,
  setStatusListener,
};
