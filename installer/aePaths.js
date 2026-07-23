// installer/aePaths.js
// Detects Adobe After Effects installation directories on Windows.
// Two kinds of install roots matter:
//   1. Support Files (Program Files)   -> Plug-ins, bundled Scripts
//   2. User Roaming (AppData)          -> user Scripts & ScriptUI Panels (no admin needed)

const fs = require('fs');
const path = require('path');
const os = require('os');
const logger = require('../core/logger');

/**
 * Find every installed After Effects version and its key folders.
 * Returns an array sorted newest-version-first:
 *   { version, year, supportFiles, userFolder }
 */
function detectVersions() {
  const results = [];

  // 1. Program Files install roots. De-duped (env var + hardcoded fallback can collide).
  const progRoots = Array.from(new Set([
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Adobe'),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Adobe'),
    'C:\\Program Files\\Adobe',
  ].filter(Boolean)));

  const seenSupport = new Set();
  for (const root of progRoots) {
    let entries = [];
    try { entries = fs.readdirSync(root); } catch (_) { continue; }
    for (const entry of entries) {
      const m = entry.match(/^Adobe After Effects\s+(\d{4})$/i);
      if (!m) continue;
      const year = parseInt(m[1], 10);
      const supportFiles = path.join(root, entry, 'Support Files');
      if (!fs.existsSync(supportFiles)) continue;
      if (seenSupport.has(supportFiles)) continue; // skip duplicate root
      seenSupport.add(supportFiles);
      results.push({
        version: `After Effects ${year}`,
        year,
        supportFiles,
        userFolder: path.join(os.homedir(), 'AppData', 'Roaming', 'Adobe', 'After Effects', String(year)),
      });
    }
  }

  // 2. Some installs only expose the user roaming folder; pick those up too.
  //    AppData folders use the internal version (e.g. "26.0" = AE 2026).
  //    major + 2000 = marketing year. Merge with an existing Program Files entry
  //    when they refer to the same year instead of showing a duplicate.
  const userAdobe = path.join(os.homedir(), 'AppData', 'Roaming', 'Adobe', 'After Effects');
  try {
    for (const entry of fs.readdirSync(userAdobe)) {
      const major = parseInt(entry.split('.')[0], 10);
      if (Number.isNaN(major)) continue;
      const year = major + 2000; // 24 -> 2024, 26 -> 2026
      const existing = results.find((r) => r.year === year);
      if (existing) {
        // Prefer the decimal-named AppData folder if the simple-year one is absent.
        if (!fs.existsSync(existing.userFolder)) existing.userFolder = path.join(userAdobe, entry);
        continue;
      }
      results.push({
        version: `After Effects ${year}`,
        year,
        supportFiles: null, // user-only install (Support Files not found)
        userFolder: path.join(userAdobe, entry),
      });
    }
  } catch (_) { /* no user folder */ }

  results.sort((a, b) => b.year - a.year);
  logger.info(`Detected ${results.length} After Effects version(s): ${results.map((r) => r.version).join(', ') || 'none'}`);
  return results;
}

/**
 * Resolve a logical install path (from config) to an absolute folder for a given AE version.
 *
 * Logical paths:
 *   "Scripts/ScriptUI Panels"        -> user roaming (preferred, no admin) or Support Files
 *   "Scripts"                        -> user roaming Scripts
 *   "ScriptUI Panels"                -> same as Scripts/ScriptUI Panels
 *   "Plug-ins" or "Plug-ins/<sub>"   -> Support Files/Plug-ins[/<sub>]  (needs admin)
 *   "Presets"                        -> Support Files/Presets
 *
 * @param {object} version  Entry from detectVersions()
 * @param {string} logical  installPath from config
 * @returns {{dir: string, needsAdmin: boolean}}
 */
function resolveInstallDir(version, logical) {
  const norm = logical.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const lower = norm.toLowerCase();

  // --- Scripts / ScriptUI Panels : prefer user folder (no admin) ---
  if (lower === 'scripts' || lower === 'scripts/scriptui panels' || lower === 'scriptui panels') {
    const sub = lower === 'scripts' ? 'Scripts' : path.join('Scripts', 'ScriptUI Panels');
    const userDir = version.userFolder ? path.join(version.userFolder, sub) : null;
    if (userDir) return { dir: userDir, needsAdmin: false };
    // fall back to Support Files if no user folder
    if (version.supportFiles) return { dir: path.join(version.supportFiles, sub), needsAdmin: true };
    throw new Error('No writable Scripts folder found for this AE version.');
  }

  // --- Plug-ins : Support Files only ---
  if (lower === 'plug-ins' || lower.startsWith('plug-ins/')) {
    if (!version.supportFiles) {
      throw new Error('Plug-ins require the AE Support Files folder, which was not detected for this version.');
    }
    const sub = norm.substring('plug-ins'.length).replace(/^\/+/, '');
    const dir = sub ? path.join(version.supportFiles, 'Plug-ins', sub) : path.join(version.supportFiles, 'Plug-ins');
    return { dir, needsAdmin: true };
  }

  // --- Presets : Support Files/Presets ---
  if (lower === 'presets' || lower.startsWith('presets/')) {
    if (!version.supportFiles) throw new Error('Presets require the AE Support Files folder.');
    const sub = norm.substring('presets'.length).replace(/^\/+/, '');
    const dir = sub ? path.join(version.supportFiles, 'Presets', sub) : path.join(version.supportFiles, 'Presets');
    return { dir, needsAdmin: true };
  }

  // --- Applications : standalone companion apps (.exe), AE-independent ---
  // Installed under %LOCALAPPDATA%\editor-helper-lite\Applications (no admin needed).
  if (lower === 'applications' || lower.startsWith('applications/')) {
    const sub = norm.substring('applications'.length).replace(/^\/+/, '');
    const dir = sub ? path.join(appsFolder(), sub) : appsFolder();
    return { dir, needsAdmin: false };
  }

  // --- Fallback: treat as relative to Support Files ---
  if (version.supportFiles) return { dir: path.join(version.supportFiles, norm), needsAdmin: true };
  throw new Error(`Cannot resolve install path "${logical}" — no Support Files folder detected.`);
}

/**
 * Base folder for standalone "app" installs (companion .exe tools).
 * %LOCALAPPDATA%\editor-helper-lite\Applications — user-writable, no admin.
 */
function appsFolder() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'editor-helper-lite', 'Applications');
}

module.exports = { detectVersions, resolveInstallDir, appsFolder };