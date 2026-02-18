const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { Menu } = require('electron');
const { spawn } = require('child_process');
const { VisaServiceClient, isWin } = require('./visaServiceClient');

const isDev = !app.isPackaged;
const devURL = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';

let mainWindow;
let backendProc;
let visaClient;

function emitWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('ui:window-state', {
    maximized: mainWindow.isMaximized(),
    fullscreen: mainWindow.isFullScreen()
  });
}

function loadAppHome() {
  if (!mainWindow) return;
  if (isDev) {
    mainWindow.loadURL(devURL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/dist/index.html'));
  }
}

function goBackOrHome() {
  if (!mainWindow) return;
  const wc = mainWindow.webContents;
  if (wc.canGoBack()) {
    wc.goBack();
    return;
  }
  loadAppHome();
}

function isAppPage(url) {
  if (!url) return false;
  if (isDev) return url.startsWith(devURL);
  return url.startsWith('file:');
}

function injectBackButtonIfNeeded() {
  if (!mainWindow) return;
  const wc = mainWindow.webContents;
  const currentUrl = wc.getURL();
  if (isAppPage(currentUrl)) {
    return;
  }

  wc.executeJavaScript(`
    (() => {
      if (document.getElementById('coredaq-external-controls')) return;
      const wrap = document.createElement('div');
      wrap.id = 'coredaq-external-controls';
      wrap.style.position = 'fixed';
      wrap.style.top = '14px';
      wrap.style.right = '14px';
      wrap.style.zIndex = '2147483647';
      wrap.style.display = 'flex';
      wrap.style.gap = '8px';
      wrap.style.fontFamily = '-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif';

      const mkBtn = (label) => {
        const b = document.createElement('button');
        b.textContent = label;
        b.style.padding = '8px 12px';
        b.style.borderRadius = '999px';
        b.style.border = '1px solid rgba(77, 208, 225, 0.65)';
        b.style.background = 'rgba(12, 18, 28, 0.9)';
        b.style.color = '#dffaff';
        b.style.fontSize = '12px';
        b.style.fontWeight = '600';
        b.style.cursor = 'pointer';
        b.style.boxShadow = '0 6px 16px rgba(0,0,0,0.35)';
        b.addEventListener('mouseenter', () => { b.style.borderColor = 'rgba(77, 208, 225, 0.95)'; });
        b.addEventListener('mouseleave', () => { b.style.borderColor = 'rgba(77, 208, 225, 0.65)'; });
        return b;
      };

      const back = mkBtn('Back');
      back.addEventListener('click', () => {
        if (window.coredaq && typeof window.coredaq.goBack === 'function') {
          window.coredaq.goBack();
        } else if (history.length > 1) {
          history.back();
        }
      });
      const min = mkBtn('_');
      min.addEventListener('click', () => window.coredaq?.windowMinimize?.());
      const max = mkBtn('[ ]');
      max.addEventListener('click', () => window.coredaq?.windowToggleMaximize?.());
      const close = mkBtn('X');
      close.addEventListener('click', () => window.coredaq?.windowClose?.());

      wrap.appendChild(back);
      wrap.appendChild(min);
      wrap.appendChild(max);
      wrap.appendChild(close);
      document.documentElement.appendChild(wrap);
    })();
  `).catch(() => {});
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0b0f14',
    frame: false,
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: -100, y: -100 },
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // Keep navigation in one window so View->Back can return to the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    mainWindow.loadURL(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('did-finish-load', () => {
    injectBackButtonIfNeeded();
    emitWindowState();
  });

  mainWindow.on('maximize', emitWindowState);
  mainWindow.on('unmaximize', emitWindowState);
  mainWindow.on('enter-full-screen', emitWindowState);
  mainWindow.on('leave-full-screen', emitWindowState);
  mainWindow.once('ready-to-show', () => mainWindow?.show());

  loadAppHome();
  if (isDev && process.env.COREDAQ_OPEN_DEVTOOLS === '1') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [{ role: 'quit' }]
    },
    {
      label: 'Edit',
      submenu: [
        {
          label: 'Preferences',
          accelerator: 'CommandOrControl+,',
          click: () => {
            if (mainWindow) {
              mainWindow.webContents.send('ui:open-preferences');
            }
          }
        },
        { type: 'separator' },
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' }
      ]
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Back',
          accelerator: 'Alt+Left',
          click: () => goBackOrHome()
        },
        {
          label: 'Back To App',
          accelerator: 'CommandOrControl+Shift+Left',
          click: () => loadAppHome()
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

function startBackend() {
  if (app.isPackaged) {
    const exeName = process.platform === 'win32' ? 'coredaq_service.exe' : 'coredaq_service';
    const backendExe = path.join(process.resourcesPath, 'backend', exeName);
    backendProc = spawn(backendExe, [], { stdio: 'inherit' });
    backendProc.on('error', (err) => {
      console.error(`Failed to start packaged backend at ${backendExe}`, err);
    });
    return;
  }

  let python = process.env.COREDAQ_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  let pythonArgs = [];
  let pythonSource = 'default';
  if (process.platform === 'win32') {
    const condaPrefix = process.env.CONDA_PREFIX || '';
    const condaPython = condaPrefix ? path.join(condaPrefix, 'python.exe') : '';
    if (condaPython && fs.existsSync(condaPython)) {
      // Prefer the currently activated conda env to avoid stale system/user python.
      python = condaPython;
      pythonSource = 'CONDA_PREFIX';
    } else if (process.env.COREDAQ_PYTHON) {
      python = process.env.COREDAQ_PYTHON;
      pythonSource = 'COREDAQ_PYTHON';
    } else {
      // Fallback to py launcher on Windows when plain "python" is missing.
      python = 'py';
      pythonArgs = ['-3'];
      pythonSource = 'py -3';
    }
  }
  const script = path.join(__dirname, '../backend/coredaq_service.py');
  console.log(`[coreConsole] Starting backend with ${pythonSource}: ${python}`);
  backendProc = spawn(python, [...pythonArgs, script], { stdio: 'inherit' });
  backendProc.on('error', (err) => {
    console.error(`Failed to start dev backend with ${python}`, err);
  });
}

function shouldEnableVisaService() {
  if (process.env.COREDAQ_DISABLE_GPIB_SERVICE === '1') return false;
  if (process.env.COREDAQ_ENABLE_GPIB_SERVICE === '1') return true;
  return isWin();
}

function showVisaBootErrorDialog(err) {
  const code = String(err?.code || 'VISA_BOOT_ERROR');
  const message = String(err?.message || 'Failed to start VISA service');
  const checked = Array.isArray(err?.checkedPaths) ? err.checkedPaths : [];
  const fix = String(
    err?.fix ||
    (code === 'NI_VISA_NOT_FOUND'
      ? 'Install NI-VISA (and NI-488.2 for GPIB), then restart the app.'
      : 'Check NI-VISA installation and addon packaging, then retry.')
  );
  const detail = [
    `Code: ${code}`,
    `Message: ${message}`,
    checked.length ? `Checked paths:\n${checked.join('\n')}` : '',
    `Fix: ${fix}`,
  ].filter(Boolean).join('\n\n');

  dialog.showMessageBox({
    type: code === 'NI_VISA_NOT_FOUND' ? 'error' : 'warning',
    buttons: ['OK'],
    title: 'GPIB Driver Setup',
    message: 'VISA/GPIB service is unavailable.',
    detail,
  }).catch(() => {});
}

async function startVisaService() {
  if (!shouldEnableVisaService()) return;
  if (visaClient) return;

  visaClient = new VisaServiceClient({
    isDev,
    autoRestart: true,
    onBootError: showVisaBootErrorDialog,
    onBootOk: (_health) => {
      // no-op; consumers call gpib:health on demand
    },
  });

  try {
    await visaClient.start();
  } catch (err) {
    console.warn('[coreConsole] VISA service failed to start:', err);
    showVisaBootErrorDialog(err);
  }
}

app.whenReady().then(() => {
  createWindow();
  buildMenu();
  startBackend();
  startVisaService();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (backendProc) {
    backendProc.kill();
  }
  if (visaClient) {
    visaClient.stop().catch(() => {});
  }
});

// Placeholder IPC hooks for backend integration
ipcMain.handle('coredaq:get-status', async () => {
  return { connected: false, source: 'stub' };
});

ipcMain.handle('coredaq:go-back', async () => {
  goBackOrHome();
  return { ok: true };
});

ipcMain.handle('coredaq:window-minimize', async () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
  return { ok: true };
});

