'use strict';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { app } from 'electron';
import config from './config.js';

/** Stable random id of this installation (generated once and kept in the agent settings). */
function getAgentId() {
  let id = config.get('agentId');
  if (!id) {
    id = crypto.randomUUID();
    config.set({ agentId: id });
  }
  return id;
}

let cached = null;

/**
 * Which computer this is: Windows computer name + user name + manufacturer/model number (e.g. "Dell Inc." / "Latitude 5420"),
 * so on the dashboard you can tell which PC a printer is installed on. Looked up once, then cached.
 */
async function getMachineInfo() {
  if (cached) return cached;
  const info = {
    id: getAgentId(),
    hostname: os.hostname(),
    username: (() => { try { return os.userInfo().username; } catch (_) { return ''; } })(),
    manufacturer: '',
    model: '',
    os: typeof os.version === 'function' ? os.version() : os.type(),
    appVersion: app.getVersion(),
  };

  if (process.platform === 'win32') {
    try {
      const out = await new Promise((resolve, reject) => {
        execFile(
          'powershell.exe',
          [
            '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
            "$c = Get-CimInstance Win32_ComputerSystem; ConvertTo-Json -Compress -InputObject @{ m = [string]$c.Manufacturer; n = [string]$c.Model }",
          ],
          { windowsHide: true, timeout: 15000 },
          (err, stdout) => (err ? reject(err) : resolve(String(stdout))),
        );
      });
      const j = JSON.parse(out);
      info.manufacturer = String(j.m || '').trim();
      info.model = String(j.n || '').trim();
    } catch (_) { /* model stays blank — hostname is still reported */ }
  }

  cached = info;
  return info;
}

export { getAgentId, getMachineInfo };
