'use strict';
const config = require('./config');
const queue = require('./queue');
const api = require('./api');
const { printOrder, listSystemPrinters, colourTestPdf } = require('./printer');
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

/** Last status each linked printer was reported with (online / offline / paper_jam ...), from the heartbeat. */
const lastStatus = new Map();

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

/**
 * Several printers can take the same order (say a TCP/IP printer and a USB printer, both of type "both"). Pick the
 * best one instead of always the first: not offline / jammed / out of paper, then not printing right now, then the
 * one with the fewest orders already given to it in this poll. A dedicated B&W/Color printer wins a tie.
 * `load` counts orders already handed to each printer in this poll, so a batch spreads over the printers.
 */
function pickBest(candidates, load) {
  const score = (m) => {
    const st = lastStatus.get(m.systemPrinterName);
    const unusable = st && st !== 'online' && st !== 'low_ink' ? 100 : 0; // offline, paper jam, out of paper
    const busy = health.isBusy(m.systemPrinterName) ? 10 : 0;
    const queued = (load.get(m.systemPrinterName) || 0) * 1;
    return unusable + busy + queued + (m.type === 'both' ? 0.5 : 0);
  };
  return candidates.reduce((best, m) => (best === null || score(m) < score(best) ? m : best), null);
}

/** Picks which local (Windows) printer name an order should go to. */
function resolvePrinterName(order, load = new Map()) {
  const mappings = allMappings();

  if (order.printerId) {
    const mapped = mappings.find((m) => m.dbPrinterId === order.printerId);
    if (mapped) return mapped.systemPrinterName;
    // Assigned to a printer this agent doesn't own (another PC's printer) — leave it queued.
    return null;
  }

  // Only ONE printer on this PC -> treat it as multifunction: it takes every order.
  if (mappings.length === 1) return mappings[0].systemPrinterName;

  // B&W jobs -> a B&W printer, Color jobs -> a Color printer ("both" printers can take either).
  // With several candidates the best one wins (working, idle, least loaded) instead of always the first.
  const candidates = mappings.filter((m) => m.type === order.printType || m.type === 'both');
  if (candidates.length) return pickBest(candidates, load).systemPrinterName;

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

async function processOrder(order, assignedName) {
  const systemPrinterName = assignedName !== undefined ? assignedName : resolvePrinterName(order);

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
  const extras = [
    order.duplex ? `duplex, ${order.duplexEdge === 'short' ? 'short' : 'long'} edge` : '',
    Number(order.pagesPerSheet) > 1 ? `${order.pagesPerSheet} pages per sheet` : '',
  ].filter(Boolean);
  log(order.token, 'info', `Printing${modeText ? ' ' + modeText : ''} on ${systemPrinterName}${extras.length ? ' (' + extras.join(', ') + ')' : ''}…`);
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
      duplexEdge: order.duplexEdge, // 'long' | 'short' - which edge the double-sided pages flip on
      pagesPerSheet: order.pagesPerSheet, // 1, 2, 4, 6, 9 or 16 pages laid out on each sheet
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
 * Orders already handed to a printer (waiting for its turn, or printing): order id -> Windows printer name.
 * Every printer has its OWN chain of work. A slow job on one printer (say the TCP/IP printer) must never make the
 * other printer (say the USB one) wait, and the next poll must not hand the same order out a second time.
 */
const scheduled = new Map();
const printerChains = new Map(); // printer name -> promise of the last order queued on it

/** Queues the order on that printer's chain and returns at once. Orders on one printer print one after another. */
function schedule(name, order) {
  const id = String(order._id);
  if (scheduled.has(id)) return;
  scheduled.set(id, name);
  const prev = printerChains.get(name) || Promise.resolve();
  const next = prev
    .then(() => processOrder(order, name))
    .catch((err) => console.error(`Order ${order.token} failed unexpectedly:`, err instanceof Error ? err.message : err))
    .then(() => {
      scheduled.delete(id);
      if (printerChains.get(name) === next) printerChains.delete(name);
    });
  printerChains.set(name, next);
}

/**
 * One poll cycle: flush retries, fetch the queued orders and hand each one to its printer's chain. The cycle does NOT
 * wait for the printing itself, so it ends quickly and the next poll can start orders for the other printers while
 * the first printer is still busy. Orders for the SAME printer still print one at a time, in order.
 */
async function pollOnce() {
  if (!config.get('agentApiKey')) return;
  if (polling) return; // a cycle can outlast the interval (slow downloads/prints) — don't stack cycles
  polling = true;
  try {
    await flushPendingQueue();
    if (Date.now() - lastPrinterSyncAt > 60000) {
      // The printer scan can take a while (USB devices make it slower). Orders must not wait for it, so it runs in the
      // background, except on the very first run when there are no printer links yet and nothing could be printed.
      const sync = syncPrintersOnce().catch(() => {});
      lastPrinterSyncAt = Date.now(); // don't start another one while this runs
      if (autoMappings.length === 0 && allMappings().length === 0) await sync;
    }
    // Orders already handed to a printer (still waiting for its turn or printing) are not handed out again.
    const orders = (await api.fetchQueuedOrders()).filter((o) => !scheduled.has(String(o._id)));

    const groups = new Map();
    const load = new Map(); // orders already given to each printer (earlier polls + this one)
    for (const name of scheduled.values()) load.set(name, (load.get(name) || 0) + 1);
    for (const order of orders) {
      const name = resolvePrinterName(order, load);
      if (name) load.set(name, (load.get(name) || 0) + 1);
      const key = name || '__unassigned__';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(order);
    }
    // Orders assigned to a printer and still waiting (used to spot a printer that has work but is not performing it).
    const waiting = new Map();
    for (const [name, group] of groups) if (name !== '__unassigned__') waiting.set(name, group.map((o) => String(o._id)));
    for (const [id, name] of scheduled) {
      if (!waiting.has(name)) waiting.set(name, []);
      waiting.get(name).push(id);
    }
    health.observeQueue(waiting);
    for (const [name, group] of groups) {
      if (name === '__unassigned__') {
        for (const order of group) await processOrder(order, null); // only logs "waiting for a printer" - instant
      } else {
        for (const order of group) schedule(name, order); // runs in the background, one chain per printer
      }
    }

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
      lastStatus.set(name, status);
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

/** Prints the colour test page on one local printer, through the same path real orders use. */
async function testPrint(systemPrinterName, mode) {
  const printType = mode === 'bw' ? 'bw' : 'color';
  const label = printType === 'color' ? 'colour' : 'B&W';
  try {
    const result = await printOrder({
      fileBuffer: colourTestPdf(),
      fileName: 'qrtoprint-colour-test.pdf',
      systemPrinterName,
      copies: 1,
      duplex: false,
      printType,
    });
    const warnings = (result && result.warnings) || [];
    for (const w of warnings) log('', 'info', w);
    log('', 'ok', `${label} test page printed on ${systemPrinterName}`);
    return { ok: true, warnings };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Test print failed';
    log('', 'error', `${label} test page failed on ${systemPrinterName}: ${message}`);
    return { ok: false, message, warnings: [] };
  }
}

module.exports = {
  testPrint,
  start,
  stop,
  restart: start,
  pollOnce,
  heartbeatOnce,
  getStatus,
  getActivity,
  getPrinterOverview,
  hasActivePrint: () => scheduled.size > 0,
  setStatusListener,
};
