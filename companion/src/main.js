'use strict';

const path = require('path');
const fs = require('fs');
const {
  app, BrowserWindow, Tray, Menu, ipcMain, screen, powerMonitor, nativeImage, shell, dialog,
} = require('electron');
const core = require('./core');
const { ReminderStore } = require('./store');
const { Scheduler } = require('./scheduler');
const { createServer, DEFAULT_PORT } = require('./server');

const OVERLAY_WIDTH = 420;
const OVERLAY_HEIGHT = 300;
const OVERLAY_MARGIN = 16;
const OVERLAY_GAP = 12;
// Re-assert z-order periodically: some apps (and Windows itself) can push
// always-on-top windows down, e.g. after a full-screen app or UAC prompt.
const RAISE_INTERVAL = 5000;

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let tray = null;
let store = null;
let scheduler = null;
let server = null;
let settings = null;
let quitting = false;
const overlays = new Map(); // reminder id -> BrowserWindow

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  const defaults = { port: DEFAULT_PORT, playSound: true, paused: false, allowedExtensionIds: [] };
  try {
    return Object.assign(defaults, JSON.parse(fs.readFileSync(settingsPath(), 'utf8')));
  } catch {
    return defaults;
  }
}

function saveSettings() {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
}

// ---------------------------------------------------------------------------
// Overlay windows
// ---------------------------------------------------------------------------

function layoutOverlays() {
  const area = screen.getPrimaryDisplay().workArea;
  const perColumn = Math.max(1, Math.floor((area.height - OVERLAY_MARGIN) / (OVERLAY_HEIGHT + OVERLAY_GAP)));
  let i = 0;
  for (const win of overlays.values()) {
    if (win.isDestroyed()) continue;
    const col = Math.floor(i / perColumn);
    const row = i % perColumn;
    const x = area.x + area.width - OVERLAY_MARGIN - OVERLAY_WIDTH - col * (OVERLAY_WIDTH + OVERLAY_GAP);
    const y = area.y + OVERLAY_MARGIN + row * (OVERLAY_HEIGHT + OVERLAY_GAP);
    win.setBounds({ x: Math.max(area.x, x), y, width: OVERLAY_WIDTH, height: OVERLAY_HEIGHT });
    i++;
  }
}

function raise(win) {
  if (win.isDestroyed()) return;
  // 'screen-saver' is the highest level Electron offers; it sits above normal
  // always-on-top windows such as Teams/Outlook pop-ups and the taskbar.
  win.setAlwaysOnTop(true, 'screen-saver');
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.showInactive();
  win.moveTop();
}

function overlayPayload(reminder, isTest) {
  return {
    isTest: !!isTest,
    playSound: settings.playSound,
    reminder: Object.assign({}, reminder, {
      recurrenceText: core.describeRecurrence(reminder.recurrence, reminder.startAt),
    }),
  };
}

