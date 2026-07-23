// installer/installer.js
// Orchestrates the full install pipeline for one plugin. Three install modes
// (from config `installMode`, per-plugin or per-version):
//   "copy" — download the file and place it into installPath (default).
//   "run"  — download the file and execute it as a standalone installer; the
//            installer places its own files. No destination folder needed.
//   "both" — copy the file to installPath AND run it (e.g. drop a portable app
//            into the Applications folder and launch it).
//
// Archives: if the downloaded file is a .zip/.7z/.rar/.tar/.gz (detected by
// magic bytes, regardless of extension), it is extracted first. The payload to
// install is the file or folder inside the archive named exactly `plugin.fileName`
// (case-insensitive). That entry is what gets copied/run. So `fileName` is the
// name of the installed entry, and must match an entry inside the archive.
// Also exposes status checks and "uninstall".

const fs = require('fs');
const path = require('path');
const os = require('os');
const { shell } = require('electron');
const child_process = require('child_process');

const aePaths = require('./aePaths');
const downloader = require('../core/downloader');
const archiver = require('../core/archiver');
const registry = require('./registry');
const system = require('./system');
const state = require('../core/state');
const installs = require('../core/installs');
const logger = require('../core/logger');

const TMP_DIR = path.join(os.tmpdir(), 'editor-helper-lite');

// AbortControllers for in-flight downloads, keyed by plugin id, so the UI can
// cancel a download via cancelDownload(id). Removed in install() once the
// download settles — so cancel after the download phase is a safe no-op.
const _activeDownloads = new Map();

