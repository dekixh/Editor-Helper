// core/config.js — normalizes & validates the plugin catalog.
//
// The catalog is a single editable JSON file. Which file is "active" depends
// on how the app runs:
//   - Dev (electron .): the source config/plugins.json — edit it directly.
//   - Packaged build: %userData%/plugins.json, seeded from the bundled default
//     on first run. The bundled file lives inside the asar (read-only), so the
//     user-editable copy in userData is what the app actually reads.
// The app polls the active file's mtime and reloads the catalog live on change,
// so editing the config is reflected in the running program without a restart.
//
// Icons: bare filenames are resolved against the bundled config/icons/ (asar is
// readable) and, in packaged builds, the userData/icons/ folder; embedded as
// data URIs so they render under the page CSP.
//
// Version model:
//   Each plugin may carry flat single-version fields (legacy) or a `versions`
//   array. Both normalize to a `versions` array:
//     [{ version, fileName, downloadUrl, installPath, installMode, changelog }]
//   A version entry may override the plugin-level installPath / installMode.

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

/** The bundled catalog directory (config/), works in dev and inside asar. */
function catalogDir() {
  return path.join(__dirname, '..', 'config');
}

/** The active, user-editable config file path. */
function configFile() {
  const { app } = require('electron');
  if (app.isPackaged) return path.join(app.getPath('userData'), 'plugins.json');
  return path.join(catalogDir(), 'plugins.json');
}

/** In packaged builds, seed the user-editable config from the bundled default if absent. */
function ensureConfig() {
  const { app } = require('electron');
  if (!app.isPackaged) return;
  const dest = configFile();
  if (fs.existsSync(dest)) return;
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(catalogDir(), 'plugins.json'), dest);
    logger.info(`Seeded config to ${dest}`);
  } catch (e) {
    logger.warn(`Could not seed config: ${e.message}`);
  }
}

/** Overwrite the user config with the bundled default (pulls in build updates). Dev no-op. */
function resetConfig() {
  const { app } = require('electron');
  if (!app.isPackaged) return;
  const dest = configFile();
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(catalogDir(), 'plugins.json'), dest);
    logger.info(`Reset config to bundled default at ${dest}`);
  } catch (e) {
    logger.warn(`Could not reset config: ${e.message}`);
  }
}

/**
 * Watch the active config file for changes (poll mtime — editor/atomic-save
 * agnostic). Calls cb on every change. Returns a stop function.
 */
function watchConfig(cb) {
  ensureConfig();
  const file = configFile();
  let lastMtime = 0;
  try { lastMtime = fs.statSync(file).mtimeMs; } catch (_) {}
  const iv = setInterval(() => {
    let m;
    try { m = fs.statSync(file).mtimeMs; } catch (_) { return; }
    if (m !== lastMtime) {
      lastMtime = m;
      try { cb(); } catch (e) { logger.warn(`config reload error: ${e.message}`); }
    }
  }, 1500);
  return () => clearInterval(iv);
}

/**
 * Map an icon file extension to its MIME type for data-URI embedding. Handles
 * the non-obvious cases: .svg, .ico (must be image/x-icon, not image/ico —
 * Chromium won't render image/ico), and .jpg→jpeg. Falls back to a generic
 * octet-stream when there's no extension so the data URI is still well-formed.
 */
function iconMime(ext) {
  ext = String(ext || '').toLowerCase().replace(/^\./, '');
  if (ext === 'svg') return 'image/svg+xml';
  if (ext === 'ico') return 'image/x-icon';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  return ext ? `image/${ext}` : 'application/octet-stream';
}

/**
 * Resolve a plugin's `icon` value to a loadable image source.
 * - URLs (http/https/data/file) are returned as-is (server mode).
 * - Bare filenames are read from config/icons/ and embedded as a data URI
 *   (local mode) so they survive packaging and the renderer CSP.
 */
function resolveIcon(icon, dir) {
  if (!icon) return '';
  if (/^(https?:|data:|file:)/i.test(icon)) return icon;
  // Bare filename → local icon file → data URI. Look in the bundled icons
  // folder first, then (in packaged builds) the user's userData/icons folder.
  // `dirs` holds the PARENT folders (catalog dir, userData); the loop appends
  // 'icons' — so don't append 'icons' here too (that would double it to
  // userData/icons/icons/<icon> and never find user-added icons).
  const dirs = [dir || catalogDir()];
  try {
    const { app } = require('electron');
    if (app.isPackaged) dirs.push(app.getPath('userData'));
  } catch (_) {}
  for (const base of dirs) {
    const file = path.join(base, 'icons', icon);
    try {
      const buf = fs.readFileSync(file);
      const mime = iconMime(path.extname(icon));
      return `data:${mime};base64,${buf.toString('base64')}`;
    } catch (_) { /* try next */ }
  }
  logger.warn(`Icon file not found: ${icon}`);
  return '';
}

/**
 * Where user-added icon files are stored (writable). In dev this is the source
 * config/icons/ folder; in a packaged build it's %userData%/icons/, which is
 * also searched by resolveIcon.
 */
function userIconsDir() {
  const { app } = require('electron');
  return app.isPackaged ? path.join(app.getPath('userData'), 'icons') : path.join(catalogDir(), 'icons');
}

