/**
 * FLOWSTATE — Electron Main Process
 * Wraps the Cloudflare Workers/Wrangler dev server in a desktop window.
 */

const { app, BrowserWindow, shell, Menu, Tray, nativeImage } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

let mainWindow = null;
let tray = null;
let serverProcess = null;
const PORT = 3456; // Use a different port from the CF Pages dev server to avoid conflicts

// ── Icon path ────────────────────────────────────────────────────────────────
const iconPath = path.join(__dirname, '..', 'public', 'static', 'fs-audio-icon.png');

// ── Wait for server to be ready ──────────────────────────────────────────────
function waitForServer(url, retries = 40, delay = 500) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      http.get(url, (res) => {
        if (res.statusCode < 500) resolve();
        else if (n > 0) setTimeout(() => attempt(n - 1), delay);
        else reject(new Error('Server never became ready'));
      }).on('error', () => {
        if (n > 0) setTimeout(() => attempt(n - 1), delay);
        else reject(new Error('Server never became ready'));
      });
    };
    attempt(retries);
  });
}

// ── Start the wrangler dev server ────────────────────────────────────────────
function startDevServer() {
  const projectRoot = path.join(__dirname, '..');
  serverProcess = spawn('npx', [
    'wrangler', 'pages', 'dev', 'dist',
    '--ip', '127.0.0.1',
    '--port', String(PORT)
  ], {
    cwd: projectRoot,
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, BROWSER: 'none' }
  });

  serverProcess.on('error', (err) => {
    console.error('[Electron] Failed to start server:', err.message);
  });
}

// ── Create main window ────────────────────────────────────────────────────────
function createWindow() {
  const icon = nativeImage.createFromPath(iconPath);

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    icon,
    title: 'FlowState — Intelligent Workspace',
    backgroundColor: '#0f0f1a',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
    },
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    show: false, // shown after ready-to-show
  });

  // Open external links in the system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(`http://127.0.0.1:${PORT}`)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`http://127.0.0.1:${PORT}`)) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  mainWindow.loadURL(`http://127.0.0.1:${PORT}`);
}

// ── System tray ───────────────────────────────────────────────────────────────
function createTray() {
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 22, height: 22 });
  tray = new Tray(icon);
  tray.setToolTip('FlowState');
  const menu = Menu.buildFromTemplate([
    { label: 'Open FlowState', click: () => { if (mainWindow) mainWindow.show(); else createWindow(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  tray.on('double-click', () => { if (mainWindow) mainWindow.show(); });
}

// ── App menu ──────────────────────────────────────────────────────────────────
function buildMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    }] : []),
    {
      label: 'File',
      submenu: [process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' }]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }]
    },
    {
      label: 'Help',
      submenu: [
        { label: 'FlowState on GitHub', click: () => shell.openExternal('https://github.com/mkbrown261/FLOWSTATE') },
        { label: 'Flowstate Audio on GitHub', click: () => shell.openExternal('https://github.com/mkbrown261/FS-AUDIO') },
        { label: '264 Pro on GitHub', click: () => shell.openExternal('https://github.com/mkbrown261/264-pro-video-editor') },
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  buildMenu();
  createTray();

  // First build if dist/ doesn't exist
  const distPath = path.join(__dirname, '..', 'dist');
  const fs = require('fs');
  if (!fs.existsSync(distPath)) {
    console.log('[Electron] dist/ not found — building first...');
    const { execSync } = require('child_process');
    try {
      execSync('npm run build', { cwd: path.join(__dirname, '..'), stdio: 'inherit' });
    } catch (e) {
      console.error('[Electron] Build failed:', e.message);
    }
  }

  startDevServer();

  console.log(`[Electron] Waiting for server on port ${PORT}...`);
  try {
    await waitForServer(`http://127.0.0.1:${PORT}`, 60, 500);
    console.log('[Electron] Server ready — opening window');
    createWindow();
  } catch (e) {
    console.error('[Electron] Server did not start in time:', e.message);
    // Try opening anyway
    createWindow();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
  if (tray) { tray.destroy(); tray = null; }
});
