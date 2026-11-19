'use strict';
const {
  app, BrowserWindow, Tray, Menu, globalShortcut, desktopCapturer, screen, ipcMain,
  clipboard, nativeImage, dialog, shell, systemPreferences, Notification,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { fork } = require('child_process');

const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';
const APP_NAME = 'Capture';
const PRELOAD = path.join(__dirname, 'src', 'preload.js');

const SHORTCUT_CHOICES = [
  ...(IS_WIN ? ['PrintScreen'] : []),
  'CommandOrControl+Shift+2',
  'CommandOrControl+Shift+X',
  'Alt+Shift+S',
];

let tray = null;
let logFile = null;

// Appends to <userData>/capture.log and prints to the terminal.
function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}`;
  console.log(line);
  try {
    if (!logFile) logFile = path.join(app.getPath('userData'), 'capture.log');
    fs.appendFileSync(logFile, `${line}\n`);
  } catch { /* logging must never break the app */ }
}
let settings = null;
let overlays = []; // { win, display, focusMe, ready }
let capturing = false;
const pins = new Map(); // webContents id -> { win, png, baseW, baseH, drag }

if (IS_WIN) app.setAppUserModelId('com.pageproven.capture');

if (!app.requestSingleInstanceLock()) {
  // Another Capture is running; it gets a 'second-instance' event and starts a capture.
  // app.exit, not app.quit: quit can be ignored this early on macOS and leave this process hanging.
  app.exit(0);
} else {
  app.on('second-instance', () => startCapture());
  app.whenReady().then(init);
}

// ---------- settings ----------

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  const defaults = {
    shortcut: IS_WIN ? 'PrintScreen' : 'CommandOrControl+Shift+2',
    saveDir: path.join(app.getPath('pictures'), APP_NAME),
    lastDir: null,
  };
  try {
    const saved = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    const merged = { ...defaults, ...saved };
    if (!SHORTCUT_CHOICES.includes(merged.shortcut)) merged.shortcut = defaults.shortcut;
    return merged;
  } catch {
    return defaults;
  }
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  } catch (err) {
    console.error('Could not save settings:', err);
  }
}

// ---------- app setup ----------

function init() {
  if (IS_MAC && app.dock) app.dock.hide();
  settings = loadSettings();
  log(`start: ${process.platform} ${process.arch}, electron ${process.versions.electron}, packaged=${app.isPackaged}`);
  if (IS_MAC) log('screen permission:', systemPreferences.getMediaAccessStatus('screen'));

  tray = new Tray(makeTrayIcon());
  tray.setToolTip(`${APP_NAME} — ${prettyShortcut(settings.shortcut)} to capture`);
  if (!IS_MAC) tray.on('click', () => startCapture());
  buildMenu();
  registerShortcut();
  startWatchdog();

  app.on('window-all-closed', () => { /* keep running in the tray */ });
  app.on('will-quit', () => globalShortcut.unregisterAll());

  if (process.argv.includes('--capture')) startCapture();
  if (!app.isPackaged && process.argv.includes('--selftest-hang')) {
    // Test only: freeze the main process while a capture screen is open; the watchdog must end it.
    setTimeout(() => startCapture(), 800);
    setTimeout(() => {
      log('SELFTEST-HANG: blocking the main process for 15 s');
      const end = Date.now() + 15000;
      while (Date.now() < end) { /* frozen on purpose */ }
      log('SELFTEST-HANG FAIL: main process was not stopped');
      app.exit(1);
    }, 3000);
  }
  if (!app.isPackaged && process.argv.includes('--selftest')) {
    require('./scripts/live-selftest')({ startCapture, overlays: () => overlays, log, app });
  }
}

function prettyShortcut(accel) {
  if (IS_MAC) {
    return accel.replace('CommandOrControl+', '⌘').replace('Shift+', '⇧').replace('Alt+', '⌥');
  }
  return accel.replace('CommandOrControl', 'Ctrl').replace('PrintScreen', 'Print Screen');
}

function registerShortcut() {
  globalShortcut.unregisterAll();
  let ok = false;
  try {
    ok = globalShortcut.register(settings.shortcut, () => { log('shortcut pressed'); startCapture(); });
  } catch (err) {
    log('shortcut register threw:', String(err));
    ok = false;
  }
  log(`shortcut ${settings.shortcut} registered=${ok}`);
  if (!ok) {
    dialog.showMessageBox({
      type: 'warning',
      message: 'Capture shortcut unavailable',
      detail: `${prettyShortcut(settings.shortcut)} is taken by another app. Pick another one from the ${APP_NAME} `
        + `${IS_MAC ? 'menu bar' : 'tray'} icon → Capture shortcut.`,
    });
  }
  tray.setToolTip(`${APP_NAME} — ${prettyShortcut(settings.shortcut)} to capture`);
  return ok;
}

function buildMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    // The short delay lets the menu finish closing before the capture screen takes over.
    { label: 'Capture area', accelerator: settings.shortcut, registerAccelerator: false, click: () => setTimeout(startCapture, 250) },
    { label: 'Capture in 3 seconds', click: () => setTimeout(startCapture, 3000) },
    { type: 'separator' },
    { label: 'Open screenshots folder', click: openSaveDir },
    { label: 'Change screenshots folder…', click: chooseSaveDir },
    {
      label: 'Capture shortcut',
      submenu: SHORTCUT_CHOICES.map((s) => ({
        label: prettyShortcut(s),
        type: 'radio',
        checked: settings.shortcut === s,
        click: () => {
          settings.shortcut = s;
          saveSettings();
          registerShortcut();
          buildMenu();
        },
      })),
    },
    {
      label: 'Launch at login',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    },
    { type: 'separator' },
    {
      label: `Close pinned images (${pins.size})`,
      enabled: pins.size > 0,
      click: () => [...pins.values()].forEach((p) => p.win.close()),
    },
    { label: `Quit ${APP_NAME}`, click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
}

function openSaveDir() {
  fs.mkdirSync(settings.saveDir, { recursive: true });
  shell.openPath(settings.saveDir);
}

async function chooseSaveDir() {
  if (IS_MAC) app.focus({ steal: true });
  const res = await dialog.showOpenDialog({
    title: 'Choose screenshots folder',
    defaultPath: settings.saveDir,
    properties: ['openDirectory', 'createDirectory'],
  });
  if (!res.canceled && res.filePaths[0]) {
    settings.saveDir = res.filePaths[0];
    saveSettings();
  }
  releaseFocus();
}

function notify(title, body, onClick) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, silent: true });
  if (onClick) n.on('click', onClick);
  n.show();
}

// Gives focus back to whatever app was in front before the capture (macOS).
function releaseFocus() {
  if (IS_MAC && BrowserWindow.getAllWindows().length === 0) app.hide();
}

// ---------- capture ----------

async function ensureMacPermission() {
  if (systemPreferences.getMediaAccessStatus('screen') === 'granted') return true;
  // macOS reports "denied" both when access was refused and when the app has never asked.
  // Asking for a source is what makes macOS show its prompt and list the app under Screen Recording.
  try {
    await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
  } catch (err) {
    log('permission probe failed:', String(err));
  }
  const status = systemPreferences.getMediaAccessStatus('screen');
  log('screen permission after probe:', status);
  if (status === 'granted') return true;
  showPermissionHelp();
  return false;
}

async function showPermissionHelp() {
  log('showing permission help');
  app.focus({ steal: true });
  const { response } = await dialog.showMessageBox({
    type: 'info',
    message: `${APP_NAME} needs Screen Recording permission`,
    detail: 'Open System Settings → Privacy & Security → Screen & System Audio Recording, turn on '
      + `${app.isPackaged ? APP_NAME : 'Electron (dev mode)'}, then restart ${APP_NAME}.`,
    buttons: ['Open System Settings', 'Cancel'],
    defaultId: 0,
  });
  if (response === 0) {
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  }
}

async function startCapture() {
  log('capture requested, already capturing =', capturing);
  if (capturing) return;
  capturing = true;
  try {
    if (IS_MAC && !(await ensureMacPermission())) {
      capturing = false;
      return;
    }
    const displays = screen.getAllDisplays();
    const maxW = Math.max(...displays.map((d) => Math.round(d.size.width * d.scaleFactor)));
    const maxH = Math.max(...displays.map((d) => Math.round(d.size.height * d.scaleFactor)));
    log(`displays: ${displays.length}, thumbnail ${maxW}x${maxH}`);
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: maxW, height: maxH },
    });
    log('sources:', sources.map((s) => ({ id: s.display_id, size: s.thumbnail.getSize(), empty: s.thumbnail.isEmpty() })));
    if (IS_MAC) log('screen permission after capture:', systemPreferences.getMediaAccessStatus('screen'));

    if (IS_MAC && systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
      capturing = false;
      showPermissionHelp();
      return;
    }

    const cursorDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    overlays = [];
    displays.forEach((d, i) => {
      const src = sources.find((s) => s.display_id && s.display_id === String(d.id)) || sources[i];
      if (!src || src.thumbnail.isEmpty()) return;
      overlays.push(createOverlay(d, src.thumbnail, d.id === cursorDisplay.id));
    });
    if (!overlays.length) throw new Error('No screen could be captured.');
  } catch (err) {
    log('capture failed:', String(err && err.stack ? err.stack : err));
    closeOverlays();
    dialog.showErrorBox(`${APP_NAME}: capture failed`, String(err && err.message ? err.message : err));
  }
}

function createOverlay(display, image, focusMe) {
  const { x, y, width, height } = display.bounds;
  const win = new BrowserWindow({
    x, y, width, height,
    show: false,
    frame: false,
    transparent: false,
    backgroundColor: '#000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    enableLargerThanScreen: true,
    roundedCorners: false,
    title: APP_NAME,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  // 'pop-up-menu' covers the menu bar and Dock but stays below system UI such as Force Quit;
  // 'screen-saver' would sit above everything, so a stuck capture screen could not be escaped.
  win.setAlwaysOnTop(true, 'pop-up-menu');
  if (IS_MAC) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  win.setBounds(display.bounds);
  win.setMenu(null);

  const entry = { win, display, focusMe, ready: false };
  const size = image.getSize();
  win.webContents.once('did-finish-load', () => {
    win.webContents.send('overlay:init', {
      width: size.width,
      height: size.height,
      bitmap: image.toBitmap(),
      cssWidth: width,
      cssHeight: height,
    });
  });
  win.on('closed', () => {
    overlays = overlays.filter((o) => o !== entry);
    if (!overlays.length) capturing = false;
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    log('overlay renderer gone:', details.reason);
    closeOverlays();
  });
  win.on('unresponsive', () => {
    log('overlay unresponsive');
    closeOverlays();
  });
  win.loadFile(path.join(__dirname, 'src', 'overlay.html'));
  return entry;
}

// ---------- out-of-process watchdog (src/watchdog.js) ----------
// The failsafes below run inside the main process, so they can't help if the main process itself
// is stuck. The watchdog is a separate process that force-quits Capture if heartbeats stop.
let watchdog = null;
let heartbeat = null;

function startWatchdog() {
  try {
    watchdog = fork(path.join(__dirname, 'src', 'watchdog.js'), [], {
      execPath: process.execPath,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    watchdog.on('exit', (code) => { log('watchdog exited', code); watchdog = null; });
    watchdog.send({ logDir: app.getPath('userData') });
    log('watchdog started, pid', watchdog.pid);
  } catch (err) {
    log('watchdog failed to start:', String(err));
  }
}

function watchdogSend(msg) {
  try { if (watchdog && watchdog.connected) watchdog.send(msg); } catch { /* ignore */ }
}

function armWatchdog() {
  if (!watchdog) startWatchdog();
  watchdogSend({ type: 'arm' });
  clearInterval(heartbeat);
  heartbeat = setInterval(() => watchdogSend({ type: 'beat' }), 500);
}

function disarmWatchdog() {
  clearInterval(heartbeat);
  heartbeat = null;
  watchdogSend({ type: 'disarm' });
}

// ---------- failsafes: a capture screen must never trap the user ----------
const IDLE_CLOSE_MS = 60 * 1000; // close after a minute with no mouse or key input
const NO_INPUT_CLOSE_MS = 15 * 1000; // close if input never reaches the capture screen at all
const PING_EVERY_MS = 1500; // check that the capture screen still responds
const PING_TIMEOUT_MS = 2500;
let failsafe = null;

function armFailsafes() {
  disarmFailsafes();
  armWatchdog();
  const state = { opened: Date.now(), lastActivity: Date.now(), gotInput: false, timer: null, escape: false };
  // Global Esc works even when the capture screen does not have keyboard focus.
  try {
    state.escape = globalShortcut.register('Escape', () => handleGlobalEscape());
  } catch (err) {
    log('failsafe: global Esc failed:', String(err));
  }
  log('failsafe armed, global Esc =', state.escape);
  state.timer = setInterval(async () => {
    if (!overlays.length) { disarmFailsafes(); return; }
    if (!state.gotInput && Date.now() - state.opened > NO_INPUT_CLOSE_MS) {
      log('failsafe: no input reached the capture screen');
      closeOverlays();
      releaseFocus();
      return;
    }
    if (Date.now() - state.lastActivity > IDLE_CLOSE_MS) {
      log('failsafe: idle timeout');
      closeOverlays();
      releaseFocus();
      return;
    }
    for (const o of overlays) {
      if (o.win.isDestroyed() || !o.ready) continue;
      const answered = await Promise.race([
        o.win.webContents.executeJavaScript('1', false).then(() => true, () => false),
        new Promise((r) => setTimeout(() => r(false), PING_TIMEOUT_MS)),
      ]);
      if (!answered && overlays.includes(o)) {
        log('failsafe: capture screen stopped responding');
        closeOverlays();
        releaseFocus();
        return;
      }
    }
  }, PING_EVERY_MS);
  failsafe = state;
}

// Esc is taken globally while capturing, so the page never sees it. Let the focused capture
// screen handle it (finish text, close the palette, or cancel); if it does not answer, close everything.
async function handleGlobalEscape() {
  log('global Esc pressed');
  const target = overlays.find((o) => !o.win.isDestroyed() && o.win.isFocused()) || overlays.find((o) => o.focusMe) || overlays[0];
  let handled = false;
  if (target && !target.win.isDestroyed()) {
    handled = await Promise.race([
      target.win.webContents.executeJavaScript('typeof window.__captureEscape === "function" && window.__captureEscape()', true)
        .then((r) => r === true, () => false),
      new Promise((r) => setTimeout(() => r(false), 1000)),
    ]);
  }
  log('global Esc, handled by capture screen =', handled);
  if (!handled && overlays.length) {
    closeOverlays();
    releaseFocus();
  }
}

function disarmFailsafes() {
  disarmWatchdog();
  if (!failsafe) return;
  clearInterval(failsafe.timer);
  if (failsafe.escape) globalShortcut.unregister('Escape');
  failsafe = null;
}

ipcMain.on('overlay:input', (_e, what) => {
  if (!failsafe || typeof what !== 'string') return;
  failsafe.inputs = (failsafe.inputs || 0) + 1;
  if (failsafe.inputs <= 20) log('capture screen got', what.slice(0, 40));
});

ipcMain.on('overlay:activity', () => {
  if (!failsafe) return;
  if (!failsafe.gotInput) log('first input reached the capture screen');
  failsafe.gotInput = true;
  failsafe.lastActivity = Date.now();
});

function closeOverlays() {
  disarmFailsafes();
  const list = overlays;
  overlays = [];
  capturing = false;
  list.forEach((o) => { if (!o.win.isDestroyed()) o.win.destroy(); });
}

function overlayOf(e) {
  return overlays.find((o) => !o.win.isDestroyed() && o.win.webContents === e.sender);
}

ipcMain.on('overlay:ready', (e) => {
  const entry = overlayOf(e);
  if (!entry) return;
  entry.ready = true;
  log('overlay ready');
  if (!overlays.every((o) => o.ready)) return;
  armFailsafes();
  if (IS_MAC) app.focus({ steal: true });
  overlays.forEach((o) => {
    o.win.setBounds(o.display.bounds);
    o.win.show();
  });
  const main = overlays.find((o) => o.focusMe) || overlays[0];
  const focusMain = () => {
    if (main.win.isDestroyed()) return;
    if (IS_MAC) app.focus({ steal: true });
    main.win.moveTop();
    main.win.focus();
    main.win.webContents.focus();
  };
  focusMain();
  // macOS can hand focus back to the previous app; retry a few times until the capture screen has it.
  let tries = 0;
  const confirmFocus = () => {
    if (main.win.isDestroyed()) return;
    if (main.win.isFocused() || tries >= 5) {
      log('overlay shown, focused =', main.win.isFocused(), 'tries =', tries);
      return;
    }
    tries += 1;
    focusMain();
    setTimeout(confirmFocus, 80);
  };
  setTimeout(confirmFocus, 60);
});

ipcMain.on('overlay:cancel', (e) => {
  if (!overlayOf(e)) return;
  log('capture cancelled');
  closeOverlays();
  releaseFocus();
});

ipcMain.on('overlay:selection-start', (e) => {
  overlays.forEach((o) => {
    if (o.win.webContents !== e.sender && !o.win.isDestroyed()) o.win.webContents.send('overlay:clear');
  });
});

ipcMain.on('overlay:copy-text', (_e, text) => {
  if (typeof text === 'string') clipboard.writeText(text);
});

ipcMain.on('overlay:copy', (e, { png }) => {
  if (!overlayOf(e)) return;
  clipboard.writeImage(nativeImage.createFromBuffer(Buffer.from(png)));
  closeOverlays();
  releaseFocus();
});

ipcMain.on('overlay:save', async (e, { png, quick }) => {
  if (!overlayOf(e)) return;
  const buf = Buffer.from(png);
  closeOverlays();
  if (quick) {
    try {
      fs.mkdirSync(settings.saveDir, { recursive: true });
      const file = uniquePath(settings.saveDir, fileName('png'));
      fs.writeFileSync(file, buf);
      notify('Screenshot saved', path.basename(file), () => shell.showItemInFolder(file));
    } catch (err) {
      dialog.showErrorBox('Could not save screenshot', err.message);
    }
    releaseFocus();
    return;
  }
  await saveWithDialog(buf);
  releaseFocus();
});

ipcMain.on('overlay:pin', (e, { png, rect }) => {
  const entry = overlayOf(e);
  if (!entry) return;
  const b = entry.display.bounds;
  closeOverlays();
  createPin(Buffer.from(png), {
    x: Math.round(b.x + rect.x),
    y: Math.round(b.y + rect.y),
    w: Math.max(16, Math.round(rect.w)),
    h: Math.max(16, Math.round(rect.h)),
  });
});

// ---------- saving ----------

function fileName(ext) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${APP_NAME} ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} at `
    + `${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}.${ext}`;
}

