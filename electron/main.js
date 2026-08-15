// token-tool desktop shell (Electron main process, ESM).
//
// Wraps the existing zero-dependency loopback server + vanilla web UI into a
// menu-bar-resident app on macOS and a system-tray app on Windows/Linux.
//
//   • The Node server from src/server.js runs in-process (same Electron Node),
//     bound to 127.0.0.1 on an ephemeral port, session token and host allowlist
//     fully intact. The renderer loads the authenticated URL over loopback.
//   • A Tray icon is the entry point. Hovering or left-clicking shows a
//     borderless popover BrowserWindow anchored to the icon; on blur or when
//     the cursor leaves both the popover and the icon, it hides — standard
//     menu-bar-app behavior. Right click shows a context menu (open main
//     window / refresh / open in browser / quit).
//   • Windows/Linux: the first launch also opens the real, framed main window
//     so the app is visible without a tray interaction; tray double-click
//     re-opens it, and closing it keeps the app running in the tray.
//   • macOS: dock hidden + LSUIElement (set by electron-builder) so the app
//     lives only in the menu bar.

import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  nativeTheme,
  shell,
  screen,
  session,
} from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../src/server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'assets');

const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';

const POPOVER_WIDTH = 400;
const POPOVER_HEIGHT = IS_MAC ? 700 : 720;

// Match the CSS --bg so the borderless window doesn't flash the wrong colour
// before the page paints. The UI follows prefers-color-scheme; nativeTheme
// tracks the same OS colour scheme, so the two stay in sync.
function windowBackground() {
  try {
    return nativeTheme.shouldUseDarkColors ? '#0b0f17' : '#f6f7f9';
  } catch {
    return '#0b0f17';
  }
}

let tray = null;
let popover = null;
let mainWin = null;
let serverHandle = null;
let quitting = false;

// ---- auto-hide plumbing ----------------------------------------------------
// The popover should dismiss itself when the pointer leaves both the window
// and the tray icon for a moment — standard tray-popover behaviour — and also
// on blur (clicking elsewhere). Both paths are debounced/cancelable so a tray
// click (which momentarily blurs the window) doesn't fight the toggle.
let pendingHide = null;
let proximityTimer = null;
let pendingShow = null; // hover-show pending (debounced)
let pendingClickToggle = null; // deferred tray-click toggle (Windows/Linux)

function cancelPendingHide() {
  if (pendingHide) { clearTimeout(pendingHide); pendingHide = null; }
}

function cancelPendingShow() {
  if (pendingShow) { clearTimeout(pendingShow); pendingShow = null; }
}

function scheduleHide(delayMs) {
  cancelPendingHide();
  pendingHide = setTimeout(() => {
    pendingHide = null;
    if (quitting || !popover || !popover.isVisible()) return;
    // Don't hide if the cursor is back over the popover or the tray icon —
    // e.g. it left the tray and is now over the popover itself.
    if (cursorOverPopoverOrTray()) return;
    popover.hide();
  }, delayMs);
}

// Show the popover after a short hover dwell — avoids flashing on a mouse
// sweep across the tray. If already visible, this is a no-op.
function scheduleShow(delayMs = 250) {
  cancelPendingHide(); // a hover cancels any pending hide
  cancelPendingShow();
  pendingShow = setTimeout(() => {
    pendingShow = null;
    if (!quitting && popover && !popover.isVisible()) {
      const b = popoverBoundsFor(tray, POPOVER_WIDTH, POPOVER_HEIGHT);
      popover.setBounds(b);
      popover.show();
      popover.focus();
    }
  }, delayMs);
}

// Is the cursor currently over the popover window or the tray icon (with a
// small margin so the edge doesn't feel twitchy)?
function cursorOverPopoverOrTray() {
  if (!popover || !tray) return true; // safe default: don't dismiss
  const pt = screen.getCursorScreenPoint();
  const win = popover.getBounds();
  const margin = 12;
  const overWin =
    pt.x >= win.x - margin && pt.x <= win.x + win.width + margin &&
    pt.y >= win.y - margin && pt.y <= win.y + win.height + margin;
  return overWin || cursorOverTray();
}

