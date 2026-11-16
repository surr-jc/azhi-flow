import { app, BrowserWindow, dialog, Menu, nativeImage, shell, Tray } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, type WriteStream } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createState, notify, startBackground, type Session } from './background';

/**
 * The desktop shell. It shows the web UI and nothing else: the backend (server, Temporal dev server,
 * worker) is the same compiled `azhi up` code, started as a child process under a bundled real Node
 * (src/local/sidecar.ts). Keeping it out of Electron's process means a busy worker cannot freeze the
 * window, and the places that start `process.execPath` get Node, not another copy of this app.
 */
const win32 = process.platform === 'win32';
const packaged = app.isPackaged;
// Packaged: electron-builder puts these under resources/. In development: build/app (npm run build:app)
// and desktop/resources (npm run fetch-runtime) next to this package.
const appRoot = packaged ? join(process.resourcesPath, 'app') : join(__dirname, '..', '..', 'build', 'app');
const resources = packaged ? process.resourcesPath : join(__dirname, '..', 'resources');
const exe = (name: string) => (win32 ? `${name}.exe` : name);

const bundledNode = join(resources, 'node', exe('node'));
const bundledTemporal = join(resources, 'temporal', exe('temporal'));
const azhiHome = process.env.AZHI_HOME ?? join(homedir(), '.azhi');
const logPath = join(azhiHome, 'local', 'desktop.log');

let backend: ChildProcess | undefined;
let ready = false;
let quitting = false;
let logStream: WriteStream | undefined;
let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let session: Session | undefined;
const state = createState(join(azhiHome, 'local', 'desktop-state.json'));
const iconPath = join(__dirname, '..', 'assets', 'icon.png');

const SPLASH =
  'data:text/html;charset=utf-8,' +
  encodeURIComponent(
    '<!doctype html><meta charset="utf-8"><title>Azhi Flow</title><style>' +
      ':root{color-scheme:light dark}body{margin:0;height:100vh;display:grid;place-items:center;' +
      'font:15px system-ui,sans-serif;background:Canvas;color:CanvasText}p{opacity:.7}</style>' +
      '<div><h2>Azhi Flow</h2><p>Starting the local server&hellip;</p></div>',
  );

function openLog(): WriteStream {
  mkdirSync(join(azhiHome, 'local'), { recursive: true });
  return createWriteStream(logPath, { flags: 'a' });
}

/** Starts the sidecar and resolves with the local URL and owner token once it reports ready. */
function startBackend(): Promise<{ url: string; token: string }> {
  return new Promise((resolve, reject) => {
    const node = existsSync(bundledNode) ? bundledNode : packaged ? '' : (process.env.AZHI_DESKTOP_NODE ?? 'node');
    if (!node) return reject(new Error(`The bundled Node is missing (${bundledNode}). Reinstall the app.`));
    const sidecar = join(appRoot, 'src', 'local', 'sidecar.js');
    if (!existsSync(sidecar)) return reject(new Error(`The backend is missing (${sidecar}); run npm run build:app.`));

    logStream = openLog();
    logStream.write(`\n--- ${new Date().toISOString()} starting ${node} ${sidecar}\n`);
    const env: NodeJS.ProcessEnv = { ...process.env };
    // The bundled Temporal CLI (already checksum-verified at build time); without it the backend downloads one.
    if (existsSync(bundledTemporal)) env.AZHI_TEMPORAL_BIN = bundledTemporal;
    delete env.ELECTRON_RUN_AS_NODE;

    const child = spawn(node, [sidecar], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true, env, cwd: appRoot });
    backend = child;
    child.stdout?.pipe(logStream, { end: false });
    child.stderr?.pipe(logStream, { end: false });
    child.on('message', (m: { type?: string; url?: string; token?: string; message?: string }) => {
      if (m.type === 'ready' && m.url && m.token) {
        ready = true;
        resolve({ url: m.url, token: m.token });
      } else if (m.type === 'error') {
        reject(new Error(m.message ?? 'The backend did not start'));
      }
    });
    child.once('error', (e) => reject(new Error(`Cannot start ${node}: ${e.message}`)));
    child.once('exit', (code, signal) => {
      backend = undefined;
      logStream?.write(`--- backend exited (${signal ?? code})\n`);
      if (!ready) reject(new Error(`The backend stopped before it was ready (${signal ?? `exit ${code}`}). Details: ${logPath}`));
      else if (!quitting) {
        dialog.showErrorBox('Azhi Flow stopped', `The local server exited unexpectedly (${signal ?? `exit ${code}`}).\nDetails: ${logPath}`);
        app.exit(1);
      }
    });
  });
}