function uniquePath(dir, name) {
  const { name: base, ext } = path.parse(name);
  let file = path.join(dir, name);
  let i = 2;
  while (fs.existsSync(file)) file = path.join(dir, `${base} (${i++})${ext}`);
  return file;
}

async function saveWithDialog(pngBuf) {
  try {
    if (IS_MAC) app.focus({ steal: true });
    const dir = settings.lastDir && fs.existsSync(settings.lastDir) ? settings.lastDir : settings.saveDir;
    fs.mkdirSync(dir, { recursive: true });
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Save screenshot',
      defaultPath: path.join(dir, fileName('png')),
      filters: [
        { name: 'PNG image', extensions: ['png'] },
        { name: 'JPEG image', extensions: ['jpg', 'jpeg'] },
      ],
    });
    if (canceled || !filePath) return;
    let target = filePath;
    let ext = path.extname(target).toLowerCase();
    if (!ext) { target += '.png'; ext = '.png'; }
    const out = ext === '.jpg' || ext === '.jpeg'
      ? nativeImage.createFromBuffer(pngBuf).toJPEG(92)
      : pngBuf;
    fs.writeFileSync(target, out);
    settings.lastDir = path.dirname(target);
    saveSettings();
  } catch (err) {
    dialog.showErrorBox('Could not save screenshot', err.message);
  }
}

