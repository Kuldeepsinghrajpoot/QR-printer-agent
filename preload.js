const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('printerAPI', {
  scan: () => ipcRenderer.invoke('printers:scan'),
});

contextBridge.exposeInMainWorld('updateAPI', {
  getState: () => ipcRenderer.invoke('update:get-state'),
  install: () => ipcRenderer.invoke('update:install'),
  onState: (cb) => ipcRenderer.on('update:state', (_event, state) => cb(state)),
});

// Print Agent — settings, live status, activity and printer overview.
contextBridge.exposeInMainWorld('agentAPI', {
  getConfig: () => ipcRenderer.invoke('agent:get-config'),
  saveConfig: (config) => ipcRenderer.invoke('agent:save-config', config),
  setKey: (key) => ipcRenderer.invoke('agent:set-key', key), // add or replace the agent key (never read back)
  getMachine: () => ipcRenderer.invoke('agent:get-machine'),
  getStatus: () => ipcRenderer.invoke('agent:get-status'),
  getActivity: () => ipcRenderer.invoke('agent:get-activity'),
  getPrinters: () => ipcRenderer.invoke('agent:get-printers'),
  testPrint: (name, mode) => ipcRenderer.invoke('agent:test-print', name, mode),
  syncNow: () => ipcRenderer.invoke('agent:sync-now'),
  onStatus: (cb) => ipcRenderer.on('agent:status', (_event, status) => cb(status)),
});
