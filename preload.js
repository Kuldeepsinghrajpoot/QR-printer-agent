const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('printerAPI', {
  scan: () => ipcRenderer.invoke('printers:scan'),
});

// Print Agent — settings, live status, activity and printer overview.
contextBridge.exposeInMainWorld('agentAPI', {
  getConfig: () => ipcRenderer.invoke('agent:get-config'),
  saveConfig: (config) => ipcRenderer.invoke('agent:save-config', config),
  getMachine: () => ipcRenderer.invoke('agent:get-machine'),
  getStatus: () => ipcRenderer.invoke('agent:get-status'),
  getActivity: () => ipcRenderer.invoke('agent:get-activity'),
  getPrinters: () => ipcRenderer.invoke('agent:get-printers'),
  syncNow: () => ipcRenderer.invoke('agent:sync-now'),
  onStatus: (cb) => ipcRenderer.on('agent:status', (_event, status) => cb(status)),
});

// App updates (GitHub Releases). The button is only shown while an update is available.
contextBridge.exposeInMainWorld('updateAPI', {
  getState: () => ipcRenderer.invoke('update:get-state'),
  install: () => ipcRenderer.invoke('update:install'),
  onState: (cb) => ipcRenderer.on('update:state', (_event, state) => cb(state)),
});