// ---------- pinned images ----------

function createPin(png, r) {
  const win = new BrowserWindow({
    x: r.x, y: r.y, width: r.w, height: r.h,
    show: false,
    frame: false,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: true,
    backgroundColor: '#000000',
    title: `${APP_NAME} pin`,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.setAlwaysOnTop(true, 'floating');
  if (IS_MAC) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  win.setAspectRatio(r.w / r.h);
  win.setMenu(null);

  const id = win.webContents.id;
  pins.set(id, { win, png, baseW: r.w, baseH: r.h, drag: null });
  win.webContents.once('did-finish-load', () => {
    win.webContents.send('pin:init', { src: `data:image/png;base64,${png.toString('base64')}` });
  });
  win.once('ready-to-show', () => {
    win.setBounds({ x: r.x, y: r.y, width: r.w, height: r.h });
    if (IS_MAC) app.focus({ steal: true });
    win.show();
    win.focus();
  });
  win.on('closed', () => {
    pins.delete(id);
    buildMenu();
    releaseFocus();
  });
  win.loadFile(path.join(__dirname, 'src', 'pin.html'));
  buildMenu();
}

const pinOf = (e) => pins.get(e.sender.id);

ipcMain.on('pin:drag-start', (e) => {
  const p = pinOf(e);
  if (!p) return;
  p.drag = { bounds: p.win.getBounds(), cursor: screen.getCursorScreenPoint() };
});

ipcMain.on('pin:drag', (e) => {
  const p = pinOf(e);
  if (!p || !p.drag) return;
  const c = screen.getCursorScreenPoint();
  const { bounds, cursor } = p.drag;
  p.win.setBounds({
    x: bounds.x + c.x - cursor.x,
    y: bounds.y + c.y - cursor.y,
    width: bounds.width,
    height: bounds.height,
  });
});

ipcMain.on('pin:drag-end', (e) => {
  const p = pinOf(e);
  if (p) p.drag = null;
});

ipcMain.on('pin:zoom', (e, { dir }) => {
  const p = pinOf(e);
  if (!p) return;
  const b = p.win.getBounds();
  const factor = dir > 0 ? 1.1 : 1 / 1.1;
  const w = Math.round(Math.min(Math.max(b.width * factor, 40), p.baseW * 6));
  const h = Math.round((w * p.baseH) / p.baseW);
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  p.win.setBounds({ x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), width: w, height: h });
});

ipcMain.on('pin:copy', (e) => {
  const p = pinOf(e);
  if (p) clipboard.writeImage(nativeImage.createFromBuffer(p.png));
});

ipcMain.on('pin:close', (e) => {
  const p = pinOf(e);
  if (p) p.win.close();
});

ipcMain.on('pin:menu', (e) => {
  const p = pinOf(e);
  if (!p) return;
  const opacity = Math.round(p.win.getOpacity() * 100);
  Menu.buildFromTemplate([
    { label: 'Copy', click: () => clipboard.writeImage(nativeImage.createFromBuffer(p.png)) },
    { label: 'Save as…', click: () => saveWithDialog(p.png) },
    {
      label: 'Actual size',
      click: () => {
        const b = p.win.getBounds();
        p.win.setBounds({ x: b.x, y: b.y, width: p.baseW, height: p.baseH });
      },
    },
    {
      label: 'Opacity',
      submenu: [100, 80, 60, 40].map((v) => ({
        label: `${v}%`, type: 'radio', checked: opacity === v, click: () => p.win.setOpacity(v / 100),
      })),
    },
    { type: 'separator' },
    { label: 'Close', click: () => p.win.close() },
  ]).popup({ window: p.win });
});

// ---------- tray icon (drawn in code so there are no binary assets) ----------

function makeTrayIcon() {
  const size = 32;
  const buf = Buffer.alloc(size * size * 4);
  const [r, g, b] = IS_MAC ? [0, 0, 0] : [34, 163, 90]; // macOS: template (black); Windows: Capture green
  const a0 = 0.1; const z0 = 0.9; const t = 0.11; const L = 0.34;
  const hit = (u, v) => {
    const inU = u >= a0 && u <= z0;
    const inV = v >= a0 && v <= z0;
    const vertEdge = (u <= a0 + t || u >= z0 - t) && inU && inV && (v <= a0 + L || v >= z0 - L);
    const horzEdge = (v <= a0 + t || v >= z0 - t) && inU && inV && (u <= a0 + L || u >= z0 - L);
    const dx = u - 0.5; const dy = v - 0.5;
    return vertEdge || horzEdge || dx * dx + dy * dy <= 0.12 * 0.12;
  };
  const SS = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let cover = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          if (hit((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size)) cover++;
        }
      }
      const a = cover / (SS * SS);
      const i = (y * size + x) * 4;
      buf[i] = Math.round(b * a);
      buf[i + 1] = Math.round(g * a);
      buf[i + 2] = Math.round(r * a);
      buf[i + 3] = Math.round(255 * a);
    }
  }
  const img = nativeImage.createFromBitmap(buf, { width: size, height: size, scaleFactor: IS_MAC ? 2 : 1 });
  if (IS_MAC) img.setTemplateImage(true);
  return img;
}
