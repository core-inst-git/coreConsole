const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');
const { Menu } = require('electron');
const { spawn } = require('child_process');

const isDev = !app.isPackaged;
const devURL = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';

let mainWindow;
let backendProc;

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

  const python = process.env.COREDAQ_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const script = path.join(__dirname, '../backend/coredaq_service.py');
  backendProc = spawn(python, [script], { stdio: 'inherit' });
  backendProc.on('error', (err) => {
    console.error(`Failed to start dev backend with ${python}`, err);
  });
}

app.whenReady().then(() => {
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

app.on('before-quit', () => {
  if (backendProc) {
    backendProc.kill();
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
