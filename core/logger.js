// core/logger.js
// Lightweight rotating logger. Writes to <userData>/logs/app.log and mirrors
// entries to an in-memory ring buffer so the UI can pull recent lines via IPC.
//
// Writable path resolves to Electron's userData (%AppData%/<appName>) so logs
// persist even when the app is packaged as a portable read-only .exe.

const fs = require('fs');
const path = require('path');

const MAX_BUFFER = 500;
const ring = []; // in-memory recent log entries (newest last)
let _logFile = null;

// Resolve lazily so we don't touch electron `app` at module-load time.
function logFile() {
  if (_logFile) return _logFile;
  let dir;
  try {
    const { app } = require('electron');
    dir = path.join(app.getPath('userData'), 'logs');
  } catch (_) {
    // Fallback for non-electron contexts (unit checks).
    dir = path.join(__dirname, '..', 'logs');
  }
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* ignore */ }
  _logFile = path.join(dir, 'app.log');
  return _logFile;
}

/**
 * Append a log line.
 * @param {'info'|'warn'|'error'|'success'} level
 * @param {string} message
 */
function log(level, message) {
  const stamp = new Date().toISOString();
  const line = `[${stamp}] ${level.toUpperCase()}: ${message}`;
  ring.push(line);
  if (ring.length > MAX_BUFFER) ring.shift();
  try { fs.appendFileSync(logFile(), line + '\n'); } catch (_) { /* ignore */ }
}

module.exports = {
  info: (m) => log('info', m),
  warn: (m) => log('warn', m),
  error: (m) => log('error', m),
  success: (m) => log('success', m),
  /** Return recent log lines (oldest first). */
  recent: () => [...ring],
  /** Return the absolute path of the log file (for "open logs" button). */
  logFile,
  clear: () => { ring.length = 0; try { fs.writeFileSync(logFile(), ''); } catch (_) {} },
};