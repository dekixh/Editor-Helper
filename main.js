// main.js — Electron main process
// Owns the window, the catalog/state on disk, and all privileged operations
// (download, install, open folders). The renderer never touches Node directly.

const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const config = require('./core/config');
const logger = require('./core/logger');
const aePaths = require('./installer/aePaths');
const installer = require('./installer/installer');
const registry = require('./installer/registry');
const system = require('./installer/system');
const state = require('./core/state');
const server = require('./core/server');
const settings = require('./core/settings');
const updater = require('./core/updater');

let mainWindow = null;     // the app window (catalog + installer)
let cachedVersions = [];   // detected AE versions

// Resolve the BrowserWindow that owns a given webContents (sender). The window
// is frameless and the titlebar controls can come from the main window only,
// so act on whichever window sent the event — not a hard-coded
// global. Returns null if the window is already gone.
function winFromEvent(event) {
  return event && event.sender ? BrowserWindow.fromWebContents(event.sender) : null;
}

// Merge auto-detected AE versions with any the user added manually (persisted
// in settings). De-duped by Support Files path (case-insensitive).
function mergedVersions() {
  const detected = aePaths.detectVersions();
  const custom = settings.get().customAeVersions || [];
  const seen = new Set(detected.map((v) => v.supportFiles && v.supportFiles.toLowerCase()).filter(Boolean));
  const extra = custom.filter((v) => v.supportFiles && !seen.has(v.supportFiles.toLowerCase()));
  return detected.concat(extra);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0b0d12',
    frame: false,            // frameless: we draw our own titlebar in the UI
    resizable: true,
    maximizable: true,
    minimizable: true,
    show: false,             // shown once the first paint is ready (did-finish-load)
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));
  if (process.argv.includes('--dev')) mainWindow.webContents.openDevTools({ mode: 'detach' });

  // Sync the maximize/restore icon in the custom titlebar.
  const sendMaxState = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('win:maximizeChanged', mainWindow.isMaximized());
    }
  };
  mainWindow.on('maximize', sendMaxState);
  mainWindow.on('unmaximize', sendMaxState);
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
}

// Show the main app window. Called at startup. If it's already open, focus it.
function showMain() {
  if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.focus(); return; }
  createWindow();
}

// ----------------------------------------------------------------------------
// IPC handlers
// ----------------------------------------------------------------------------

// --- Window controls (custom frameless titlebar) ---
// Act on whichever window sent the event (main OR login share these controls).
ipcMain.on('win:minimize', (e) => { const w = winFromEvent(e); if (w) w.minimize(); });
ipcMain.on('win:maximizeToggle', (e) => {
  const w = winFromEvent(e); if (!w) return;
  if (w.isMaximized()) w.unmaximize(); else w.maximize();
});
ipcMain.on('win:close', (e) => { const w = winFromEvent(e); if (w) w.close(); });
ipcMain.handle('win:isMaximized', (e) => { const w = winFromEvent(e); return !!(w && w.isMaximized()); });

/**
 * Load the catalog from the configured server (no auth). Falls back to the
 * bundled local catalog on any network/server error.
 */
async function loadServerCatalog() {
  const s = settings.get();
  if (!s.serverUrl) {
    const { plugins } = config.loadConfig();
    return { plugins, source: 'local' };
  }
  try {
    const raw = await server.fetchCatalog(s.serverUrl);
    const { plugins } = config.normalizeCatalog(raw);
    return { plugins, source: 'server' };
  } catch (e) {
    logger.error(`server fetch failed: ${e.message}; falling back to local catalog`);
    const { plugins } = config.loadConfig();
    return { plugins, source: 'local', warning: `Сервер недоступен — показан локальный каталог (${e.message})` };
  }
}

// Return the catalog + detected AE versions + statuses.
//
// Source policy: the local bundled catalog (config/plugins.json) is the
// default and always works offline. If a server URL is configured in settings,
// prefer it and fall back to the local catalog if the request fails.
ipcMain.handle('app:init', async () => {
  cachedVersions = mergedVersions();
  const base = { versions: cachedVersions, activeVersion: cachedVersions[0] || null, state: state.read() };
  const cat = await loadServerCatalog();
  return { ok: true, ...cat, ...base };
});

// Re-detect AE versions only.
ipcMain.handle('app:detectVersions', async () => {
  cachedVersions = mergedVersions();
  return { versions: cachedVersions };
});