function showOverlay(reminder, { isTest = false } = {}) {
  const existing = overlays.get(reminder.id);
  if (existing && !existing.isDestroyed()) {
    existing.webContents.send('reminder:update', overlayPayload(reminder, isTest));
    raise(existing);
    return;
  }

  const win = new BrowserWindow({
    width: OVERLAY_WIDTH,
    height: OVERLAY_HEIGHT,
    show: false,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: false,
    alwaysOnTop: true,
    title: 'Reminder: ' + reminder.title,
    backgroundColor: '#1d1b2f',
    webPreferences: {
      preload: path.join(__dirname, 'overlay', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.reminderId = reminder.id;
  overlays.set(reminder.id, win);

  win.setAlwaysOnTop(true, 'screen-saver');
  // Also show on every virtual desktop and above full-screen windows (macOS).
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // The overlay must stay until the user snoozes, dismisses or completes it.
  win.on('close', (e) => {
    if (!quitting && overlays.get(reminder.id) === win) e.preventDefault();
  });
  win.on('closed', () => {
    clearInterval(win.raiseTimer);
    if (overlays.get(reminder.id) === win) overlays.delete(reminder.id);
    layoutOverlays();
  });
  win.on('minimize', () => setTimeout(() => raise(win), 300));

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.once('ready-to-show', () => {
    layoutOverlays();
    // showInactive: appear on top without stealing keyboard focus, so text
    // being typed in another app is not accidentally sent to the buttons.
    win.showInactive();
    raise(win);
    win.flashFrame(true);
  });
  win.webContents.once('did-finish-load', () => {
    win.webContents.send('reminder:update', overlayPayload(reminder, isTest));
  });
  win.raiseTimer = setInterval(() => raise(win), RAISE_INTERVAL);
  win.loadFile(path.join(__dirname, 'overlay', 'overlay.html'));
}

function closeOverlay(id) {
  const win = overlays.get(id);
  overlays.delete(id);
  if (win && !win.isDestroyed()) win.destroy();
  layoutOverlays();
}

function showTestOverlay() {
  const now = Date.now();
  showOverlay({
    id: 'test-' + now,
    title: 'RemindMe is working',
    message: 'This is a test reminder. It stays on top of other applications until you act on it.',
    dueAt: now,
    startAt: now,
    recurrence: { freq: 'none' },
    snoozedUntil: null,
    status: 'active',
  }, { isTest: true });
}

ipcMain.handle('reminder:act', (event, { action, minutes }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || !win.reminderId) return { ok: false };
  const id = win.reminderId;
  if (id.startsWith('test-')) {
    closeOverlay(id);
    return { ok: true };
  }
  const updated = store.act(id, action, minutes);
  // The scheduler closes the window via onStop when the store changes;
  // make sure it is gone even if the reminder no longer exists.
  if (!updated) closeOverlay(id);
  return { ok: !!updated };
});

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------

function formatWhen(ms) {
  return new Date(ms).toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function refreshTray() {
  if (!tray) return;
  const upcoming = scheduler.upcoming(10);
  const upcomingItems = upcoming.length
    ? upcoming.map((r) => ({ label: formatWhen(core.fireTime(r)) + '  —  ' + r.title.slice(0, 50), enabled: false }))
    : [{ label: 'No upcoming reminders', enabled: false }];
  const loginItem = app.getLoginItemSettings();

  tray.setToolTip('RemindMe — ' + (upcoming.length ? 'next: ' + upcoming[0].title : 'no upcoming reminders')
    + (settings.paused ? ' (paused)' : ''));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'RemindMe Companion', enabled: false },
    { label: server && server.listening ? 'Listening on 127.0.0.1:' + settings.port : 'Bridge not running', enabled: false },
    { type: 'separator' },
    { label: 'Upcoming', submenu: upcomingItems },
    { label: 'Show test reminder', click: showTestOverlay },
    { type: 'separator' },
    {
      label: 'Pause reminders', type: 'checkbox', checked: settings.paused,
      click: (item) => { settings.paused = item.checked; saveSettings(); scheduler.setPaused(settings.paused); refreshTray(); },
    },
    {
      label: 'Play sound', type: 'checkbox', checked: settings.playSound,
      click: (item) => { settings.playSound = item.checked; saveSettings(); },
    },
    {
      label: 'Start with Windows / at login', type: 'checkbox', checked: loginItem.openAtLogin,
      click: (item) => { app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] }); refreshTray(); },
    },
    { label: 'Open data folder', click: () => shell.openPath(app.getPath('userData')) },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
}

function trayIcon() {
  const file = process.platform === 'darwin' ? 'tray-16.png' : 'tray-32.png';
  const img = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', file));
  return img.isEmpty() ? nativeImage.createEmpty() : img;
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

function startServer() {
  server = createServer({
    store,
    version: app.getVersion(),
    onTest: showTestOverlay,
    allowedExtensionIds: settings.allowedExtensionIds,
  });
  server.on('error', (err) => {
    console.error('[server]', err.message);
    if (err.code === 'EADDRINUSE') {
      dialog.showErrorBox('RemindMe Companion',
        'Port ' + settings.port + ' is already in use. Change "port" in ' + settingsPath()
        + ' and the companion URL in the extension settings, then restart.');
    }
    refreshTray();
  });
  server.listen(settings.port, '127.0.0.1', refreshTray);
}

app.on('second-instance', showTestOverlay);
app.on('window-all-closed', () => { /* keep running in the tray */ });
app.on('before-quit', () => { quitting = true; });

app.whenReady().then(() => {
  if (process.platform === 'darwin' && app.dock) app.dock.hide();
  app.setAppUserModelId('com.remindme.companion');

  settings = loadSettings();
  store = new ReminderStore(path.join(app.getPath('userData'), 'reminders.json')).load();
  scheduler = new Scheduler(store, { onRing: showOverlay, onStop: closeOverlay });
  scheduler.paused = settings.paused;
  store.on('change', refreshTray);

  tray = new Tray(trayIcon());
  tray.on('click', () => tray.popUpContextMenu());
  startServer();
  scheduler.start();
  refreshTray();
  setInterval(refreshTray, 60 * 1000).unref();

  // Catch up immediately after sleep/lock instead of waiting for the timer.
  powerMonitor.on('resume', () => scheduler.check());
  powerMonitor.on('unlock-screen', () => scheduler.check());
  screen.on('display-metrics-changed', layoutOverlays);
  screen.on('display-removed', layoutOverlays);
});