// The category-root folder for an installPath — the "never delete here or above"
// boundary. Uninstall may remove files and empty subfolders *below* this, but
// never the category root itself (e.g. never delete "Plug-ins", only a plugin
// folder we created inside it). For a plain category like "Scripts" the root
// IS the resolved dir, so we don't delete the AE's own Scripts folder.
function categoryRoot(version, installPath) {
  const norm = (installPath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const first = norm.split('/')[0] || norm;
  try { return aePaths.resolveInstallDir(version, first).dir; }
  catch (_) { return null; }
}

/**
 * Check whether a plugin (specific version) is currently installed.
 *
 * The `plugin` object passed in must already carry the selected version's
 * fields (version, fileName, installPath, installMode) — the renderer merges
 * those before calling.
 *
 * @returns {Promise<{status:'installed'|'not-installed'|'update-available', detail:string, installedVersion:string|null}>}
 */
async function checkStatus(plugin, version) {
  const rec = state.get(plugin.id);
  const mode = (plugin.installMode || 'copy').toLowerCase();
  const instVer = rec ? rec.version : null;

  // "run": no managed file — detect via the Windows registry (so apps the user
  // installed outside this app still show as installed), falling back to our
  // own state record for run-mode installers that don't register an uninstaller.
  // The registry scan is async + cached, so a status sweep shares ONE scan.
  if (mode === 'run') {
    const match = (plugin.uninstallName || plugin.name || '').trim();
    let regName = null;
    if (match) {
      try { regName = await registry.findInstalledApp(match); }
      catch (_) {}
    }
    if (regName) {
      // The application is present on the computer.
      if (rec && rec.version && plugin.version && rec.version !== plugin.version) {
        return { status: 'update-available', detail: `Установлено: ${regName} · выбрано v${plugin.version}`, installedVersion: instVer };
      }
      return { status: 'installed', detail: `Установлено: ${regName}`, installedVersion: instVer };
    }
    if (rec) {
      if (rec.version && plugin.version && rec.version !== plugin.version) {
        return { status: 'update-available', detail: `v${rec.version} запускался · выбрано v${plugin.version}`, installedVersion: instVer };
      }
      return { status: 'installed', detail: 'Установщик запускался', installedVersion: instVer };
    }
    return { status: 'not-installed', detail: 'Не установлено', installedVersion: null };
  }

  // "copy" / "both": verify the file on disk under installPath.
  let resolved;
  try { resolved = aePaths.resolveInstallDir(version, plugin.installPath); }
  catch (e) { return { status: 'not-installed', detail: e.message, installedVersion: instVer }; }

  const target = path.join(resolved.dir, plugin.fileName);
  const fileExists = fs.existsSync(target);
  if (fileExists) {
    if (rec && rec.version && plugin.version && rec.version !== plugin.version) {
      return { status: 'update-available', detail: `v${rec.version} установлено · выбрано v${plugin.version}`, installedVersion: instVer };
    }
    return { status: 'installed', detail: `Установлено: ${target}`, installedVersion: instVer };
  }
  return { status: 'not-installed', detail: 'Не установлено', installedVersion: null };
}

/**
 * Compute statuses for many plugins in one pass. All run-mode checks share a
 * single (cached) async registry scan — so instead of N blocking reg queries
 * we do ONE non-blocking scan, and the copy/both checks (fast fs.existsSync)
 * run concurrently alongside it. Returns a { id -> status } map. Used by the
 * startup status sweep so the UI never blocks on the main process.
 */
async function checkStatusAll(plugins, version) {
  const results = await Promise.all(plugins.map(async (p) => {
    try { return { id: p.id, st: await checkStatus(p, version) }; }
    catch (e) { return { id: p.id, st: { status: 'not-installed', detail: e.message, installedVersion: null } }; }
  }));
  const map = {};
  for (const r of results) map[r.id] = r.st;
  return map;
}

/**
 * Execute a downloaded file as a standalone installer (uses the OS shell so
 * .exe/.msi installers can trigger UAC elevation on their own).
 */
async function runInstaller(filePath) {
  // shell.openPath launches with the default action — runs .exe, invokes
  // msiexec for .msi via file association, etc. Triggers UAC if the installer
  // requires elevation.
  const err = await shell.openPath(filePath);
  if (err) throw new Error(`Не удалось запустить установщик (${path.basename(filePath)}): ${err}`);
  logger.info(`Launched installer: ${filePath}`);
}

/**
 * Cancel an in-flight download for a plugin id (if one is running). Aborts the
 * AbortController registered in install(); the download promise then rejects
 * with a DownloadError(kind:'cancelled') and install() returns that to the UI.
 * Returns true if a download was aborted, false if there was nothing to cancel
 * (e.g. the download already finished or hasn't started).
 */
function cancelDownload(id) {
  const ac = _activeDownloads.get(id);
  if (!ac) return false;
  try { ac.abort(); } catch (_) {}
  logger.info(`Download cancelled by user: ${id}`);
  return true;
}

/**
 * Resolve the launchable .exe path for an installed program ("run" / "both"
 * modes) WITHOUT launching it. Shared by launchInstalled / isAppRunning /
 * closeApp so they all agree on which process to track. "copy" mode is not a
 * launchable program, so it throws.
 *
 * Resolution order:
 *   1. both mode — the exact path we copied is recorded in installs.json
 *      (paths[0]); if it's a folder, find the .exe inside it.
 *   2. registry DisplayIcon for the app (usually "C:\path\app.exe,0").
 *   3. MAIN .exe found under the registry InstallLocation (not a helper).
 *   4. After Effects itself — AfterFX.exe in the detected AE version's Support
 *      Files (Adobe's uninstall entry has an empty InstallLocation + .ico icon).
 * Throws if nothing launchable is found.
 */
async function resolveLaunchTarget(plugin, version) {
  const mode = (plugin.installMode || 'copy').toLowerCase();
  if (mode === 'copy') throw new Error('Запуск не поддерживается для этого элемента (это не программа).');

  // 1. both mode: the copied payload path is tracked.
  if (mode === 'both') {
    const rec = installs.get(plugin.id);
    let target = rec && Array.isArray(rec.paths) ? rec.paths[0] : null;
    if (target && fs.existsSync(target)) {
      if (fs.statSync(target).isDirectory()) target = archiver.findExe(target);
      if (target && fs.existsSync(target) && /\.exe$/i.test(target)) return target;
    }
    // recorded path gone (user moved it?) — fall through to registry lookup.
  }

  // 2 + 3. run mode (and both fallback): resolve from the registry.
  const match = (plugin.uninstallName || plugin.name || '').trim();
  if (!match) throw new Error('Не указано имя программы для поиска в реестре.');
  const info = await registry.findLaunchInfo(match);
  if (!info) throw new Error('Программа не найдена в реестре. Возможно, установка не завершена.');

  // DisplayIcon: "C:\path\app.exe" or "C:\path\app.exe,0" — strip the icon index.
  if (info.displayIcon) {
    let icon = info.displayIcon.replace(/^"|"$/g, '').trim();
    icon = icon.replace(/,\s*\d+\s*$/, '').trim();
    icon = icon.replace(/^"|"$/g, '').trim();
    if (icon && fs.existsSync(icon) && /\.exe$/i.test(icon)) return icon;
  }

  // InstallLocation: find the MAIN .exe in it (not the first arbitrary helper).
  if (info.installLocation && fs.existsSync(info.installLocation)) {
    const exe = findMainExe(info.installLocation, match);
    if (exe) return exe;
  }

  // Adobe's own After Effects uninstall entry has an EMPTY InstallLocation and
  // a DisplayIcon that is an .ico (not an .exe), so the registry can't point us
  // at the real executable. But this app already detected the AE install — the
  // selected AE version's Support Files has AfterFX.exe. Use it when the plugin
  // being launched is After Effects itself.
  if (version && version.supportFiles && /after effects/i.test(match)) {
    const aeExe = path.join(version.supportFiles, 'AfterFX.exe');
    if (fs.existsSync(aeExe)) return aeExe;
    // Last resort: scan the AE Support Files folder for a launchable exe.
    const exe = findMainExe(version.supportFiles, match);
    if (exe) return exe;
  }

  throw new Error('Не найден .exe для запуска. Установочная папка неизвестна.');
}

/**
 * Launch an already-installed program ("run" / "both" modes). Resolves the
 * target .exe (shared with isAppRunning/closeApp) and runs it via the OS shell.
 */
async function launchInstalled(plugin, version) {
  const target = await resolveLaunchTarget(plugin, version);
  const err = await shell.openPath(target);
  if (err) throw new Error(`Не удалось запустить: ${err}`);
  logger.info(`Launched: ${target}`);
  return { launched: target };
}

// --- Process tracking for the "Запустить" → "Закрыть" toggle ---------------
// Find the OS process IDs running a given .exe. Matches by image name AND full
// ExecutablePath (case-insensitive); processes whose ExecutablePath can't be
// read (protected/system) are matched by name alone. Async + non-blocking.
function getProcPids(target) {
  const name = path.basename(target);
  const want = target.replace(/'/g, "''");
  const filter = `Name='${name.replace(/'/g, "''")}'`;
  const ps =
    `Get-CimInstance Win32_Process -Filter "${filter}" | ` +
    `ForEach-Object { if (-not $_.ExecutablePath -or $_.ExecutablePath -ieq '${want}') { $_.ProcessId } }`;
  return new Promise((resolve) => {
    child_process.execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 2 * 1024 * 1024,
    }, (e, stdout) => {
      if (e) return resolve([]);
      const pids = String(stdout).split(/\r?\n/)
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n) && n > 0);
      resolve(pids);
    });
  });
}