/** Asks the sidecar to stop (it closes the worker, server and Temporal), then makes sure it has. */
function stopBackend(): Promise<void> {
  const child = backend;
  if (!child) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // already gone
      }
    }, 30_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      child.send({ type: 'shutdown' });
    } catch {
      child.kill();
    }
  });
}

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Azhi Flow',
    backgroundColor: '#ffffff',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  w.setMenuBarVisibility(false);
  // Closing the window keeps the app (and so schedules and approvals) running in the tray; Quit stops it.
  w.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    w.hide();
    if (!state.get('trayHintShown')) {
      state.set({ trayHintShown: true });
      notify('Azhi Flow is still running', 'Schedules and approvals keep working. Use the tray icon to open it again or quit.');
    }
  });
  void w.loadURL(SPLASH);
  return w;
}

/** Brings the window back, optionally on another page of the local UI (the token handoff is repeated). */
function showWindow(path?: string) {
  const w = mainWindow;
  if (!w) return;
  if (path && session) void w.loadURL(`${session.origin}${path}#token=${encodeURIComponent(session.token)}`);
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
}

function createTray() {
  const size = process.platform === 'darwin' ? 18 : 16;
  tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: size, height: size }));
  tray.setToolTip('Azhi Flow');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Azhi Flow', click: () => showWindow() },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]),
  );
  tray.on('click', () => showWindow());
}

/** The window may only show the local server; anything else opens in the default browser. */
function lockNavigation(w: BrowserWindow, origin: string) {
  const external = (url: string) => {
    try {
      const u = new URL(url);
      if (u.protocol === 'http:' || u.protocol === 'https:') void shell.openExternal(u.toString());
    } catch {
      // not a URL: ignore
    }
  };
  w.webContents.on('will-navigate', (e, url) => {
    if (new URL(url).origin === origin) return;
    e.preventDefault();
    external(url);
  });
  w.webContents.setWindowOpenHandler(({ url }) => {
    external(url);
    return { action: 'deny' };
  });
}

async function launch() {
  mainWindow = createWindow();
  mainWindow.on('closed', () => (mainWindow = undefined));
  try {
    const { url, token } = await startBackend();
    const origin = new URL(url).origin;
    lockNavigation(mainWindow, origin);
    // The token rides in the URL fragment, which is never sent to the server (same handoff as `azhi open`).
    await mainWindow.loadURL(`${origin}/ui#token=${encodeURIComponent(token)}`);
    session = { origin, token };
    createTray();
    startBackground(session, { show: showWindow }, state);
  } catch (err) {
    dialog.showErrorBox('Azhi Flow could not start', (err as Error).message);
    quitting = true;
    await stopBackend();
    app.exit(1);
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.on('activate', () => showWindow());
  app.on('before-quit', (e) => {
    quitting = true;
    if (!backend) return;
    // Hold the quit until the backend has stopped cleanly (it flushes the database and Temporal).
    e.preventDefault();
    void stopBackend().then(() => app.quit());
  });
  // The tray keeps the app alive when the last window is hidden; there is nothing to do here.
  app.on('window-all-closed', () => {});
  app.setAppUserModelId('dev.azhiflow.desktop');
  void app.whenReady().then(launch);
}
