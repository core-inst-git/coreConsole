const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { Menu } = require('electron');
const { spawn, execFile } = require('child_process');
const { VisaServiceClient } = require('./visaServiceClient');

const isDev = !app.isPackaged;
const devURL = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';

let mainWindow;
let backendProc;
let visaClient;
let visaDialogsEnabled = true;
let backendStartErrorShown = false;
const BACKEND_WS_HOST = '127.0.0.1';
const BACKEND_WS_PORT = 8765;

function sortPortPaths(paths) {
  const uniq = [...new Set((paths || []).map((p) => String(p || '').trim()).filter(Boolean))];
  return uniq.sort((a, b) => {
    const am = /^COM(\d+)$/i.exec(a);
    const bm = /^COM(\d+)$/i.exec(b);
    if (am && bm) return Number(am[1]) - Number(bm[1]);
    if (am) return -1;
    if (bm) return 1;
    return a.localeCompare(b);
  });
}

function execText(file, args, timeoutMs = 6000) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: timeoutMs }, (err, stdout) => {
      if (err) {
        resolve({ ok: false, stdout: '', error: String(err?.message || err) });
        return;
      }
      resolve({ ok: true, stdout: String(stdout || ''), error: null });
    });
  });
}

async function listSerialPortsMain() {
  const debug = [];
  let ports = [];

  try {
    const sp = require('serialport');
    const SerialPort = sp?.SerialPort || sp?.default || sp;
    const rows = await SerialPort.list();
    ports = Array.isArray(rows)
      ? rows.map((r) => String(r?.path || '').trim()).filter(Boolean)
      : [];
    debug.push(`serialport.list=${ports.length}`);
  } catch (err) {
    debug.push(`serialport.error=${String(err?.message || err)}`);
  }

  if (ports.length === 0) {
    const reg = await execText('reg.exe', ['query', 'HKLM\\HARDWARE\\DEVICEMAP\\SERIALCOMM']);
    if (reg.ok) {
      const regPorts = [];
      for (const line of reg.stdout.split(/\r?\n/g)) {
        const m = line.match(/\bCOM\d+\b/gi);
        if (m && m.length > 0) regPorts.push(...m);
      }
      ports = sortPortPaths(regPorts);
      debug.push(`fallback.registry=${ports.length}`);
    } else {
      debug.push(`fallback.registry.error=${reg.error}`);
    }
  }

  if (ports.length === 0) {
    const cim = await execText(
      'powershell.exe',
      ['-NoProfile', '-Command', 'Get-CimInstance Win32_SerialPort | Select-Object -ExpandProperty DeviceID'],
      7000,
    );
    if (cim.ok) {
      ports = cim.stdout
        .split(/\r?\n/g)
        .map((line) => line.trim())
        .filter((line) => /^COM\d+$/i.test(line));
      ports = sortPortPaths(ports);
      debug.push(`fallback.cim=${ports.length}`);
    } else {
      debug.push(`fallback.cim.error=${cim.error}`);
    }
  }

  if (ports.length === 0) {
    const dotnet = await execText(
      'powershell.exe',
      ['-NoProfile', '-Command', '[System.IO.Ports.SerialPort]::GetPortNames() | ForEach-Object { $_ }'],
      5000,
    );
    if (dotnet.ok) {
      ports = dotnet.stdout
        .split(/\r?\n/g)
        .map((line) => line.trim())
        .filter((line) => /^COM\d+$/i.test(line));
      ports = sortPortPaths(ports);
      debug.push(`fallback.dotnet=${ports.length}`);
    } else {
      debug.push(`fallback.dotnet.error=${dotnet.error}`);
    }
  }

  return { ports: sortPortPaths(ports), debug };
}

