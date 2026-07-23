// core/state.js
// Persists which plugins are installed and where, so the UI can show statuses
// ("installed" / "update available") across restarts. Stored as a tiny JSON file
// in Electron's userData dir (writable even for a packaged portable .exe).

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

let _file = null;
function stateFile() {
  if (_file) return _file;
  try {
    const { app } = require('electron');
    _file = path.join(app.getPath('userData'), 'installed.json');
  } catch (_) {
    _file = path.join(__dirname, '..', 'config', 'installed.json');
  }
  return _file;
}

function read() {
  try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')) || {}; }
  catch (_) { return {}; }
}

function write(state) {
  try { fs.writeFileSync(stateFile(), JSON.stringify(state, null, 2)); }
  catch (e) { logger.error(`Failed to persist state: ${e.message}`); }
}

/**
 * Mark a plugin as installed for a given AE version.
 */
function markInstalled(plugin, version, installDir) {
  const state = read();
  // version may be null for AE-independent installs (run mode / Applications).
  const aeVer = version ? version.version : null;
  state[plugin.id] = {
    version: plugin.version,
    fileName: plugin.fileName,
    aeVersion: aeVer,
    installDir,
    installedAt: new Date().toISOString(),
  };
  write(state);
  logger.info(`State: marked ${plugin.id} installed for ${aeVer || '(no AE)'}`);
}

function markRemoved(pluginId) {
  const state = read();
  delete state[pluginId];
  write(state);
}

function get(pluginId) {
  const state = read();
  return state[pluginId] || null;
}

module.exports = { read, markInstalled, markRemoved, get, stateFile };