// core/installs.js
// The install registry — records exactly what this app installed so uninstall
// can remove precisely those files and nothing else. One record per plugin id.
//
// Record shape:
//   { id, name, version, fileName, mode, aeVersion, installDir,
//     paths: [absolute paths written by this install],   // [] for run-mode
//     boundary: absolute category-root folder,            // never delete here or above
//     installedAt }
//
// Stored as installs.json in userData (writable for the packaged portable exe).

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

let _file = null;
function file() {
  if (_file) return _file;
  try {
    const { app } = require('electron');
    _file = path.join(app.getPath('userData'), 'installs.json');
  } catch (_) {
    _file = path.join(__dirname, '..', 'config', 'installs.json');
  }
  return _file;
}

function read() {
  try { return JSON.parse(fs.readFileSync(file(), 'utf8')) || {}; }
  catch (_) { return {}; }
}

function write(d) {
  try { fs.writeFileSync(file(), JSON.stringify(d, null, 2)); }
  catch (e) { logger.error(`installs write failed: ${e.message}`); }
}

/**
 * Record (or replace) the install for a plugin.
 * @param plugin   catalog entry (already resolved to a version)
 * @param version  AE version entry or null (AE-independent installs)
 * @param paths    array of absolute paths this install wrote
 * @param boundary absolute category-root folder; uninstall never deletes here or above
 * @param installDir resolved destination dir (metadata)
 */
function record(plugin, version, paths, boundary, installDir) {
  const d = read();
  d[plugin.id] = {
    id: plugin.id,
    name: plugin.name,
    version: plugin.version,
    fileName: plugin.fileName,
    mode: (plugin.installMode || 'copy').toLowerCase(),
    aeVersion: version ? version.version : null,
    installDir: installDir || null,
    paths: Array.isArray(paths) ? paths : [],
    boundary: boundary || null,
    installedAt: new Date().toISOString(),
  };
  write(d);
  logger.info(`installs: recorded ${plugin.id} (${d[plugin.id].mode}) — ${d[plugin.id].paths.length} path(s)`);
}

function get(id) { return read()[id] || null; }

function remove(id) {
  const d = read();
  if (d[id]) { delete d[id]; write(d); logger.info(`installs: removed record ${id}`); }
}

function all() { return Object.values(read()); }

module.exports = { record, get, remove, all, file };