// Is the cursor over the tray icon? Windows occasionally reports empty tray
// bounds (right after a DPI/taskbar change, or for icons in the overflow
// flyout), which would make the proximity watch treat a hovered icon as
// "outside" and dismiss the popover for no reason. When bounds are empty,
// fall back to the taskbar strip next to the popover's anchor — on Windows the
// tray lives at the bottom edge of the display.
function cursorOverTray() {
  const pt = screen.getCursorScreenPoint();
  const tb = tray.getBounds();
  const margin = 12;
  if (tb && tb.width > 0) {
    return (
      pt.x >= tb.x - margin && pt.x <= tb.x + tb.width + margin &&
      pt.y >= tb.y - margin && pt.y <= tb.y + tb.height + margin
    );
  }
  if (IS_MAC) return false; // macOS bounds are reliable; empty means unknown
  const wa = screen.getDisplayNearestPoint({ x: pt.x, y: pt.y }).workArea;
  const stripTop = wa.y + wa.height; // top edge of the taskbar
  const anchorX =
    popover && popover.isVisible() ? popover.getBounds().x + POPOVER_WIDTH / 2 : pt.x;
  return (
    pt.y >= stripTop - 4 && pt.y <= stripTop + 64 &&
    Math.abs(pt.x - anchorX) <= 140
  );
}

// Poll the cursor while the popover is visible; hide once it has been outside
// both zones for two consecutive checks (~700 ms), so a brief excursion while
// reaching for a control doesn't dismiss the window.
function startProximityWatch() {
  stopProximityWatch();
  let outsideCount = 0;
  proximityTimer = setInterval(() => {
    if (!popover || !popover.isVisible()) {
      stopProximityWatch();
      return;
    }
    if (cursorOverPopoverOrTray()) {
      outsideCount = 0;
    } else {
      outsideCount += 1;
      if (outsideCount >= 2) {
        popover.hide();
        stopProximityWatch();
      }
    }
  }, 350);
}

function stopProximityWatch() {
  if (proximityTimer) { clearInterval(proximityTimer); proximityTimer = null; }
}

// ---- icons -----------------------------------------------------------------
function trayIconPath() {
  // macOS uses a template image (monochrome, adapts to light/dark menu bar).
  // Windows/Linux use a colored icon.
  if (IS_MAC) return path.join(ASSETS, 'trayTemplate@2x.png');
  return path.join(ASSETS, 'tray-win.png');
}

function buildTrayIcon() {
  const img = nativeImage.createFromPath(trayIconPath());
  if (IS_MAC) {
    img.setTemplateImage(true);
    return img.resize({ height: 20, quality: 'best' });
  }
  return img.resize({ width: 20, height: 20, quality: 'best' });
}

// ---- popover positioning ---------------------------------------------------
// Place the popover neatly under (macOS) or above (Windows) the tray icon,
// clamped to the work area of the display the icon sits on.
function popoverBoundsFor(trayRef, width, height) {
  const tb = trayRef.getBounds();
  const anchorX = tb.width > 0 ? tb.x + tb.width / 2 : screen.getCursorScreenPoint().x;
  const anchorY = tb.height > 0 ? tb.y : screen.getCursorScreenPoint().y;
  const anchorH = tb.height || 0;
  const display = screen.getDisplayNearestPoint({ x: anchorX, y: anchorY });
  const wa = display.workArea;

  let x = Math.round(anchorX - width / 2);
  x = Math.max(wa.x + 6, Math.min(x, wa.x + wa.width - width - 6));

  let y;
  if (IS_MAC) {
    // Menu bar at top: open just below the icon.
    y = Math.round(anchorY + anchorH + 4);
  } else {
    // System tray at bottom: open above the icon; fall back to below if no room.
    y = Math.round(anchorY - height - 6);
    if (y < wa.y + 6) y = Math.round(anchorY + anchorH + 6);
  }
  y = Math.max(wa.y + 6, Math.min(y, wa.y + wa.height - height - 6));
  return { x, y, width, height };
}

