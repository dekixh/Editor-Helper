// installer/registry.js
// Find an application's registered uninstaller in the Windows registry so a
// "run"-mode install (where the downloaded installer placed files on its own)
// can be genuinely removed from the computer — not just have its state record
// cleared. Searches the standard Uninstall keys (64-bit, 32-bit WOW6432Node,
// and per-user) and returns the matching DisplayName + UninstallString.
//
// IMPORTANT: the registry scan uses async `execFile('reg', ...)` — NEVER the
// synchronous `execSync`. A synchronous `reg query /s` over three Uninstall
// hives blocks the Electron main process for ~1–3s, freezing the UI on startup.
// The async scan runs in the libuv thread pool, so the main thread stays free.
// The parsed result is cached as a Promise so all callers in a single status
// sweep share ONE scan (the bulk statusAll path relies on this).

const { execFile } = require('child_process');

const UNINSTALL_KEYS = [
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
];

// Async, non-blocking reg query. Resolves to stdout string ('' on any error /
// timeout). Runs off the main thread via execFile's libuv thread pool.
function regQueryAsync(key) {
  return new Promise((resolve) => {
    execFile('reg', ['query', key, '/s'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 20000,
      maxBuffer: 8 * 1024 * 1024,
    }, (err, stdout) => {
      if (err) return resolve('');
      resolve(stdout || '');
    });
  });
}

// Parse `reg query /s` output into a list of { key, displayName,
// uninstallString, quietUninstallString, installLocation, displayIcon }. A
// subkey header line starts with HKEY_; value lines look like
// "    DisplayName    REG_SZ    Adobe After Effects 2020".
function parseUninstallEntries(output) {
  const entries = [];
  let cur = null;
  const re = /^\s+(.+?)\s+REG_(?:SZ|EXPAND_SZ|MULTI_SZ|DWORD)\s+(.*)$/;
  for (const line of output.split(/\r?\n/)) {
    if (/^HKEY_/i.test(line)) {
      if (cur && cur.displayName) entries.push(cur);
      cur = { key: line.trim(), displayName: '', uninstallString: '', quietUninstallString: '', installLocation: '', displayIcon: '' };
      continue;
    }
    const m = re.exec(line);
    if (m && cur) {
      const name = m[1].trim();
      const val = m[2].trim();
      if (/^DisplayName$/i.test(name)) cur.displayName = val;
      else if (/^UninstallString$/i.test(name)) cur.uninstallString = val;
      else if (/^QuietUninstallString$/i.test(name)) cur.quietUninstallString = val;
      else if (/^InstallLocation$/i.test(name)) cur.installLocation = val;
      else if (/^DisplayIcon$/i.test(name)) cur.displayIcon = val;
    }
  }
  if (cur && cur.displayName) entries.push(cur);
  return entries;
}

// Cache the parsed registry entries as a PROMISE for a short window so a single
// status sweep (which queries the registry once per run-mode catalog entry)
// only hits the registry once, and concurrent callers share the in-flight scan.
// Manual "scan PC" invalidates this. TTL keeps a stale snapshot from lasting
// forever while the user installs/uninstalls things.
let _entriesPromise = null;
let _cacheAt = 0;
const CACHE_TTL = 10000;

function allEntriesAsync() {
  const now = Date.now();
  if (_entriesPromise && now - _cacheAt < CACHE_TTL) return _entriesPromise;
  _cacheAt = now;
  _entriesPromise = (async () => {
    // Query the three hives sequentially (reg is process-spawn heavy; parallel
    // spawns would thrash disk/registry more than they'd save). Each runs off
    // the main thread, so the UI never blocks regardless.
    let output = '';
    for (const k of UNINSTALL_KEYS) output += '\n' + (await regQueryAsync(k));
    return parseUninstallEntries(output);
  })();
  return _entriesPromise;
}

function invalidateCache() { _entriesPromise = null; _cacheAt = 0; }

/**
 * Find a registered uninstaller whose DisplayName contains `match`
 * (case-insensitive substring). Returns { displayName, uninstallString,
 * quietUninstallString, installLocation, displayIcon } or null if nothing
 * matches. Async — awaits the (cached) registry scan.
 */
async function findUninstaller(match) {
  const needle = (match || '').trim().toLowerCase();
  if (!needle) return null;
  const entries = await allEntriesAsync();
  return entries.find(
    (e) => e.displayName && e.displayName.toLowerCase().includes(needle) && (e.uninstallString || e.quietUninstallString)
  ) || null;
}

/**
 * Cheap membership check used by status scanning: returns the matching
 * DisplayName (or null) without requiring an uninstall command to be present.
 * Async — awaits the (cached) registry scan.
 */
async function findInstalledApp(match) {
  const needle = (match || '').trim().toLowerCase();
  if (!needle) return null;
  const entries = await allEntriesAsync();
  const e = entries.find((x) => x.displayName && x.displayName.toLowerCase().includes(needle));
  return e ? e.displayName : null;
}

/**
 * Resolve an installed app's launch info by DisplayName (case-insensitive
 * substring). Returns { displayName, installLocation, displayIcon,
 * uninstallString } or null. `displayIcon` usually points at the app's main
 * .exe ("C:\path\app.exe,0") — the primary launch target; `installLocation`
 * is the fallback folder we search for an .exe. Async.
 */
async function findLaunchInfo(match) {
  const needle = (match || '').trim().toLowerCase();
  if (!needle) return null;
  const entries = await allEntriesAsync();
  const e = entries.find((x) => x.displayName && x.displayName.toLowerCase().includes(needle));
  if (!e) return null;
  return { displayName: e.displayName, installLocation: e.installLocation, displayIcon: e.displayIcon, uninstallString: e.uninstallString };
}

module.exports = { findUninstaller, findInstalledApp, findLaunchInfo, invalidateCache, allEntriesAsync };