import { app, BrowserWindow, dialog, globalShortcut, ipcMain, screen, session } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const IS_DEVELOPMENT = !app.isPackaged;
const APP_URL = process.env.ELECTRON_START_URL || (IS_DEVELOPMENT ? 'http://127.0.0.1:5173' : '');
const API_URL = process.env.ELECTRON_API_URL || (IS_DEVELOPMENT ? 'http://127.0.0.1:5000/api' : '');
const APP_ORIGIN = APP_URL ? new URL(APP_URL).origin : null;

if (!APP_URL && !IS_DEVELOPMENT) {
  throw new Error('ELECTRON_START_URL is required for a packaged SecureExam build.');
}

let win = null;
let secure = false;
let allowClose = false;
let fullscreenRepairTimer = null;

function emitFullscreen() {
  if (win && !win.isDestroyed()) {
    win.webContents.send('exam:fullscreen', {
      secure,
      fullscreen: win.isFullScreen(),
      kiosk: win.isKiosk(),
      maximized: win.isMaximized(),
    });
  }
}

function isAllowedNavigation(url) {
  try {
    const target = new URL(url);
    if (target.protocol === 'file:') return IS_DEVELOPMENT;
    return APP_ORIGIN === target.origin;
  } catch {
    return false;
  }
}

function isAllowedMediaOrigin(url) {
  try {
    const target = new URL(url);
    return APP_ORIGIN === target.origin;
  } catch {
    return false;
  }
}

function registerSecureShortcuts() {
  globalShortcut.unregisterAll();
  const shortcuts = [
    'Alt+Left', 'Alt+Right', 'Alt+Up', 'Alt+Down',
    'F11', 'F12', 'Ctrl+R', 'Ctrl+Shift+R',
    'Ctrl+Shift+I', 'Ctrl+Shift+J', 'Ctrl+Shift+C',
    'Ctrl+U', 'Ctrl+L', 'Ctrl+N', 'Ctrl+Shift+N',
    'Ctrl+W', 'Alt+F4', 'Ctrl+Shift+Esc',
  ];
  for (const shortcut of shortcuts) {
    try {
      globalShortcut.register(shortcut, () => {});
    } catch (error) {
      console.warn(`Shortcut block failed for ${shortcut}:`, error.message);
    }
  }
}

function currentDisplay() {
  if (!win || win.isDestroyed()) return screen.getPrimaryDisplay();
  return screen.getDisplayMatching(win.getBounds());
}

function enterSecureMode() {
  if (!win || win.isDestroyed()) return;
  secure = true;
  allowClose = false;
  win.setMenuBarVisibility(false);
  win.setResizable(false);
  win.setMaximizable(false);
  win.setMinimizable(false);

  const display = currentDisplay();
  win.setBounds(display.bounds);
  win.setKiosk(true);
  win.setFullScreen(true);

  if (win.webContents.isDevToolsOpened()) win.webContents.closeDevTools();
  registerSecureShortcuts();
  emitFullscreen();

  clearTimeout(fullscreenRepairTimer);
  fullscreenRepairTimer = setTimeout(() => {
    if (secure && win && !win.isDestroyed() && (!win.isFullScreen() || !win.isKiosk())) {
      const nextDisplay = currentDisplay();
      win.setBounds(nextDisplay.bounds);
      win.setKiosk(true);
      win.setFullScreen(true);
      emitFullscreen();
    }
  }, 350);
}

