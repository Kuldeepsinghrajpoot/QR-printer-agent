'use strict';
const config = require('./config');

/** Max file size we will download (the server caps uploads at 25MB). */
const MAX_FILE_BYTES = 40 * 1024 * 1024;

const baseUrl = () => String(config.get('serverUrl') || '').trim().replace(/\/+$/, '');

/** JSON request to the dashboard server with the agent key. Errors carry the server's own message. */
async function request(method, urlPath, body, timeoutMs = 20000) {
  let res;
  try {
    res = await fetch(baseUrl() + urlPath, {
      method,
      headers: {
        'x-agent-key': config.get('agentApiKey'),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const why = (err && err.cause && (err.cause.code || err.cause.message)) || err.message;
    throw new Error(`Could not reach the server at ${baseUrl() || '(no URL set)'} — ${why}`);
  }

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) { /* not JSON */ }

  if (!res.ok) {
    const serverMsg = data && typeof data.error === 'string' ? data.error : '';
    const err = new Error(`Request failed with status code ${res.status}${serverMsg ? ': ' + serverMsg : ''}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/** Fetches orders that are paid, past the customer's cancel window, and waiting to be printed. */
const fetchQueuedOrders = () => request('GET', '/api/agent/orders');

/**
 * Tells the dashboard which printers are installed on this PC (connection type / driver only — no IP address) and which computer this
 * is; returns the dashboard's printer list so IDs never have to be typed by hand.
 */
const syncPrinters = (printers, agent) => request('POST', '/api/agent/printers/sync', { agent, printers });

/**
 * Reports progress. For "printing" the server treats this as an atomic claim — if another agent already
 * claimed the order it answers 409, which resolves to { claimed: false } instead of throwing.
 */
async function reportOrderStatus(orderId, printStatus, printerError, extra) {
  try {
    await request('PATCH', `/api/agent/orders/${orderId}/status`, {
      printStatus,
      ...(printerError ? { printerError } : {}),
      ...(extra || {}),
    });
    return { claimed: true };
  } catch (err) {
    if (err.status === 409) return { claimed: false, conflict: true };
    throw err;
  }
}

/** Heartbeat: this printer's current health (online / offline / paper_jam / low_ink / out_of_paper). */
async function reportPrinterStatus(dbPrinterId, status, agentId) {
  if (!dbPrinterId) return;
  await request('PATCH', `/api/printers/${dbPrinterId}/status`, { status, ...(agentId ? { agentId } : {}) });
}

/**
 * Shop presence: "this shop's print agent is open and running" (status 'online'), or "it just closed" ('offline').
 * The dashboard treats the shop as online while the last beat is recent, so a crash / power cut / lost internet
 * also turns the shop offline by itself a short time after the beats stop.
 */
const sendShopHeartbeat = (payload, timeoutMs) => request('POST', '/api/agent/heartbeat', payload, timeoutMs);

/** Downloads the order's file into a Buffer, ready to hand to the printer. */
async function downloadFile(fileUrl) {
  const parsed = new URL(fileUrl); // throws on garbage
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Refusing to download non-http(s) file URL');
  }

  let res;
  try {
    res = await fetch(fileUrl, { signal: AbortSignal.timeout(60000), redirect: 'follow' });
  } catch (err) {
    const why = (err && err.cause && (err.cause.code || err.cause.message)) || err.message;
    throw new Error(`File download failed from ${parsed.host} — ${why}`);
  }

  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).replace(/\s+/g, ' ').slice(0, 160); } catch (_) { /* ignore */ }
    const hint = res.status === 400 || res.status === 404
      ? ' (the file may already be deleted, or the storage bucket is not public)'
      : '';
    throw new Error(`File download failed (HTTP ${res.status}) from ${parsed.host}${hint}${detail ? ' — ' + detail : ''}`);
  }
  if (Number(res.headers.get('content-length') || 0) > MAX_FILE_BYTES) throw new Error('File is too large to print');

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_FILE_BYTES) throw new Error('File is too large to print');
  return buf;
}

module.exports = { fetchQueuedOrders, syncPrinters, reportOrderStatus, reportPrinterStatus, sendShopHeartbeat, downloadFile };