// Scan the PC for already-installed plugins/scripts/apps. Clears the registry
// cache so the next status checks re-read the registry, and re-detects AE.
ipcMain.handle('app:scanPc', async () => {
  try {
    registry.invalidateCache();
    cachedVersions = mergedVersions();
    return { ok: true, versions: cachedVersions };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Compute status for a single plugin under a chosen AE version.
ipcMain.handle('app:status', async (_e, { plugin, version }) => {
  try { return { ok: true, ...(await installer.checkStatus(plugin, version)) }; }
  catch (e) { return { ok: false, status: 'not-installed', detail: e.message }; }
});

// Bulk status: compute every plugin's status in one pass. All run-mode checks
// share a single async (non-blocking) registry scan, and copy/both checks run
// concurrently — so a full startup sweep is ONE IPC round-trip + ONE reg scan
// instead of N serial blocking calls. This is the startup fast path; the UI
// must never block waiting on the main process. Returns { id -> status } map.
ipcMain.handle('app:statusAll', async (_e, { plugins, version }) => {
  try { return { ok: true, statuses: await installer.checkStatusAll(plugins || [], version) }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// Cheap registry membership probe for run-mode apps. The downloaded installer
// installs in its own window after we launch it; the renderer polls this until
// the app's uninstall entry actually appears in the registry (so the UI keeps
// saying "Устанавливается…" while the real install runs, instead of jumping to
// "Установлено" the moment the installer window opens). Returns the matching
// DisplayName or null. Async (non-blocking) registry scan — uses the 10s cache.
ipcMain.handle('app:findApp', async (_e, { name }) => {
  try { return (await registry.findInstalledApp(name)) || null; }
  catch (_) { return null; }
});

// Install a plugin. Streams progress back to the renderer via events.
ipcMain.handle('app:install', async (event, { plugin, version }) => {
  const sender = event.sender;
  try {
    const result = await installer.install(plugin, version, (frac, phase, extra) => {
      sender.send('install:progress', { id: plugin.id, frac, phase, received: extra && extra.received, total: extra && extra.total });
    });
    return { ok: true, ...result };
  } catch (e) {
    logger.error(`Install ${plugin.id} failed: ${e.message}`);
    // A user-cancelled download is reported as cancelled so the UI can show a
    // "Загрузка отменена" toast instead of a red error.
    const cancelled = !!(e && e.kind === 'cancelled');
    return { ok: false, cancelled, error: e.message };
  }
});

// Cancel an in-flight download for a plugin (aborts the AbortController in the
// installer). Returns true if something was cancelled, false if there was no
// active download for that id.
ipcMain.handle('app:cancelInstall', (_e, { id }) => {
  try { return { ok: true, cancelled: installer.cancelDownload(id) }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// Launch an already-installed program (run / both modes). copy-mode plugins are
// not launchable. Resolves the exe from installs.json (both) or the registry
// DisplayIcon / InstallLocation (run), then runs it via the OS shell.
ipcMain.handle('app:launchApp', async (_e, { plugin, version }) => {
  try { const r = await installer.launchInstalled(plugin, version); return { ok: true, ...r }; }
  catch (e) { logger.error(`Launch ${plugin.id} failed: ${e.message}`); return { ok: false, error: e.message }; }
});

// Uninstall. Async: run-mode may spawn an elevated PowerShell one-shot.
ipcMain.handle('app:uninstall', async (_e, { plugin, version }) => {
  try { const r = await installer.uninstall(plugin, version); return { ok: true, ...r }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// Whether the launched program for a plugin is currently running (so the UI can
// show "Закрыть" instead of "Запустить"). Resolves the same target .exe as
// launchApp and checks for a matching OS process. Non-blocking.
ipcMain.handle('app:isRunning', async (_e, { plugin, version }) => {
  try { return { ok: true, ...(await installer.isAppRunning(plugin, version)) }; }
  catch (e) { return { ok: false, running: false, target: null }; }
});

// Close (terminate) the running program for a plugin. Kills the matching
// process(es) by PID. Used by the "Закрыть" button.
ipcMain.handle('app:closeApp', async (_e, { plugin, version }) => {
  try { return { ok: true, ...(await installer.closeApp(plugin, version)) }; }
  catch (e) { logger.error(`Close ${plugin.id} failed: ${e.message}`); return { ok: false, error: e.message }; }
});

// Relaunch the app elevated (UAC prompt) — generic manual fallback, kept for
// future use. Not used by the uninstall flow (which elevates only the removal).
ipcMain.handle('app:relaunchElevated', async () => {
  try { return { ok: system.relaunchElevated() }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// Open a folder in the OS file explorer.
ipcMain.handle('app:openFolder', async (_e, { folder }) => {
  try {
    if (!folder) return { ok: false, error: 'No folder specified' };
    if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
    shell.openPath(folder);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Open a known AE folder (Scripts / Plug-ins / etc.) for the active version.
ipcMain.handle('app:openAeFolder', async (_e, { version, kind }) => {
  try {
    let dir;
    if (kind === 'scripts') dir = path.join(version.userFolder || '', 'Scripts', 'ScriptUI Panels');
    else if (kind === 'plugins') dir = path.join(version.supportFiles || '', 'Plug-ins');
    else if (kind === 'presets') dir = path.join(version.supportFiles || '', 'Presets');
    else dir = version.supportFiles || version.userFolder;
    if (!dir || !fs.existsSync(path.dirname(dir))) return { ok: false, error: 'Folder not found for this AE version.' };
    fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Open the Applications folder (companion .exe apps), AE-independent.
ipcMain.handle('app:openAppsFolder', async () => {
  try {
    const dir = aePaths.appsFolder();
    fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Re-load the catalog (server if configured, else local; fall back to local).
ipcMain.handle('app:reloadConfig', async () => {
  const cat = await loadServerCatalog();
  return { ok: true, ...cat, state: state.read() };
});

// Client settings (server URL).
ipcMain.handle('app:getSettings', () => settings.get());
ipcMain.handle('app:setSettings', (_e, patch) => settings.write(patch || {}));
// Synchronous read so the preload can apply the persisted UI theme before the
// first paint (avoids a dark→light flash for light-theme users).
ipcMain.on('app:getSettingsSync', (e) => { e.returnValue = settings.get(); });
ipcMain.handle('app:testServer', async (_e, { serverUrl }) => {
  if (!serverUrl) return { ok: false, error: 'Укажите адрес сервера' };
  try { await server.ping(serverUrl); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// Config file: where it lives (editable), open it for editing, reset to default.
ipcMain.handle('app:configPath', () => { config.ensureConfig(); return config.configFile(); });
ipcMain.handle('app:openConfig', async () => {
  try { config.ensureConfig(); shell.showItemInFolder(config.configFile()); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('app:resetConfig', () => {
  try { config.resetConfig(); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// Manually point the app at an After Effects install when auto-detection fails
// (e.g. AE on a non-standard drive). The user picks a folder; we accept either
// the "Support Files" dir (contains AfterFX.exe) or the version root that has
// a "Support Files" subfolder. The resulting version is persisted in settings.
ipcMain.handle('app:pickAeFolder', async () => {
  try {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Выберите папку After Effects',
      properties: ['openDirectory'],
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    const dir = res.filePaths[0];

    let supportFiles = null;
    if (fs.existsSync(path.join(dir, 'AfterFX.exe'))) supportFiles = dir;
    else if (fs.existsSync(path.join(dir, 'Support Files', 'AfterFX.exe'))) supportFiles = path.join(dir, 'Support Files');
    if (!supportFiles) {
      return { ok: false, error: 'В папке нет AfterFX.exe. Выберите папку «Support Files» (где лежит AfterFX.exe) или корневую папку «Adobe After Effects <год>».' };
    }

    // Derive a year/label from a "Adobe After Effects <N>" path segment.
    let year = null;
    const m = dir.match(/Adobe After Effects\s*(\d{2,4})/i);
    if (m) { let n = parseInt(m[1], 10); if (n < 100) n += 2000; year = n; }
    const version = year ? `After Effects ${year}` : 'After Effects (добавлено вручную)';

    // userFolder (Roaming) if present — used for Scripts (no admin). Optional.
    const userBase = path.join(app.getPath('appData'), 'Adobe', 'After Effects');
    let userFolder = year ? path.join(userBase, String(year)) : null;
    if (userFolder && !fs.existsSync(userFolder)) {
      // try internal-version folder name, e.g. 26.0 for AE 2026
      try {
        for (const ent of fs.readdirSync(userBase)) {
          if (parseInt(ent.split('.')[0], 10) === (year - 2000)) { userFolder = path.join(userBase, ent); break; }
        }
      } catch (_) {}
    }
    if (userFolder && !fs.existsSync(userFolder)) userFolder = null;

    const ver = { version, year, supportFiles, userFolder };

    // Persist, de-duped by supportFiles (case-insensitive).
    const cur = settings.get().customAeVersions || [];
    const lower = supportFiles.toLowerCase();
    if (!cur.some((v) => v.supportFiles && v.supportFiles.toLowerCase() === lower)) {
      cur.push(ver);
      settings.write({ customAeVersions: cur });
    }
    cachedVersions = mergedVersions();
    return { ok: true, version: ver, versions: cachedVersions };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Open the log file / folder.
ipcMain.handle('app:openLogs', async () => {
  try { await shell.openPath(logger.logFile()); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('app:logs', async () => ({ lines: logger.recent() }));
ipcMain.handle('app:clearLogs', async () => { logger.clear(); return { ok: true }; });

// ── App self-update (GitHub Releases) ────────────────────────────────────────
// On startup (and on demand from Settings) we check the latest release of
// settings.update.repo. If a newer version exists, the renderer asks the user;
// on confirm we download the new portable exe and hand off to a detached
// PowerShell helper that swaps the launcher and relaunches (see core/updater.js).
let _updateState = null; // { latest } while awaiting the user's confirmation

function sendUpdate(ch, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ch, payload);
}

async function checkAndPromptUpdate(manual) {
  const repo = (settings.get().update && settings.get().update.repo || '').trim();
  if (!repo) {
    if (manual) sendUpdate('update:error', { error: 'Репозиторий не задан (owner/repo)' });
    return;
  }
  if (manual) sendUpdate('update:status', { text: 'Проверка…' });
  let res;
  try {
    res = await updater.checkForUpdate(repo);
  } catch (e) {
    logger.error(`Update check failed: ${e.message}`);
    if (manual) sendUpdate('update:error', { error: e.message });
    return;
  }
  if (!res.available) {
    if (manual) sendUpdate('update:up-to-date', { current: res.current.join('.') });
    return;
  }
  _updateState = { latest: res.latest };
  sendUpdate('update:available', {
    version: res.latest.version.join('.'),
    tag: res.latest.tag,
    name: res.latest.name,
    notes: res.latest.notes,
    size: res.latest.size,
    manual,
  });
}

async function performUpdate() {
  if (!_updateState || !_updateState.latest) return;
  const latest = _updateState.latest;
  _updateState = null;
  const tmpPath = path.join(os.tmpdir(), `Editor-Helper-update-${latest.tag}.exe`);
  sendUpdate('update:status', { text: 'Загрузка обновления…', phase: 'download' });
  try {
    await updater.downloadAsset(latest.downloadUrl, tmpPath, (frac, received, total) => {
      sendUpdate('update:progress', { frac, received, total });
    });
  } catch (e) {
    logger.error(`Update download failed: ${e.message}`);
    sendUpdate('update:error', { error: 'Загрузка не удалась: ' + e.message });
    return;
  }
  sendUpdate('update:status', { text: 'Установка… программа перезапустится', phase: 'install' });
  try {
    updater.installAndRelaunch(tmpPath);
    // Quit so the helper can replace the launcher and relaunch the new version.
    setTimeout(() => app.exit(0), 500);
  } catch (e) {
    sendUpdate('update:error', { error: 'Установка не удалась: ' + e.message });
  }
}

ipcMain.handle('update:check', async () => { await checkAndPromptUpdate(true); return { ok: true }; });
ipcMain.handle('update:confirm', async (_e, accept) => {
  if (accept) await performUpdate();
  else _updateState = null;
  return { ok: true };
});

// ----------------------------------------------------------------------------
app.whenReady().then(async () => {
  // Startup: open the app window directly (no login).
  showMain();

  // Live-reload: when the user edits the config file, re-read it and push the
  // updated catalog to the renderer without restarting.
  config.watchConfig(() => {
    logger.info('Config file changed — reloading catalog');
    const { plugins } = config.loadConfig();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('catalog:updated', plugins);
    }
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) showMain();
  });

  // Auto-check for a new version shortly after launch (silent unless an update
  // is found — then the renderer prompts the user). Errors are logged only.
  setTimeout(() => { checkAndPromptUpdate(false).catch((e) => logger.error(`auto-update: ${e.message}`)); }, 2000);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});