// ---- shared window hardening ----------------------------------------------
// Both the popover and the main window load the same loopback app; apply the
// same diagnostics and security plumbing to each.
function hardenWindow(wc) {
  // Forward renderer console messages and load failures to the main log so the
  // desktop shell is debuggable from the CLI.
  wc.on('console-message', (event) => {
    const tag = ['log', 'warn', 'error'][event.level] || 'log';
    console.log(`[renderer:${tag}] ${event.message}`);
  });
  wc.on('did-fail-load', (_e, code, desc, url) => {
    // Log the URL WITHOUT the query string — the launch URL carries the
    // per-launch session token (?token=…) and must never reach logs.
    let safeUrl = url;
    try { safeUrl = url.split('?')[0]; } catch { /* keep as-is */ }
    console.log(`[renderer:did-fail-load] ${code} ${desc} ${safeUrl}`);
  });
  wc.on('render-process-gone', (_e, details) => {
    console.log(`[renderer:gone] ${details?.reason}`);
  });

  // External links (console links, etc.) open in the system browser, never in
  // a new Electron window.
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Refuse navigation away from the loopback app origin. Uses URL parsing and
  // an exact protocol+hostname+port comparison — a string startsWith on the
  // base (http://127.0.0.1:<port>) is bypassable via userinfo
  // (http://127.0.0.1:<port>@evil.com/), hostname-suffix, or port-glue tricks.
  wc.on('will-navigate', (event, url) => {
    try {
      const u = new URL(url);
      const b = new URL(serverHandle.base);
      const sameOrigin = u.protocol === b.protocol && u.hostname === b.hostname && u.port === b.port;
      if (!sameOrigin) event.preventDefault();
    } catch {
      event.preventDefault(); // unparseable → refuse
    }
  });
}

// ---- popover window --------------------------------------------------------
function createPopover() {
  const common = {
    width: POPOVER_WIDTH,
    height: POPOVER_HEIGHT,
    show: false,
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    backgroundColor: windowBackground(),
    roundedCorners: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  };

  const macOpts = IS_MAC
    ? {
        transparent: false,
        vibrancy: 'under-window',
        visualEffectState: 'active',
        hiddenInset: true,
        visibleOnAllWorkspaces: true,
        hasShadow: true,
      }
    : {};

  popover = new BrowserWindow({ ...common, ...macOpts });

  hardenWindow(popover.webContents);

  // Hide on blur — menu-bar / tray popover semantics. Debounced (not instant)
  // so a tray click, which blurs the window for an instant, can cancel the hide
  // and toggle instead. The proximity watch below also hides on mouse-leave.
  popover.on('blur', () => {
    if (!quitting && popover && popover.isVisible()) scheduleHide(150);
  });

  popover.on('show', () => { cancelPendingHide(); startProximityWatch(); });
  popover.on('hide', () => {
    cancelPendingHide();
    stopProximityWatch();
    // Dismissing the popover returns to the board: close any open settings
    // modal so the next show (hover or click) displays the dashboard, not the
    // stale key-config screen. Best-effort; ignore if the renderer is gone.
    try {
      popover.webContents.executeJavaScript(
        `document.getElementById('modal') && document.getElementById('modal').classList.add('hidden'); void 0;`,
      ).catch(() => {});
    } catch { /* ignore */ }
  });

  popover.on('closed', () => {
    popover = null;
    stopProximityWatch();
    cancelPendingHide();
    cancelPendingShow();
  });

  // Inject a couple of desktop niceties once the page is ready.
  popover.webContents.on('did-finish-load', () => {
    applyDesktopUiTweaks(popover.webContents, 'popover');
  });

  popover.loadURL(serverHandle.launchUrl);
}