/**
 * Whether the launched program for this plugin is currently running. Resolves
 * the same target .exe as launchInstalled, then checks for a matching process.
 * Returns { running: boolean, target: string|null }.
 */
async function isAppRunning(plugin, version) {
  let target;
  try { target = await resolveLaunchTarget(plugin, version); }
  catch (_) { return { running: false, target: null }; }
  if (!target) return { running: false, target: null };
  const pids = await getProcPids(target);
  return { running: pids.length > 0, target };
}

/**
 * Close (terminate) the running program for this plugin. Kills the matching
 * process(es) by PID. Returns { closed: boolean, target: string|null }.
 */
async function closeApp(plugin, version) {
  let target;
  try { target = await resolveLaunchTarget(plugin, version); }
  catch (e) { return { closed: false, target: null, error: e.message }; }
  const pids = await getProcPids(target);
  if (!pids.length) return { closed: true, target, alreadyGone: true };
  const name = path.basename(target);
  const pidList = pids.join(',');
  const ps = `Get-Process -Id ${pidList} -ErrorAction SilentlyContinue | Stop-Process -Force; "done"`;
  await new Promise((resolve) => {
    child_process.execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      windowsHide: true, timeout: 15000,
    }, () => resolve());
  });
  logger.info(`Closed app "${name}" (pid ${pidList})`);
  return { closed: true, target };
}

// Search a folder for the MAIN application .exe — not the first arbitrary
// helper/background binary. Collects all .exe candidates (BFS, depth-capped so
// we don't walk huge trees), then scores them: heavily penalize known helper /
// updater / crash-handler processes, reward names that share a word with the
// app, and otherwise prefer the largest file (main app exes dwarf helpers).
// Returns an absolute path or null.
function findMainExe(dir, appMatch) {
  const HELPER = /(ccxprocess|cclibrary|adobeupdate|adobeipc|adobearm|adobedesktopservice|node|crashprocessor|crashhandler|logtransport|acrobatslicer|updater|helper|installer|uninstaller|elevation|cleanup|support|bridge|gpusniffer|welcome|login|notification|adobe\.com)/i;
  let stack = [dir];
  let seen = 0;
  const MAX = 4000;
  const cands = [];
  while (stack.length && seen < MAX) {
    const cur = stack.shift();
    seen++;
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); }
    catch (_) { continue; }
    for (const ent of entries) {
      if (ent.isFile() && /\.exe$/i.test(ent.name)) {
        let size = 0;
        try { size = fs.statSync(path.join(cur, ent.name)).size; } catch (_) {}
        cands.push({ full: path.join(cur, ent.name), name: ent.name, size });
      }
    }
    for (const ent of entries) {
      if (ent.isDirectory()) stack.push(path.join(cur, ent.name));
    }
  }
  if (!cands.length) return null;
  const STOP = new Set(['adobe', 'inc', 'the', 'cc', 'autodesk', 'corp', 'llc']);
  const tokens = (appMatch || '')
    .toLowerCase()
    .split(/[^a-zа-я0-9]+/)
    .filter((t) => t.length > 2 && !STOP.has(t) && !/^20\d\d$/.test(t));
  let best = null, bestScore = -Infinity;
  for (const c of cands) {
    const low = c.name.toLowerCase();
    let score = c.size;
    if (HELPER.test(low)) score -= 1e12;
    if (tokens.some((t) => low.includes(t))) score += 1e12;
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return best ? best.full : null;
}

/**
 * Install a plugin for a given AE version according to its installMode.
 * @param {object} plugin   catalog entry (already resolved to a version)
 * @param {object} version  AE version entry (from aePaths.detectVersions)
 * @param {(p:number, phase:string, extra?:{received:number,total:number|null})=>void} onProgress
 */