function exitSecureMode() {
  secure = false;
  globalShortcut.unregisterAll();
  clearTimeout(fullscreenRepairTimer);

  if (!win || win.isDestroyed()) return;
  win.setKiosk(false);
  win.setFullScreen(false);
  win.setResizable(true);
  win.setMaximizable(true);
  win.setMinimizable(true);
  emitFullscreen();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    show: false,
    backgroundColor: '#f4f7fb',
    autoHideMenuBar: true,
    title: 'SecureExam',
    fullscreenable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: IS_DEVELOPMENT,
      spellcheck: false,
    },
  });

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission !== 'media') return callback(false);
    callback(isAllowedMediaOrigin(webContents.getURL()));
  });

  win.once('ready-to-show', () => win.show());

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (secure) win.webContents.send('exam:violation', { type: 'NAVIGATION_BLOCKED', details: { url } });
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url)) {
      event.preventDefault();
      if (secure) win.webContents.send('exam:violation', { type: 'NAVIGATION_BLOCKED', details: { url } });
    }
  });

  win.webContents.on('will-redirect', (event, url) => {
    if (!isAllowedNavigation(url)) {
      event.preventDefault();
      if (secure) win.webContents.send('exam:violation', { type: 'NAVIGATION_BLOCKED', details: { url } });
    }
  });

  win.webContents.on('before-input-event', (event, input) => {
    if (!secure) return;
    const key = input.key?.toLowerCase();
    const blocked = key === 'f11' || key === 'f12'
      || (input.control && key === 'r')
      || (input.control && input.shift && key === 'r')
      || (input.control && input.shift && ['i', 'j', 'c'].includes(key))
      || (input.control && ['u', 'l', 'n', 'w'].includes(key))
      || (input.control && input.shift && ['n', 'esc'].includes(key))
      || (input.alt && ['left', 'right', 'up', 'down', 'f4'].includes(key));

    if (blocked) {
      event.preventDefault();
      win.webContents.send('exam:violation', {
        type: 'NAVIGATION_BLOCKED',
        details: { key, ctrl: !!input.control, alt: !!input.alt },
      });
    }
  });

  win.on('blur', () => {
    if (secure && !allowClose) {
      win.webContents.send('exam:violation', { type: 'WINDOW_BLUR', details: { windowFocused: false } });
    }
  });

  win.on('enter-full-screen', emitFullscreen);
  win.on('leave-full-screen', () => {
    emitFullscreen();
    if (secure) setTimeout(enterSecureMode, 120);
  });
  win.on('maximize', emitFullscreen);
  win.on('unmaximize', emitFullscreen);

  win.on('close', (event) => {
    if (!secure || allowClose) return;
    event.preventDefault();
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Cancel', 'Close & Resume Later'],
      defaultId: 0,
      cancelId: 0,
      title: 'SecureExam session is active',
      message: 'Your exam is still in progress.',
      detail: 'Closing will not submit the exam. Your server-side attempt and saved answers remain available until the deadline. Reopen SecureExam and use Resume exam.',
    });
    if (choice === 1) {
      allowClose = true;
      exitSecureMode();
      win.close();
    }
  });

  win.webContents.on('render-process-gone', (_event, details) => {
    const wasSecure = secure;
    exitSecureMode();
    if (wasSecure) {
      dialog.showErrorBox(
        'SecureExam recovered',
        `The exam window stopped unexpectedly (${details.reason || 'renderer error'}). Reopen the application and use Resume exam. Your active attempt remains on the server until its deadline.`,
      );
    }
  });

  win.loadURL(APP_URL);
}

ipcMain.handle('exam:set-secure', async (_event, enabled) => {
  if (!win || win.isDestroyed()) return { secure: Boolean(enabled), available: false, fullscreen: false, kiosk: false };
  if (enabled) enterSecureMode();
  else exitSecureMode();
  return { secure, available: true, fullscreen: win.isFullScreen(), kiosk: win.isKiosk() };
});

ipcMain.handle('exam:get-secure', async () => ({
  secure,
  available: !!win && !win.isDestroyed(),
  fullscreen: !!win && !win.isDestroyed() && win.isFullScreen(),
  kiosk: !!win && !win.isDestroyed() && win.isKiosk(),
}));

ipcMain.handle('backend:test', async () => {
  try {
    const response = await fetch(`${API_URL}/health`);
    return await response.json();
  } catch (error) {
    return { success: false, message: `Network error: ${error.message}` };
  }
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  screen.on('display-metrics-changed', () => {
    if (secure) enterSecureMode();
  });
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