// Small runtime tweaks so the browser-oriented UI feels native in the shell.
// The popover (mode 'popover') hides the browser-only footer and rounds its
// corners; the framed main window (mode 'window') keeps the footer. We tag
// <html> with a data attribute so CSS can adapt.
function applyDesktopUiTweaks(wc, mode) {
  const css = mode === 'popover'
    ? `
        html[data-env="desktop"] .footer { display: none; }   /* browser-only note */
        html[data-env="desktop"] body { border-radius: 10px; }
      `
    : '';
  if (css) wc.insertCSS(css).catch(() => {});
  const env = mode === 'popover' ? 'desktop' : 'desktop-window';
  wc.executeJavaScript(
    `document.documentElement.dataset.env = '${env}'; void 0;`,
  ).catch(() => {});
}

// Refresh the live data in-place (clicks the page's Refresh button) in every
// open window, without a full reload.
function refreshWindow(wc) {
  wc.executeJavaScript(
    `document.getElementById('refresh') && document.getElementById('refresh').click(); true;`,
  ).catch(() => wc.reload());
}

function refreshData() {
  if (popover && !popover.isDestroyed()) refreshWindow(popover.webContents);
  if (mainWin && !mainWin.isDestroyed()) refreshWindow(mainWin.webContents);
}

// ---- tray ------------------------------------------------------------------
function buildContextMenu() {
  const items = [];
  if (!IS_MAC) {
    // Windows/Linux have a real main window; macOS is menu-bar-only.
    items.push({ label: 'Open main window', click: () => showMainWindow() });
  }
  items.push({ label: 'Refresh data', click: () => refreshData() });
  items.push({
    label: 'Open in browser',
    click: () => shell.openExternal(serverHandle.launchUrl).catch(() => {}),
  });
  items.push({ type: 'separator' });
  items.push({ label: 'Quit token-tool', click: () => quit() });
  return Menu.buildFromTemplate(items);
}

function createTray() {
  tray = new Tray(buildTrayIcon());
  tray.setToolTip('token-tool — AI subscriptions & usage');

  // Hovering the tray icon proactively shows the popover (after a short dwell
  // so a sweeping mouse doesn't flash it open). Moving away hides it (handled
  // by the proximity watch). Left click still toggles for explicit control.
  // Hovering ALWAYS shows — if the settings modal is open when the popover is
  // dismissed, it's auto-closed on hide so the next show returns to the board.
  // Both mouse-enter and mouse-move trigger the show: on Windows a stationary
  // cursor over the icon (or one that lands without a follow-up move event)
  // otherwise never fires a show, which made the hover preview appear at
  // random.
  const hoverShow = () => {
    if (popover && popover.isVisible()) {
      cancelPendingHide(); // re-hovering cancels a pending dismiss
    } else {
      scheduleShow(250);
    }
  };
  tray.on('mouse-enter', hoverShow);
  tray.on('mouse-move', hoverShow);
  tray.on('mouse-leave', () => {
    cancelPendingShow();
    if (popover && popover.isVisible()) scheduleHide(400);
  });

  // Left click toggles the popover. On Windows/Linux the toggle is deferred
  // briefly so a double-click can win and open the main window instead —
  // otherwise a double-click fires click→click→double-click and flashes the
  // popover open then shut.
  tray.on('click', () => {
    cancelPendingShow();
    cancelPendingHide();
    if (IS_MAC) {
      togglePopover();
      return;
    }
    if (pendingClickToggle) clearTimeout(pendingClickToggle);
    pendingClickToggle = setTimeout(() => {
      pendingClickToggle = null;
      togglePopover();
    }, 260);
  });
  // Double-click re-opens the main window (Windows/Linux only).
  if (!IS_MAC) {
    tray.on('double-click', () => {
      if (pendingClickToggle) { clearTimeout(pendingClickToggle); pendingClickToggle = null; }
      showMainWindow();
    });
  }
  // Right click shows the context menu (Open main window / Refresh / Open in
  // browser / Quit).
  tray.on('right-click', () => {
    if (pendingClickToggle) { clearTimeout(pendingClickToggle); pendingClickToggle = null; }
    tray.popUpContextMenu(buildContextMenu());
  });
}