async function install(plugin, version, onProgress) {
  const mode = (plugin.installMode || 'copy').toLowerCase();
  // version may be null for AE-independent installs (run mode / Applications).
  const aeVerLabel = version ? version.version : '(no AE)';
  logger.info(`Install start: ${plugin.name} (${plugin.id}) mode=${mode} -> ${aeVerLabel}`);

  // Reinstall path: if a previous install of this plugin is recorded, remove
  // its tracked files first (copy/both only — run-mode is re-run, not cleaned),
  // so reinstalling never leaves stale files behind. Errors are non-fatal.
  if (mode !== 'run') {
    const old = installs.get(plugin.id);
    if (old && Array.isArray(old.paths) && old.paths.length) {
      const r = { removed: [], missing: [], errors: [], cleaned: [] };
      for (const p of old.paths) removePath(p, r);
      cleanEmptyParents(old.paths, old.boundary, r);
      if (r.removed.length) logger.info(`Reinstall cleanup: removed ${r.removed.length} old file(s) for ${plugin.id}`);
    }
  }

  // 1. Download to temp. Forward received/total so the UI can show speed.
  //    An AbortController is registered for this plugin id so the UI can cancel
  //    an in-flight download (cancelDownload); it is removed once the download
  //    settles (resolved or rejected) — cancellation after that point is a no-op.
  if (onProgress) onProgress(0, 'downloading');
  const ac = new AbortController();
  _activeDownloads.set(plugin.id, ac);
  let downloaded;
  try {
    downloaded = await downloader.downloadPlugin(plugin, TMP_DIR, (frac, received, total) => {
      if (onProgress) onProgress(frac, 'downloading', { received, total });
    }, ac.signal);
  } finally {
    _activeDownloads.delete(plugin.id);
  }

  // 2. If the download is an archive, extract it and locate the payload entry
  //    (a file or folder named plugin.fileName) inside the tree. If not an
  //    archive, the downloaded file itself is the payload.
  let payloadPath = downloaded;
  let payloadIsDir = false;
  const fmt = archiver.detectArchive(downloaded);
  if (fmt) {
    if (onProgress) onProgress(0, 'unpacking');
    logger.info(`Downloaded file is a ${fmt} archive — extracting`);
    const extractDir = path.join(TMP_DIR, `extract-${plugin.id}`);
    fs.rmSync(extractDir, { recursive: true, force: true });
    try {
      await archiver.extract(downloaded, extractDir);
    } catch (e) {
      fs.rmSync(downloaded, { force: true });
      throw e;
    }
    fs.rmSync(downloaded, { force: true }); // archive no longer needed; work off extracted

    if (mode === 'run') {
      // run mode: the archive wraps an installer — find the .exe inside and run it.
      const exe = archiver.findExe(extractDir);
      if (!exe) throw new Error('Архив распакован, но в нём нет .exe для запуска. Проверьте содержимое архива.');
      payloadPath = exe;
      payloadIsDir = false;
      logger.info(`Archive run payload (.exe): ${exe}`);
    } else {
      // copy/both: locate the file or folder named plugin.fileName inside the archive.
      const payload = archiver.resolvePayload(extractDir, plugin.fileName);
      if (!payload) {
        throw new Error(
          `Архив распакован, но в нём нет файла или папки «${plugin.fileName}». ` +
          `Проверьте, что поле «Имя файла» совпадает с именем внутри архива.`
        );
      }
      payloadPath = payload.path;
      payloadIsDir = payload.kind === 'dir';
      logger.info(`Archive payload resolved (${payload.kind}): ${payloadPath}`);
    }
  } else {
    payloadIsDir = fs.existsSync(payloadPath) && fs.statSync(payloadPath).isDirectory();
  }

  if (mode === 'run') {
    // 2a. Run the payload (the installer). If it's a folder (from an archive),
    //     find the .exe inside it.
    let runPath = payloadPath;
    if (payloadIsDir) {
      const exe = archiver.findExe(payloadPath);
      if (!exe) throw new Error('В архиве не найден .exe для запуска.');
      runPath = exe;
    }
    if (onProgress) onProgress(1, 'running');
    await runInstaller(runPath);
    state.markInstalled(plugin, version, TMP_DIR);
    // run-mode: no managed files (the installer places its own files; we track
    // them via the registry uninstaller instead), so record with empty paths.
    installs.record(plugin, version, [], null, TMP_DIR);
    logger.success(`Installer launched for ${plugin.name}: ${runPath}`);
    if (onProgress) onProgress(1, 'done');
    return { destFile: runPath, mode };
  }

  // 2b. "copy" / "both": place the payload (file or folder) into installPath.
  if (onProgress) onProgress(0, 'installing');
  const resolved = aePaths.resolveInstallDir(version, plugin.installPath);
  const destDir = resolved.dir;
  const destFile = path.join(destDir, plugin.fileName);

  try { fs.mkdirSync(destDir, { recursive: true }); }
  catch (e) {
    if (resolved.needsAdmin) {
      throw new Error(`Cannot create "${destDir}". Plug-ins/Presets install to Program Files and require running this app as Administrator. (${e.message})`);
    }
    throw new Error(`Cannot create destination folder "${destDir}": ${e.message}`);
  }

  try {
    fs.rmSync(destFile, { recursive: true, force: true }); // removes a file or pre-existing folder
    if (payloadIsDir) {
      fs.cpSync(payloadPath, destFile, { recursive: true });
    } else {
      fs.copyFileSync(payloadPath, destFile); // copy+unlink for cross-volume safety
    }
  } catch (e) {
    if (resolved.needsAdmin) {
      throw new Error(`Cannot write to "${destFile}". Run this app as Administrator to install Plug-ins/Presets. (${e.message})`);
    }
    throw new Error(`Failed to place file at "${destFile}": ${e.message}`);
  }
  if (!fs.existsSync(destFile)) throw new Error('Install verification failed — file not present after copy.');

  if (mode === 'both') {
    // 2c. Also launch the copied payload. For a folder payload, find the .exe.
    if (onProgress) onProgress(1, 'running');
    try {
      let runPath = destFile;
      if (payloadIsDir) {
        const exe = archiver.findExe(destFile);
        if (exe) runPath = exe;
        else logger.warn('both mode + folder payload: no .exe to run, skipping launch');
      }
      if (!payloadIsDir || runPath !== destFile) await runInstaller(runPath);
    } catch (e) { logger.warn(`Copy succeeded but launcher failed: ${e.message}`); /* still mark installed */ }
  }

  state.markInstalled(plugin, version, destDir);
  installs.record(plugin, version, [destFile], categoryRoot(version, plugin.installPath), destDir);
  logger.success(`Installed ${plugin.name} -> ${destFile}`);
  if (onProgress) onProgress(1, 'done');
  return { destFile, needsAdmin: resolved.needsAdmin, mode };
}

