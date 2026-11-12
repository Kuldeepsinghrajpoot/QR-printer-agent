'use strict';
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';


/**
 * A tiny persisted queue for status updates that couldn't reach the server (e.g. the shop's internet
 * dropped mid-print). Nothing is lost — on the next successful poll cycle everything queued here is
 * retried before moving on to new orders.
 */
const file = () => path.join(app.getPath('userData'), 'agent-queue.json');

function read() {
  try {
    const data = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (_) {
    return [];
  }
}

function write(list) {
  fs.writeFileSync(file(), JSON.stringify(list), 'utf8');
}

const queue = {
  getAll: read,
  enqueue(update) {
    const list = read();
    list.push({ ...update, queuedAt: Date.now() });
    write(list);
  },
  /** Removes exactly one queued update (matched by order + status + queue time). */
  removeItem(item) {
    const list = read();
    const idx = list.findIndex(
      (u) => u.orderId === item.orderId && u.printStatus === item.printStatus && u.queuedAt === item.queuedAt
    );
    if (idx !== -1) list.splice(idx, 1);
    write(list);
  },
};

export default queue;