function togglePopover() {
  cancelPendingShow();
  cancelPendingHide();
  if (!popover) createPopover();
  if (popover.isVisible()) {
    popover.hide();
    return;
  }
  const b = popoverBoundsFor(tray, POPOVER_WIDTH, POPOVER_HEIGHT);
  popover.setBounds(b);
  popover.show();
  popover.focus();
}

// ---- main window (Windows/Linux) -------------------------------------------
// macOS is menu-bar-only, so the main window only exists on Windows/Linux. The
// first launch opens it (via openMainWindowOnStartup) so the app has a visible
// surface without a tray interaction; tray double-click re-opens it; closing it
// keeps the app alive in the tray.
function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 980,
    height: 760,
    minWidth: 640,
    minHeight: 480,
    show: false,
    title: 'token-tool',
    backgroundColor: windowBackground(),
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  hardenWindow(mainWin.webContents);

  mainWin.once('ready-to-show', () => {
    if (!quitting && mainWin) mainWin.show();
  });

  // Closing the main window keeps the app running in the tray.
  mainWin.on('closed', () => { mainWin = null; });
  mainWin.on('focus', () => {
    if (pendingClickToggle) { clearTimeout(pendingClickToggle); pendingClickToggle = null; }
  });

  mainWin.webContents.on('did-finish-load', () => {
    applyDesktopUiTweaks(mainWin.webContents, 'window');
  });

  mainWin.loadURL(serverHandle.launchUrl);
}

function showMainWindow() {
  if (!mainWin) createMainWindow();
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show();
  mainWin.focus();
}

// ---- DeepSeek auth login ---------------------------------------------------
// Opens a login window for platform.deepseek.com. When the user logs in, the
// SPA writes the session token to localStorage under "userToken" (JSON shape
// {value: "<token>", __version: "0"}). We poll that key and resolve the token.
// Runs in an IN-MORY session partition so captured tokens/cookies never persist
// to disk — the token is carried over via the 0600 config.json instead.

function openDeepSeekLogin() {
  return new Promise((resolve) => {
    const LOGIN_URL = 'https://platform.deepseek.com/sign_in';
    let resolved = false;
    let pollTimer = null;
    let failSafe = null;
    let win = null; // declared before finish() so it's never in TDZ

    const finish = (token) => {
      if (resolved) return;
      resolved = true;
      if (pollTimer) clearInterval(pollTimer);
      if (failSafe) clearTimeout(failSafe);
      try { if (win && !win.isDestroyed()) win.close(); } catch { /* ignore */ }
      resolve(token);
    };

    // The login window runs in its own partition, so the defaultSession
    // permission handlers (registered in bootstrap) do NOT cover it — deny
    // everything here too.
    const loginSession = session.fromPartition('deepseek-login');
    loginSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    loginSession.setPermissionCheckHandler(() => false);

    win = new BrowserWindow({
      width: 480,
      height: 760,
      title: 'DeepSeek Login · token-tool',
      backgroundColor: '#0b0f17',
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        session: loginSession,
      },
    });

    win.loadURL(LOGIN_URL).catch(() => {
      if (!resolved) finish(null);
    });

    win.on('closed', () => finish(null));

    // Poll localStorage for the userToken. The SPA writes it after redirecting
    // to /usage on successful login. We read it from the renderer's page world.
    const grabToken = () => win.webContents.executeJavaScript(
      `(function(){ try { const r = localStorage.getItem('userToken'); if(!r) return null; const v = JSON.parse(r).value; return v || null; } catch(e){ return null; } })()`,
    ).catch(() => null);

    pollTimer = setInterval(async () => {
      if (win.isDestroyed()) { finish(null); return; }
      const token = await grabToken();
      if (token && token.length > 10) finish(token);
    }, 800);

    win.webContents.on('did-finish-load', async () => {
      // Immediate check after load — the user may already be logged in.
      const token = await grabToken();
      if (token && token.length > 10) finish(token);
    });

    // Failsafe: auto-resolve null after 5 minutes (cleared on early finish).
    failSafe = setTimeout(() => finish(null), 5 * 60 * 1000);
  });
}