// --- Uninstall helpers --------------------------------------------------------

// Delete one path (file or folder). Records the outcome in `result` rather
// than throwing, so a single locked file doesn't abort the whole removal.
//   missing  — path didn't exist (already removed or never installed)
//   removed  — deleted successfully
//   errors   — busy/locked/no-access etc., with a human-readable message
function removePath(p, result) {
  if (!p) return;
  if (!fs.existsSync(p)) { result.missing.push(p); return; }
  try {
    fs.rmSync(p, { recursive: true, force: true });
    result.removed.push(p);
  } catch (e) {
    const code = e && e.code;
    let msg;
    if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || code === 'ELOCKED') {
      msg = 'файл занят или нет доступа (закройте After Effects и повторите)';
    } else if (code === 'ENOTEMPTY') {
      msg = 'папка содержит чужие файлы — оставлена';
    } else {
      msg = e.message || String(e);
    }
    result.errors.push({ path: p, message: msg, code });
  }
}

// After deleting tracked files, remove empty parent folders *strictly below*
// the category boundary — i.e. only folders we created during install. Stops
// at the boundary (never deletes "Plug-ins"/"Scripts"/etc.) and never goes above.
function cleanEmptyParents(paths, boundary, result) {
  if (!boundary) return;
  const b = path.resolve(boundary);
  for (const p of paths) {
    let dir = path.dirname(path.resolve(p));
    let guard = 0;
    while (dir && path.resolve(dir) !== b && isStrictlyBelow(dir, b) && guard++ < 16) {
      let entries;
      try { entries = fs.readdirSync(dir); } catch (_) { break; }
      if (entries.length > 0) break;        // not empty -> other files live here, stop
      try { fs.rmdirSync(dir); result.cleaned.push(dir); }   // rmdirSync only removes empty dirs
      catch (_) { break; }
      dir = path.dirname(dir);
    }
  }
}

function isStrictlyBelow(dir, root) {
  const rel = path.relative(root, dir);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// Parse a Windows command line (a registry UninstallString) into [exe, args[]]
// while respecting quotes. Quotes are stripped from tokens; a quoted segment
// with spaces stays one token (e.g. --productName="After Effects" becomes the
// single arg --productName=After Effects). This lets us spawn the uninstaller
// WITHOUT a shell, which avoids the cmd /d /s /c outer-quote-wrapping that
// corrupts commands containing embedded quotes (Adobe's HDBox Uninstaller,
// MSIs, etc.).
function parseCmdLine(s) {
  const tokens = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') { inQ = !inQ; continue; }
    if ((ch === ' ' || ch === '\t') && !inQ) { if (cur !== '') { tokens.push(cur); cur = ''; } continue; }
    cur += ch;
  }
  if (cur !== '') tokens.push(cur);
  return tokens;
}