/** Validate an installMode value; fall back to 'copy' (and the given default). */
function normalizeInstallMode(value, fallback) {
  const m = String(value || fallback || 'copy').toLowerCase();
  if (m === 'copy' || m === 'run' || m === 'both') return m;
  if (value) logger.warn(`Unknown installMode "${value}" — using "copy"`);
  return 'copy';
}

/** Normalize a plugin entry's version model into a `versions` array. */
function normalizeVersions(p) {
  const defaultInstall = p.installPath;
  const defaultFile = p.fileName;
  const defaultMode = normalizeInstallMode(p.installMode);

  if (Array.isArray(p.versions) && p.versions.length) {
    return p.versions.map((v, i) => {
      if (!v.downloadUrl) {
        logger.warn(`Plugin "${p.id}" version #${i} skipped — missing downloadUrl`);
        return null;
      }
      return {
        version: String(v.version || ''),
        fileName: String(v.fileName || defaultFile || ''),
        downloadUrl: String(v.downloadUrl),
        installPath: String(v.installPath || defaultInstall || ''),
        installMode: normalizeInstallMode(v.installMode, defaultMode),
        changelog: String(v.changelog || ''),
      };
    }).filter(Boolean);
  }

  // Legacy flat form: one version built from the plugin-level fields.
  if (!p.downloadUrl) return [];
  return [{
    version: String(p.version || ''),
    fileName: String(p.fileName || ''),
    downloadUrl: String(p.downloadUrl),
    installPath: String(p.installPath || ''),
    installMode: defaultMode,
    changelog: '',
  }];
}

/**
 * Validate & normalize a raw catalog object.
 * @param {object} raw   parsed JSON, expected { plugins: [...] }
 * @param {string} [dir] catalog dir for local icon resolution
 * @returns {{plugins: Array}}
 */
function normalizeCatalog(raw, dir) {
  const plugins = (raw && Array.isArray(raw.plugins)) ? raw.plugins : [];
  const valid = [];
  const seenIds = new Set();

  for (const p of plugins) {
    const versions = normalizeVersions(p);
    // Sentinel tags carry state the backend has no column for:
    //   __soon   -> "СКОРО выйдет" announcement (no download yet)
    //   __script -> type 'script' (stored as kind='plugin'; the backend `item_kind`
    //               enum only has plugin/app). Rewrite type accordingly.
    const pTags = Array.isArray(p.tags) ? p.tags : [];
    const isSoon = pTags.includes('__soon');
    const isScript = pTags.includes('__script');
    // The SERVER catalog (GET /plugins + /apps) stores installPath / installMode
    // PER VERSION, with no entry-level copy. The legacy local catalog stored them
    // at the entry level. Support both: fall back to the first version's values
    // when the entry-level ones are absent, so a valid server item isn't skipped
    // just because it has no top-level installPath.
    const fb = versions[0] || {};
    const mode = normalizeInstallMode(p.installMode, fb.installMode);
    const effInstallPath = String(p.installPath || fb.installPath || '');
    const requiredTop = ['id', 'name', 'type'];
    if (!isSoon && mode !== 'run') requiredTop.push('installPath');
    const missingTop = requiredTop.filter((f) => (f === 'installPath' ? !effInstallPath : !p[f]));

    if (missingTop.length || (!isSoon && !versions.length)) {
      const reason = missingTop.length ? `missing ${missingTop.join(', ')}` : 'no valid version entries';
      logger.warn(`Skipped plugin entry — ${reason}: ${JSON.stringify(p)}`);
      continue;
    }
    if (seenIds.has(p.id)) {
      logger.warn(`Skipped duplicate plugin id: ${p.id}`);
      continue;
    }
    seenIds.add(p.id);
    const iconResolved = resolveIcon(p.icon, dir);
    if (p.icon && !iconResolved) {
      logger.warn(`Icon not usable for "${p.id}": "${p.icon}"`);
    }
    valid.push({
      id: String(p.id),
      name: String(p.name),
      description: String(p.description || ''),
      type: isScript ? 'script' : String(p.type).toLowerCase(),
      installPath: effInstallPath,
      installMode: mode,
      icon: String(p.icon || ''),
      iconResolved,
      author: String(p.author || ''),
      homepage: String(p.homepage || ''),
      rating: Number(p.rating) || 0,
      comingSoon: isSoon,
      tags: pTags.map(String).filter((t) => t !== '__soon' && t !== '__script'),
      versions,
    });
  }

  logger.info(`Normalized catalog: ${valid.length} valid plugin(s)`);
  return { plugins: valid };
}

/**
 * Load the active local catalog. In dev this is the source config/plugins.json;
 * in a packaged build it's the user-editable %userData%/plugins.json (seeded on
 * first run). Returns { plugins: [] } if the file is missing/broken.
 */
function loadConfig() {
  ensureConfig();
  const file = configFile();
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return normalizeCatalog(raw, catalogDir());
  } catch (e) {
    logger.error(`Failed to read catalog (${file}): ${e.message}`);
    return { plugins: [] };
  }
}

module.exports = { normalizeCatalog, normalizeInstallMode, loadConfig, catalogDir, configFile, ensureConfig, resetConfig, watchConfig, resolveIcon, userIconsDir, iconMime };