function isPortInUse(host, port) {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', (err) => {
      if (err && err.code === 'EADDRINUSE') {
        resolve(true);
        return;
      }
      resolve(false);
    });
    tester.once('listening', () => {
      tester.close(() => resolve(false));
    });
    tester.listen(port, host);
  });
}

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
  const startJsBackend = async () => {
    const script = path.join(__dirname, '../backend/coredaq_service.js');
    if (!fs.existsSync(script)) {
      console.error(`[coreConsole] JS backend script not found: ${script}`);
      return;
    }
    try {
      const portBusy = await isPortInUse(BACKEND_WS_HOST, BACKEND_WS_PORT);
      if (portBusy) {
        console.warn(
          `[coreConsole] Backend ws://${BACKEND_WS_HOST}:${BACKEND_WS_PORT} already in use. Reusing existing backend process.`,
        );
        return;
      }
    } catch (err) {
      console.warn('[coreConsole] backend port probe failed:', err?.message || err);
    }

    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
    };

    const apiPath = isDev
      ? path.resolve(__dirname, '..', '..', 'API')
      : path.join(process.resourcesPath, 'API');
    const laserJsPath = isDev
      ? path.resolve(__dirname, '..', '..', 'packages', 'laser-js')
      : path.join(process.resourcesPath, 'laser-js');
    const guiNodeModulesPaths = isDev
      ? [path.resolve(__dirname, '..', 'node_modules')]
      : [
        path.join(process.resourcesPath, 'app.asar', 'node_modules'),
        path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules'),
      ];
    if (fs.existsSync(apiPath)) env.COREDAQ_API_PATH = apiPath;
    if (fs.existsSync(laserJsPath)) env.COREDAQ_LASER_JS_PATH = laserJsPath;
    const resolvedGuiNodeModulesPaths = guiNodeModulesPaths
      .filter((p) => !isDev || fs.existsSync(p));
    if (resolvedGuiNodeModulesPaths.length > 0) {
      env.COREDAQ_GUI_NODE_MODULES_PATH = resolvedGuiNodeModulesPaths.join(path.delimiter);
    }

    const addonPath = isDev
      ? path.resolve(__dirname, '..', '..', 'packages', 'visa-addon', 'build', 'Release', 'visa_addon.node')
      : path.join(process.resourcesPath, 'visa-addon', 'build', 'Release', 'visa_addon.node');
    if (fs.existsSync(addonPath)) {
      env.COREDAQ_VISA_ADDON_PATH = addonPath;
      env.VISA_ADDON_PATH = addonPath;
    }

    const backendCwd = isDev ? path.join(__dirname, '..') : process.resourcesPath;
    backendProc = spawn(process.execPath, [script], {
      stdio: 'inherit',
      env,
      cwd: backendCwd,
    });
    console.log(`[coreConsole] Starting JS backend: ${script}`);
    backendProc.on('error', (err) => {
      console.error(`Failed to start JS backend at ${script}`, err);
      if (!isDev && !backendStartErrorShown) {
        backendStartErrorShown = true;
        dialog.showMessageBox({
          type: 'error',
          buttons: ['OK'],
          title: 'Backend Startup Failed',
          message: 'coreConsole backend failed to start.',
          detail: `Script: ${script}\nCWD: ${backendCwd}\nError: ${String(err?.message || err)}`,
        }).catch(() => {});
      }
    });
    backendProc.on('exit', (code, signal) => {
      console.warn(`[coreConsole] JS backend exited code=${code} signal=${signal || 'none'}`);
      backendProc = null;
    });
  };
  startJsBackend().catch((err) => {
    console.error('[coreConsole] Failed to start JS backend:', err);
  });
}

function shouldEnableVisaService() {
  if (process.env.COREDAQ_DISABLE_GPIB_SERVICE === '1') return false;
  return true;
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

async function startVisaService(opts = {}) {
  const silent = opts?.silent === true;
  visaDialogsEnabled = !silent;
  if (!shouldEnableVisaService()) return;
  if (!visaClient) {
    visaClient = new VisaServiceClient({
      isDev,
      autoRestart: true,
      bootTimeoutMs: 25000,
      onBootError: (err) => {
        if (visaDialogsEnabled) showVisaBootErrorDialog(err);
      },
      onBootOk: (_health) => {
        // no-op; consumers call gpib:health on demand
      },
    });
  }

  if (visaClient) {
    try {
      await visaClient.start();
    } catch (err) {
      console.warn('[coreConsole] VISA service failed to start:', err);
      if (!silent && visaDialogsEnabled) showVisaBootErrorDialog(err);
    }
  }
}

app.whenReady().then(() => {
  createWindow();
  buildMenu();
  startBackend();
  // Pre-warm VISA service in the background so first scan does not hit cold-start timeout.
  setTimeout(() => {
    startVisaService({ silent: true }).catch(() => {});
  }, 1200);

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

ipcMain.handle('coredaq:list-serial-ports', async () => {
  return listSerialPortsMain();
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

ipcMain.handle('gpib:probe-idn', async (_event, payload) => {
  await startVisaService();
  if (!visaClient) return { ok: false, error: { code: 'SERVICE_UNAVAILABLE', message: 'GPIB service unavailable' } };
  const resource = String(payload?.resource || '').trim();
  if (!resource) return { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'resource is required' } };
  try {
    const out = await visaClient.request('query', {
      resource,
      command: '*IDN?\n',
      timeoutMs: payload?.timeoutMs,
      maxBytes: payload?.maxBytes,
    });
    return { ok: true, data: String(out?.data || '') };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: String(err?.code || 'VISA_ERROR'),
        status: typeof err?.status !== 'undefined' ? err.status : undefined,
        message: String(err?.message || err),
      },
    };
  }
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