// Launch the app's OWN registered uninstaller and wait briefly to see whether
// it actually runs. We run the launch from an ELEVATED PowerShell (via
// system.runElevatedPowerShell) so an admin-manifest uninstaller does NOT
// re-elevate — if it did, `Start-Process -PassThru` would lose its handle to
// the elevated instance and WaitForExit would report an instant exit (false
// "did nothing"). From an already-elevated context the process is tracked
// reliably.
//
// Why we detect instead of fire-and-forget: some uninstallers (notably Adobe's
// HDBox Uninstaller) launch, exit with code 0 within ~1-2 s, and remove
// NOTHING — they only work when orchestrated by Creative Cloud. A blind
// "launched" toast would say success while the program is still installed. So
// we wait WAIT_MS: if the uninstaller is still alive then its UI is up and the
// user finishes removal there; if it exited on its own it did nothing and the
// caller falls back to direct removal.
//
// Returns { status: 'running' | 'noop' | 'failed', exitCode }.
const UNINSTALLER_WAIT_MS = 5000;
async function launchUninstaller(cmd) {
  const tokens = parseCmdLine(cmd);
  if (!tokens.length) return { status: 'failed', error: 'empty uninstall command' };
  const exe = tokens[0];
  const args = tokens.slice(1);
  // Rebuild args as ONE properly-quoted string so a spaced arg (e.g.
  // --productName=After Effects) survives Start-Process -ArgumentList as a
  // single token. parseCmdLine stripped the original quotes; we re-add double
  // quotes only around tokens that contain whitespace.
  const argStr = args.map((a) => (/\s/.test(a) ? '"' + a + '"' : a)).join(' ');
  const body =
    `$p = Start-Process -FilePath ${psq(exe)}${argStr ? ' -ArgumentList ' + psq(argStr) : ''} -PassThru\n` +
    `if ($p) {\n` +
    `  if (-not $p.WaitForExit(${UNINSTALLER_WAIT_MS})) { $removed += 'RUNNING' }\n` +
    `  else { $removed += 'NOOP'; $missing += ('' + $p.ExitCode) }\n` +
    `} else { $errors += 'LAUNCH_FAILED' }`;
  const er = await system.runElevatedPowerShell(body);
  if (!er || !er.result) return { status: 'failed', error: (er && (er.error || 'elevation failed')) || 'no result' };
  const r = er.result;
  const tag = (r.removed && r.removed[0]) || '';
  if (tag === 'RUNNING') return { status: 'running' };
  if (tag === 'NOOP') return { status: 'noop', exitCode: (r.missing && r.missing[0]) != null ? r.missing[0] : '' };
  return { status: 'failed', error: (r.errors && r.errors[0]) || 'launch failed' };
}

// Resolve the on-disk install folder for a registry uninstall entry, for direct
// removal when the standard uninstaller is unusable (UAC off → Adobe refuses).
// Order: <installLocation>\<displayName> (Adobe convention — InstallLocation is
// the Adobe root, the app folder is named like the DisplayName), then the common
// Adobe Program Files roots, then installLocation itself (generic apps). Safety:
// never return the bare "Adobe" / "Program Files" root.
function findAppInstallDir(entry) {
  const name = (entry.displayName || '').trim();
  const loc = (entry.installLocation || '').trim();
  const dirs = [];
  if (loc && name) dirs.push(path.join(loc, name));
  if (name) {
    dirs.push(path.join('C:\\Program Files\\Adobe', name));
    dirs.push(path.join('C:\\Program Files (x86)\\Adobe', name));
  }
  if (loc) dirs.push(loc);
  for (const d of dirs) {
    try {
      if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) continue;
      const base = path.basename(d).toLowerCase();
      if (base === 'adobe' || base === 'program files' || d.toLowerCase() === 'c:\\program files') continue;
      return d;
    } catch (_) {}
  }
  return null;
}

// Remove leftover build/temp caches for an Adobe app. Intentionally narrow: only
// the version-specific user cache + Adobe temp, never the whole Roaming\Adobe
// tree (that would nuke other Adobe apps' settings).
function cleanAdobeLeftovers(entry, result) {
  if (!/after effects/i.test(entry.displayName || '')) return;
  const local = process.env.LOCALAPPDATA;
  if (local) removePath(path.join(local, 'Temp', 'Adobe'), result);
  // AE roaming prefs live under Adobe\After Effects\<internalVer>; productVersion
  // gives the major.minor (e.g. 17.7). Remove only a matching version folder.
  const appdata = process.env.APPDATA;
  const m = (entry.uninstallString || '').match(/productVersion=([\d.]+)/i);
  if (appdata && m) {
    const aeRoot = path.join(appdata, 'Adobe', 'After Effects');
    try {
      if (fs.existsSync(aeRoot)) {
        for (const sub of fs.readdirSync(aeRoot)) {
          if (sub.startsWith(m[1].split('.')[0] + '.')) removePath(path.join(aeRoot, sub), result);
        }
      }
    } catch (_) {}
  }
}

// Direct removal: delete the install folder, the registry Uninstall key, and
// leftover caches. Deterministic — doesn't depend on the app's own uninstaller
// (Adobe's HDBox needs UAC prompts + Creative Cloud services and silently fails).
// Returns true if an install folder was found and targeted.
function removeAppDirect(entry, result) {
  const dir = findAppInstallDir(entry);
  if (!dir) {
    result.errors.push({ path: null, message: 'Папка установки не найдена — нельзя удалить напрямую. Удалите вручную.' });
    return false;
  }
  removePath(dir, result);
  if (entry.key) {
    try {
      child_process.execSync(`reg delete "${entry.key}" /f`, { stdio: 'ignore', windowsHide: true, timeout: 15000 });
      result.cleaned.push(entry.key);
    } catch (e) {
      result.errors.push({ path: entry.key, message: 'не удалось удалить ключ реестра: ' + e.message });
    }
  }
  cleanAdobeLeftovers(entry, result);
  return true;
}

function hasAccessErrors(result) {
  return result.errors.some((e) => /EACCES|EPERM|EBUSY|ELOCKED|занят|нет доступа|отказ|denied/i.test(e.message || ''));
}

