const { contextBridge, ipcRenderer } = require('electron');

// Effective backend WS port, passed by main via additionalArguments.
const wsPortArg = process.argv.find((a) => a.startsWith('--coredaq-ws-port='));
const wsPort = wsPortArg ? Number(wsPortArg.split('=')[1]) || 8765 : 8765;

contextBridge.exposeInMainWorld('coredaq', {
  wsPort,
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

// GPIB/laser control flows through the Python backend's WebSocket protocol
// (gpib_* / sweep_* actions) — there is no Electron-IPC GPIB bridge anymore.
