'use strict';
/**
 * Decides when a printer must be reported "offline" even though Windows still says it is fine.
 *
 * USB printers are the main case: when one is switched off or its cable is pulled, Windows keeps the queue and
 * the USB001 port and often keeps saying "Ready". Three signals catch that:
 *   1. STALLED  - a print job got stuck / the printer was offline when we tried. Offline until a job prints
 *                 successfully, the printer is seen disconnected and comes back, or STALL_MAX_MS passes.
 *   2. IDLE     - the printer has work (jobs in its Windows queue, or an assigned order waiting too long) but is
 *                 not printing, for IDLE_BEATS heartbeats in a row.
 *   3. (The scan itself reports "disconnected" - handled by the caller.)
 * Pure logic, no Electron / Windows calls, so it can be tested on its own.
 */

const IDLE_BEATS = 3; // consecutive heartbeats "has work but not printing" before going offline
const STALL_MAX_MS = 15 * 60 * 1000; // a stalled mark never lasts longer than this on its own
const QUEUED_STALE_MS = 2 * 60 * 1000; // an assigned order waiting this long with no print running = not performing

/** Network printers (TCP/IP, IPP, WSD, shared) are verified by the scan's own network check - health never overrides them. */
const isNetwork = (scan) => !!scan && /network/i.test(String(scan.portType || ''));

function createHealthTracker(now = Date.now) {
  const active = new Map(); // printer -> number of prints this agent is running on it right now
  const stalled = new Map(); // printer -> { since, reason, sawDisconnected }
  const idleBeats = new Map(); // printer -> consecutive heartbeats with work but no activity
  let queuedSince = new Map(); // orderId -> { printer, since }

  const isActive = (name) => (active.get(name) || 0) > 0;

  return {
    printStarted(name) {
      active.set(name, (active.get(name) || 0) + 1);
    },

    /** A print on this printer ended. ok = it really printed, so any "stalled" mark is cleared. */
    printFinished(name, ok) {
      const n = (active.get(name) || 0) - 1;
      if (n > 0) active.set(name, n);
      else active.delete(name);
      if (ok) {
        stalled.delete(name);
        idleBeats.delete(name);
      }
    },

    /** A print failed because the printer is offline / the job got stuck in the queue. */
    printerStalled(name, reason) {
      stalled.set(name, { since: now(), reason: reason || 'Print job got stuck', sawDisconnected: false });
    },

    /** printerName -> [orderId, ...] of orders assigned to it and still waiting, from the latest poll. */
    observeQueue(ordersByPrinter) {
      const next = new Map();
      for (const [printer, ids] of ordersByPrinter) {
        for (const id of ids) {
          const prev = queuedSince.get(id);
          next.set(id, { printer, since: prev && prev.printer === printer ? prev.since : now() });
        }
      }
      queuedSince = next;
    },

    /**
     * Called once per heartbeat for every linked printer. `scan` is the printer's scan entry (or undefined),
     * `missing` = the printer was not in the scan at all. Returns { offline, reason }.
     */
    evaluate(name, scan, missing) {
      if (isNetwork(scan)) {
        stalled.delete(name);
        idleBeats.delete(name);
        return { offline: false };
      }
      const t = now();
      const disconnected = !!missing || (scan && scan.connection === 'disconnected');

      const st = stalled.get(name);
      if (st) {
        if (disconnected) st.sawDisconnected = true;
        else if (st.sawDisconnected) stalled.delete(name); // unplugged/off, now back
        else if (t - st.since > STALL_MAX_MS) stalled.delete(name);
      }
      if (stalled.has(name)) return { offline: true, reason: stalled.get(name).reason };

      if (disconnected || !scan) {
        idleBeats.delete(name);
        return { offline: false };
      }

      const performing = isActive(name) || /printing|warming/i.test(String(scan.status || ''));
      const spoolJobs = Number(scan.jobs) || 0;
      let oldestQueued = 0;
      for (const q of queuedSince.values()) if (q.printer === name) oldestQueued = Math.max(oldestQueued, t - q.since);
      const hasWork = spoolJobs > 0 || oldestQueued >= QUEUED_STALE_MS;

      if (hasWork && !performing) {
        const n = (idleBeats.get(name) || 0) + 1;
        idleBeats.set(name, n);
        if (n >= IDLE_BEATS) {
          return {
            offline: true,
            reason:
              spoolJobs > 0
                ? `${spoolJobs} job(s) waiting in the Windows queue but the printer is not printing`
                : 'An assigned order is waiting but the printer is not printing',
          };
        }
      } else {
        idleBeats.delete(name);
      }
      return { offline: false };
    },

    /** True while this agent is running a print on that printer. Used to spread jobs over idle printers. */
    isBusy(name) {
      return isActive(name);
    },

    /** Read-only view (for the app's Printers tab): is this printer currently counted as offline by us? */
    isOffline(name, scan) {
      if (isNetwork(scan)) return false;
      return stalled.has(name) || (idleBeats.get(name) || 0) >= IDLE_BEATS;
    },
  };
}

module.exports = { createHealthTracker, IDLE_BEATS, STALL_MAX_MS, QUEUED_STALE_MS };