// ---- app lifecycle ---------------------------------------------------------
function quit() {
  quitting = true;
  app.quit();
}

async function bootstrap() {
  // Single instance — a second launch just focuses the existing popover.
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }
  app.on('second-instance', () => {
    // A second launch surfaces the app: the main window on Windows/Linux, the
    // popover on macOS (menu-bar-only). Ignore if startup hasn't finished —
    // the first launch path already surfaces a window.
    if (!serverHandle) return;
    if (IS_MAC) {
      if (popover && !popover.isVisible()) togglePopover();
    } else {
      showMainWindow();
    }
  });

  await app.whenReady();

  // Harden the default session: block permission prompts entirely (the app
  // needs no device permissions), and pin external navigations to openExternal.
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  session.defaultSession.setPermissionCheckHandler(() => false);

  // Inject a strict Content-Security-Policy on every document the renderer
  // loads. The page only ever talks to its own loopback origin; inline styles
  // are used for meter widths (locally computed from trusted data), so
  // 'unsafe-inline' is scoped to style-src only.
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    const csp = [
      "default-src 'self'",
      "img-src 'self' data:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self'",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join('; ');
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    });
  });

  if (IS_MAC) {
    // Live in the menu bar only — never appear in the Dock.
    try {
      app.dock.hide();
    } catch {
      /* older Electron */
    }
  }
  if (IS_WIN) {
    app.setAppUserModelId('app.token-tool');
  }

  // Start the embedded loopback server with the DeepSeek auth-login handler.
  serverHandle = await createServer({
    host: '127.0.0.1',
    port: 0,
    authLoginHandlers: { deepseek: openDeepSeekLogin },
  });
  console.log(`token-tool: server at ${serverHandle.base} (embedded)`);
  if (process.env.TOKEN_TOOL_AUTO_SHOW === '1') {
    console.log(`token-tool: launch url ${serverHandle.launchUrl}`);
  }

  createTray();
  createPopover();

  // On Windows/Linux the first launch shows the real, framed main window so the
  // app has a visible surface without requiring a tray interaction (the tray
  // icon alone — with no tooltip content — reads as "nothing is showing").
  if (!IS_MAC) showMainWindow();

  // Verification helper: in dev, auto-reveal the popover so the rendered UI can
  // be captured/screenshotted without a manual tray click. Harmless in prod —
  // the popover still hides on blur and re-opens on tray click.
  if (process.env.TOKEN_TOOL_AUTO_SHOW === '1') {
    setTimeout(() => togglePopover(), 800);
  }

  app.on('activate', () => {
    // macOS: re-open popover when the user clicks the icon / re-activates.
    if (popover && !popover.isVisible()) togglePopover();
  });
}

// Keep running in the tray when the popover is closed; only quit explicitly.
app.on('window-all-closed', (e) => {
  e.preventDefault();
});

app.on('before-quit', async (e) => {
  if (pendingClickToggle) { clearTimeout(pendingClickToggle); pendingClickToggle = null; }
  if (serverHandle) {
    e.preventDefault();
    try {
      await serverHandle.stop();
    } catch {
      /* ignore */
    }
    // Re-issue the quit now that the server is down.
    quitting = true;
    app.exit(0);
  }
});

bootstrap().catch((err) => {
  console.error('token-tool: fatal', err?.stack || err);
  app.quit();
});
