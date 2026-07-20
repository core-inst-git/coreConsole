const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { Menu } = require('electron');
const { spawn } = require('child_process');

const isDev = !app.isPackaged;
const devURL = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';
const WS_PORT = process.env.COREDAQ_WS_PORT || '8765';

let mainWindow;
let backendProc;
let backendRestarts = 0;
let backendStartedAt = 0;
let quitting = false;

function emitWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('ui:window-state', {
    maximized: mainWindow.isMaximized(),
    fullscreen: mainWindow.isFullScreen()
  });
}

function loadAppHome() {
  if (!mainWindow) return;
  const p = isDev
    ? mainWindow.loadURL(devURL)
    : mainWindow.loadFile(path.join(__dirname, '../renderer/dist/index.html'));
  p.catch((err) => console.error('[coreConsole] failed to load app page:', err));
  // ready-to-show never fires if the initial load fails; don't leave the
  // window invisible forever.
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.show();
    }
  }, 5000);
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
        b.style.border = '1px solid rgba(95, 224, 238, 0.55)';
        b.style.background = 'rgba(11, 14, 19, 0.9)';
        b.style.color = '#EAF7FA';
        b.style.fontSize = '12px';
        b.style.fontWeight = '600';
        b.style.cursor = 'pointer';
        b.style.boxShadow = '0 6px 16px rgba(0,0,0,0.35)';
        b.addEventListener('mouseenter', () => { b.style.borderColor = 'rgba(95, 224, 238, 0.9)'; });
        b.addEventListener('mouseleave', () => { b.style.borderColor = 'rgba(95, 224, 238, 0.55)'; });
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
    backgroundColor: '#0B0E13',
    frame: false,
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: -100, y: -100 },
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [`--coredaq-ws-port=${WS_PORT}`]
    }
  });

  // External links open in the system browser: navigating the app window to
  // arbitrary origins would expose the preload API surface to those pages.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isAppPage(url)) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {});
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

// Resolve the Python interpreter that runs the backend.
// Priority: COREDAQ_BUNDLED_PYTHON env -> bundled runtime in a packaged app ->
// system python. (Phase 3 packaging ships a self-contained runtime under
// resources/python so end users need no separate Python install.)
function resolvePythonExe() {
  if (process.env.COREDAQ_BUNDLED_PYTHON && fs.existsSync(process.env.COREDAQ_BUNDLED_PYTHON)) {
    return process.env.COREDAQ_BUNDLED_PYTHON;
  }
  if (!isDev && process.resourcesPath) {
    const candidates = process.platform === 'win32'
      ? [path.join(process.resourcesPath, 'python', 'python.exe')]
      : [path.join(process.resourcesPath, 'python', 'bin', 'python3')];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
  }
  return process.platform === 'win32' ? 'python' : 'python3';
}

function startBackend() {
  // Packaged builds ship a self-contained PyInstaller backend (no Python
  // install needed on the target machine); dev runs the script directly.
  const bundledBin = process.resourcesPath
    ? path.join(
        process.resourcesPath, 'backend', 'coredaq-backend',
        process.platform === 'win32' ? 'coredaq-backend.exe' : 'coredaq-backend'
      )
    : null;
  const useBundled = !isDev && bundledBin && fs.existsSync(bundledBin);

  const script = path.join(__dirname, '..', 'backend', 'coredaq_service.py');
  if (!useBundled && !fs.existsSync(script)) {
    console.error(`[coreConsole] Python backend not found (no bundled binary, no ${script})`);
    return;
  }

  const pythonExe = useBundled ? bundledBin : resolvePythonExe();
  const wsPort = WS_PORT;
  const args = useBundled
    ? ['--ws-port', String(wsPort)]
    : [script, '--ws-port', String(wsPort)];
  if (process.env.COREDAQ_SIMULATOR === '1') {
    args.push('--simulator');
    if (process.env.COREDAQ_SIM_FRONTEND) args.push('--sim-frontend', process.env.COREDAQ_SIM_FRONTEND);
    if (process.env.COREDAQ_SIM_DETECTOR) args.push('--sim-detector', process.env.COREDAQ_SIM_DETECTOR);
    if (process.env.COREDAQ_SIM_COUNT) args.push('--sim-count', process.env.COREDAQ_SIM_COUNT);
  }
  if (process.env.COREDAQ_PORT) args.push('--port', process.env.COREDAQ_PORT);

  const env = { ...process.env };
  // Unbuffered stdout/stderr so backend logs appear immediately in the console.
  env.PYTHONUNBUFFERED = '1';

  backendStartedAt = Date.now();
  backendProc = spawn(pythonExe, args, {
    stdio: 'inherit',
    env,
    cwd: useBundled ? path.dirname(bundledBin) : path.dirname(script),
  });
  console.log(`[coreConsole] Starting Python backend: ${pythonExe} ${args.join(' ')}`);
  backendProc.on('error', (err) => {
    console.error(`Failed to start Python backend (${pythonExe})`, err);
  });
  backendProc.on('close', (code, sig) => {
    const proc = backendProc;
    backendProc = null;
    if (quitting) return;
    console.error(`[coreConsole] Python backend exited code=${code} sig=${sig || ''}`);
    // Restart with backoff. The renderer shows "disconnected" while down
    // (its client synthesizes an offline status on socket close).
    const aliveMs = Date.now() - backendStartedAt;
    if (aliveMs > 30_000) backendRestarts = 0; // stable run resets the budget
    if (backendRestarts >= 5) {
      dialog.showMessageBox({
        type: 'error',
        buttons: ['OK'],
        title: 'Backend unavailable',
        message: 'The device backend keeps crashing.',
        detail: 'coreConsole restarted it 5 times without success. ' +
          'Check that no other program holds the device/port, then restart the app.',
      }).catch(() => {});
      return;
    }
    backendRestarts += 1;
    const delay = Math.min(5000, 500 * 2 ** backendRestarts);
    console.error(`[coreConsole] restarting backend in ${delay} ms (attempt ${backendRestarts}/5)`);
    setTimeout(() => {
      if (!quitting) startBackend();
    }, delay);
    void proc;
  });
}

// Second instances would fight over port 8765 and the serial device.
const gotInstanceLock = app.requestSingleInstanceLock();
if (!gotInstanceLock) {
  app.quit();
}
app.on('second-instance', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(() => {
  if (!gotInstanceLock) return;
  createWindow();
  buildMenu();
  startBackend();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  quitting = true;
  if (!backendProc) return;
  // Defer quitting until the backend is actually dead — otherwise Electron
  // exits before the escalation timer can fire and a wedged backend becomes
  // an orphan holding port 8765 and the serial device.
  event.preventDefault();
  const proc = backendProc;
  backendProc = null;
  proc.kill(); // SIGTERM — backend finalizes any live recording
  const killer = setTimeout(() => {
    try {
      proc.kill('SIGKILL');
    } catch {
      // already gone
    }
  }, 2000);
  proc.once('close', () => {
    clearTimeout(killer);
    app.quit(); // re-enters before-quit; backendProc is null now, so it passes
  });
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