// Single-quote a value for embedding as a PowerShell string literal (' -> '').
function psq(s) { return "'" + String(s == null ? '' : s).replace(/'/g, "''") + "'"; }

// Build a self-contained PowerShell script that performs the SAME direct removal
// removeAppDirect does — delete the install folder, the registry Uninstall key,
// and Adobe leftovers — but running ELEVATED (so it can touch Program Files and
// HKLM). The wrapper in system.runElevatedPowerShell injects $ResultPath and
// the $removed/$missing/$errors/$cleaned arrays; this body just pushes into them
// and the wrapper serializes them to JSON at the end.
function buildRemovalScript(entry, dir) {
  const name = entry.displayName || '';
  const isAE = /after effects/i.test(name);
  const major = (() => {
    const m = (entry.uninstallString || '').match(/productVersion=([\d.]+)/i);
    return m ? m[1].split('.')[0] : null;
  })();

  const lines = [];
  // 1) Install folder.
  lines.push(`$d = ${psq(dir)}`);
  lines.push(`if (Test-Path -LiteralPath $d) {`);
  lines.push(`  Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue`);
  lines.push(`  if (Test-Path -LiteralPath $d) { $errors += ${psq('не удалось полностью удалить (файлы заняты или нет доступа): ' + dir)} }`);
  lines.push(`  else { $removed += $d }`);
  lines.push(`} else { $missing += $d }`);

  // 2) Registry Uninstall key (HKLM — needs admin).
  if (entry.key) {
    lines.push(`try { $r = & reg delete ${psq(entry.key)} /f 2>&1; if ($LASTEXITCODE -eq 0) { $cleaned += ${psq(entry.key)} } else { $errors += ('reg delete: ' + ($r -join ' ')) } } catch { $errors += $_.Exception.Message }`);
  }

  // 3) Adobe leftovers (AE only): temp + version-matched roaming prefs.
  if (isAE) {
    lines.push(`$t = Join-Path $env:LOCALAPPDATA 'Temp\\Adobe'`);
    lines.push(`if (Test-Path -LiteralPath $t) { Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue; if (-not (Test-Path -LiteralPath $t)) { $cleaned += $t } }`);
    if (major) {
      lines.push(`$aeRoot = Join-Path $env:APPDATA 'Adobe\\After Effects'`);
      lines.push(`if (Test-Path -LiteralPath $aeRoot) {`);
      lines.push(`  Get-ChildItem -LiteralPath $aeRoot -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -like ${psq(major + '.*')} } | ForEach-Object {`);
      lines.push(`    Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue`);
      lines.push(`    if (-not (Test-Path -LiteralPath $_.FullName)) { $cleaned += $_.FullName }`);
      lines.push(`  }`);
      lines.push(`}`);
    }
  }
  return lines.join('\n');
}

// Map an elevated-PowerShell result JSON (arrays of strings) into the same shape
// the in-process removal produces (errors become {path,message} objects).
function mergeElevatedResult(result, er) {
  if (!er || !er.result) {
    result.errors.push({ path: null, message: 'Не удалось получить права администратора: ' + (er && (er.error || er.stdout) || 'отклонено или не удалось повысить') });
    return;
  }
  const r = er.result;
  (r.removed || []).forEach((p) => result.removed.push(p));
  (r.missing || []).forEach((p) => result.missing.push(p));
  (r.cleaned || []).forEach((p) => result.cleaned.push(p));
  (r.errors || []).forEach((m) => result.errors.push({ path: null, message: String(m) }));
}

/**
 * Remove an installed plugin/app from the computer — precisely the files this
 * app wrote, and nothing else. Async because run-mode may spawn an elevated
 * PowerShell one-shot to delete Program Files / HKLM keys.
 *
 * copy/both:
 *   - delete every tracked path (from the install registry; falls back to the
 *     computed installPath/<fileName> for installs made before tracking);
 *   - remove empty parent folders we created, strictly below the category
 *     boundary (never the AE's Plug-ins / Scripts / Presets / Applications root);
 *   - already-gone files are skipped (reported in `missing`), locked/busy
 *     files are reported in `errors` without aborting the rest.
 * run:
 *   - launch the app's OWN registered uninstaller (elevated, see
 *     launchUninstaller) and wait briefly to detect whether it actually ran.
 *     A real uninstaller stays alive → its UI is up, the user finishes removal
 *     there, and we set `launched` (fire-and-forget). A "noop" uninstaller
 *     (Adobe HDBox — exits instantly, removes nothing) → we fall back to
 *     DIRECT removal so the program is actually removed (result.direct +
 *     result.uninstallerNoop). This honors "remove via uninstaller" for normal
 *     apps while guaranteeing removal for uninstallers that don't work standalone.
 *   - if the entry has no UninstallString (rare), DIRECT removal directly.
 *     Elevated → in-process; not elevated → a single elevated PowerShell
 *     one-shot (system.runElevatedPowerShell) WITHOUT relaunching the Electron
 *     app — the original window stays open and just reports the result.
 *   - clean our temp extraction dir.
 * Always: drop the install record and the legacy state entry.
 *
 * Returns { removed, missing, errors, cleaned, launched, uninstaller, direct }.
 */
async function uninstall(plugin, version) {
  const mode = (plugin.installMode || 'copy').toLowerCase();
  const result = { removed: [], missing: [], errors: [], cleaned: [], launched: false, uninstaller: null, direct: false, uninstallerNoop: false };
  const rec = installs.get(plugin.id);

  if (mode === 'run') {
    const match = (plugin.uninstallName || plugin.name || '').trim();
    if (match) {
      try {
        const entry = await registry.findUninstaller(match);
        if (entry) {
          const cmd = entry.uninstallString || entry.quietUninstallString;
          if (cmd) {
            // Primary: launch the app's OWN uninstaller and wait briefly to
            // detect whether it actually ran. A real uninstaller stays alive
            // (its UI is up) → the user finishes removal there. A "noop"
            // uninstaller (Adobe HDBox) exits instantly doing nothing → we
            // fall back to direct removal so the program is actually removed.
            result.uninstaller = entry.displayName;
            const launch = await launchUninstaller(cmd);
            logger.info(
              `Run-mode uninstall: launched uninstaller "${entry.displayName}" => ${launch.status}` +
              (launch.exitCode != null && launch.exitCode !== '' ? ` (exit ${launch.exitCode})` : '')
            );
            if (launch.status === 'running') {
              // Uninstaller UI is up — fire-and-forget; user completes it.
              result.launched = true;
            } else {
              // Uninstaller didn't stay running (noop or failed) → direct
              // removal so the program is actually gone.
              const dir = findAppInstallDir(entry); // read-only; safe non-elevated
              if (dir) {
                result.direct = true;
                result.uninstallerNoop = launch.status === 'noop';
                if (system.isElevated()) {
                  logger.info(`Run-mode uninstall: uninstaller did not run, removing "${entry.displayName}" directly in-process (elevated)`);
                  removeAppDirect(entry, result);
                } else {
                  logger.info(`Run-mode uninstall: uninstaller did not run, removing "${entry.displayName}" via elevated one-shot (not elevated)`);
                  const er = await system.runElevatedPowerShell(buildRemovalScript(entry, dir));
                  mergeElevatedResult(result, er);
                }
              } else {
                result.errors.push({
                  path: null,
                  message: launch.status === 'failed'
                    ? `Не удалось запустить деинсталлятор «${entry.displayName}», папка установки не найдена — удалите вручную.`
                    : `Деинсталлятор «${entry.displayName}» не сработал, папка установки не найдена — удалите вручную.`,
                });
              }
            }
          } else {
            // No registered uninstaller command (rare) — DIRECT removal.
            // Elevated → in-process; not elevated → a single elevated
            // PowerShell one-shot, no app restart.
            const dir = findAppInstallDir(entry); // read-only; safe non-elevated
            if (dir) {
              result.uninstaller = entry.displayName;
              result.direct = true;
              if (system.isElevated()) {
                logger.info(`Run-mode uninstall: no uninstaller, removing "${entry.displayName}" directly in-process (elevated)`);
                removeAppDirect(entry, result);
              } else {
                logger.info(`Run-mode uninstall: no uninstaller, removing "${entry.displayName}" via elevated one-shot (not elevated)`);
                const er = await system.runElevatedPowerShell(buildRemovalScript(entry, dir));
                mergeElevatedResult(result, er);
              }
            } else {
              result.errors.push({ path: null, message: `Не найден деинсталлятор в реестре для «${match}». Удалите вручную.` });
            }
          }
        } else {
          result.errors.push({ path: null, message: `Не найден «${match}» в реестре. Удалите вручную.` });
          logger.warn(`Run-mode uninstall: no registered uninstaller matches "${match}"`);
        }
      } catch (e) {
        result.errors.push({ path: null, message: e.message });
        logger.warn(`Run-mode uninstall error: ${e.message}`);
      }
    }
    // Always clean our temp extraction dir for this plugin, if any.
    removePath(path.join(TMP_DIR, `extract-${plugin.id}`), result);
  } else {
    // copy/both: tracked paths from the registry, with a fallback computed from
    // the catalog for installs made before tracking existed.
    let paths = (rec && Array.isArray(rec.paths) && rec.paths.length) ? rec.paths.slice() : null;
    let boundary = (rec && rec.boundary) || null;
    if (!paths && plugin.installPath && plugin.fileName) {
      try {
        const resolved = aePaths.resolveInstallDir(version, plugin.installPath);
        paths = [path.join(resolved.dir, plugin.fileName)];
        boundary = categoryRoot(version, plugin.installPath) || resolved.dir;
      } catch (e) {
        result.errors.push({ path: plugin.installPath, message: `Не удалось определить путь: ${e.message}` });
      }
    }
    if (paths) {
      for (const p of paths) removePath(p, result);
      cleanEmptyParents(paths, boundary, result);
    }
  }

  installs.remove(plugin.id);
  state.markRemoved(plugin.id);
  logger.info(
    `Uninstalled ${plugin.name}: removed=${result.removed.length} missing=${result.missing.length} ` +
    `cleaned=${result.cleaned.length} errors=${result.errors.length} launched=${result.launched}`
  );
  return result;
}

module.exports = { install, uninstall, checkStatus, checkStatusAll, launchInstalled, isAppRunning, closeApp, cancelDownload, tmpDir: () => TMP_DIR };