ipcMain.handle('coredaq:window-toggle-maximize', async () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  }
  return { ok: true };
});

ipcMain.handle('coredaq:window-close', async () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  return { ok: true };
});

ipcMain.handle('coredaq:window-is-maximized', async () => {
  if (!mainWindow || mainWindow.isDestroyed()) return { maximized: false, fullscreen: false };
  return { maximized: mainWindow.isMaximized(), fullscreen: mainWindow.isFullScreen() };
});

ipcMain.handle('coredaq:pick-save-path', async (_event, opts) => {
  if (!mainWindow || mainWindow.isDestroyed()) return { canceled: true, filePath: null };
  const name = typeof opts?.defaultName === 'string' ? opts.defaultName : 'coredaq_sweep.h5';
  const out = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Sweep as HDF5',
    defaultPath: name,
    filters: [{ name: 'HDF5', extensions: ['h5'] }],
  });
  return {
    canceled: !!out.canceled,
    filePath: out.filePath || null,
  };
});

ipcMain.handle('gpib:health', async () => {
  if (!shouldEnableVisaService()) {
    return {
      enabled: false,
      reason: 'GPIB service disabled on this platform/config',
    };
  }
  await startVisaService();
  const health = await visaClient.health();
  return {
    enabled: true,
    ...health,
  };
});

