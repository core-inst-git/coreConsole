const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('coredaq', {
  getStatus: () => ipcRenderer.invoke('coredaq:get-status'),
  onOpenPreferences: (cb) => ipcRenderer.on('ui:open-preferences', cb),
  onWindowState: (cb) => {
    const handler = (_event, state) => cb(state);
    ipcRenderer.on('ui:window-state', handler);
    return () => ipcRenderer.removeListener('ui:window-state', handler);
  },
  goBack: () => ipcRenderer.invoke('coredaq:go-back'),
  windowMinimize: () => ipcRenderer.invoke('coredaq:window-minimize'),
  windowToggleMaximize: () => ipcRenderer.invoke('coredaq:window-toggle-maximize'),
  windowClose: () => ipcRenderer.invoke('coredaq:window-close'),
  windowIsMaximized: () => ipcRenderer.invoke('coredaq:window-is-maximized'),
  pickSavePath: (defaultName) => ipcRenderer.invoke('coredaq:pick-save-path', { defaultName })
});

contextBridge.exposeInMainWorld('gpib', {
  health: () => ipcRenderer.invoke('gpib:health'),
  listResources: () => ipcRenderer.invoke('gpib:list'),
  open: (resource, timeoutMs) => ipcRenderer.invoke('gpib:open', { resource, timeoutMs }),
  write: (sessionId, command) => ipcRenderer.invoke('gpib:write', { sessionId, command }),
  read: (sessionId, maxBytes) => ipcRenderer.invoke('gpib:read', { sessionId, maxBytes }),
  query: (sessionId, command, maxBytes) => ipcRenderer.invoke('gpib:query', { sessionId, command, maxBytes }),
  queryResource: (resource, command, timeoutMs, maxBytes) =>
    ipcRenderer.invoke('gpib:query', { resource, command, timeoutMs, maxBytes }),
  setTimeout: (sessionId, ms) => ipcRenderer.invoke('gpib:set-timeout', { sessionId, ms }),
  close: (sessionId) => ipcRenderer.invoke('gpib:close', { sessionId }),
  restartService: () => ipcRenderer.invoke('gpib:restart-service'),
});
