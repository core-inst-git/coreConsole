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
