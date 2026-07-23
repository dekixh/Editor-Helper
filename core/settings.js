// core/settings.js — persisted client settings (server URL).
// Stored in <userData>/settings.json so they survive across runs and edits.

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

let _file = null;
function filePath() {
  if (_file) return _file;
  const { app } = require('electron');
  _file = path.join(app.getPath('userData'), 'settings.json');
  return _file;
}

const DEFAULTS = {
  // No public backend by default — the app ships with a bundled local catalog
  // (config/plugins.json). A server URL can be set in Settings if a catalog
  // server is deployed. Kept empty in the public source so no backend endpoint
  // is exposed.
  serverUrl: '',
  customAeVersions: [],
  // Interface theme: 'dark' (default black/silver glass) or 'light'.
  uiTheme: 'dark',
  // Cosmic background (ui/bg3d.js): theme, flight speed, star count, mouse reaction.
  bg: { theme: 'black', speed: 1.0, starCount: 1600, mouseIntensity: 1.0 },
  // Interface sounds (ui/sound.js): master enable + global volume (0..1).
  sound: { enabled: true, volume: 0.7 },
  // App self-update via GitHub Releases: `repo` = "owner/repo" of a PUBLIC
  // GitHub repo whose latest release tags a version (vX.Y.Z) and has an asset
  // named "Editor-Helper.exe". Empty = skip update checks entirely.
  // Defaults to this app's own repo so users get updates out of the box;
  // they can change it in Settings.
  update: { repo: 'dekixh/Editor-Helper' },
};

function read() {
  try { return JSON.parse(fs.readFileSync(filePath(), 'utf8')); }
  catch (_) { return {}; }
}

function get() {
  const merged = Object.assign({}, DEFAULTS, read());
  // Deep-merge the background block so newly-added default keys (e.g. a new
  // theme field) still apply when an older settings.json is present.
  merged.bg = Object.assign({}, DEFAULTS.bg, merged.bg || {});
  // Same for the sound block (enabled/volume).
  merged.sound = Object.assign({}, DEFAULTS.sound, merged.sound || {});
  merged.update = Object.assign({}, DEFAULTS.update, merged.update || {});
  return merged;
}

function write(patch) {
  const merged = Object.assign(get(), patch || {});
  try {
    fs.mkdirSync(path.dirname(filePath()), { recursive: true });
    fs.writeFileSync(filePath(), JSON.stringify(merged, null, 2), 'utf8');
  } catch (e) {
    logger.error(`settings write failed: ${e.message}`);
  }
  return merged;
}

module.exports = { get, write, filePath: () => filePath() };