ipcMain.handle('gpib:list', async () => {
  await startVisaService();
  if (!visaClient) throw new Error('GPIB service unavailable');
  const resources = await visaClient.request('listResources', {});
  return Array.isArray(resources) ? resources : [];
});

ipcMain.handle('gpib:open', async (_event, payload) => {
  await startVisaService();
  if (!visaClient) throw new Error('GPIB service unavailable');
  const resource = String(payload?.resource || '').trim();
  return visaClient.request('open', { resource, timeoutMs: payload?.timeoutMs });
});

ipcMain.handle('gpib:write', async (_event, payload) => {
  await startVisaService();
  if (!visaClient) throw new Error('GPIB service unavailable');
  return visaClient.request('write', {
    sessionId: payload?.sessionId,
    command: payload?.command,
  });
});

ipcMain.handle('gpib:read', async (_event, payload) => {
  await startVisaService();
  if (!visaClient) throw new Error('GPIB service unavailable');
  return visaClient.request('read', {
    sessionId: payload?.sessionId,
    maxBytes: payload?.maxBytes,
  });
});

ipcMain.handle('gpib:query', async (_event, payload) => {
  await startVisaService();
  if (!visaClient) throw new Error('GPIB service unavailable');
  return visaClient.request('query', {
    sessionId: payload?.sessionId,
    resource: payload?.resource,
    command: payload?.command,
    maxBytes: payload?.maxBytes,
    timeoutMs: payload?.timeoutMs,
  });
});

ipcMain.handle('gpib:set-timeout', async (_event, payload) => {
  await startVisaService();
  if (!visaClient) throw new Error('GPIB service unavailable');
  return visaClient.request('setTimeout', {
    sessionId: payload?.sessionId,
    ms: payload?.ms,
  });
});

ipcMain.handle('gpib:close', async (_event, payload) => {
  await startVisaService();
  if (!visaClient) throw new Error('GPIB service unavailable');
  return visaClient.request('close', { sessionId: payload?.sessionId });
});

ipcMain.handle('gpib:restart-service', async () => {
  await startVisaService();
  if (!visaClient) throw new Error('GPIB service unavailable');
  await visaClient.restart();
  return { ok: true };
});
