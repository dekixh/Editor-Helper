// core/archiver.js
// Detects downloaded archives by magic bytes and extracts them using Windows
// built-in tooling (no native npm deps). Used by the installer so catalog files
// distributed as .zip/.7z/.rar/.tar/.gz are unpacked before install actions run.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const logger = require('./logger');

// Magic-byte signatures at the start of the file (except tar, at offset 257).
const MAGICS = [
  { name: 'zip',  off: 0, bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04]) },
  { name: 'zip',  off: 0, bytes: Buffer.from([0x50, 0x4b, 0x05, 0x06]) }, // empty zip
  { name: 'zip',  off: 0, bytes: Buffer.from([0x50, 0x4b, 0x07, 0x08]) }, // spanned
  { name: 'rar',  off: 0, bytes: Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]) },
  { name: '7z',   off: 0, bytes: Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]) },
  { name: 'gz',   off: 0, bytes: Buffer.from([0x1f, 0x8b]) },
  { name: 'bz2',  off: 0, bytes: Buffer.from([0x42, 0x5a, 0x68]) },
  { name: 'xz',   off: 0, bytes: Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]) },
];
const TAR_MAGIC_OFF = 257;
const TAR_MAGIC = Buffer.from('ustar');

/**
 * Detect the archive format of a file by reading its first bytes.
 * Returns 'zip' | 'rar' | '7z' | 'gz' | 'bz2' | 'xz' | 'tar' | null.
 */
function detectArchive(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(300);
    fs.readSync(fd, buf, 0, 300, 0);
    fs.closeSync(fd);
    for (const m of MAGICS) {
      if (buf.slice(m.off, m.off + m.bytes.length).equals(m.bytes)) return m.name;
    }
    if (buf.slice(TAR_MAGIC_OFF, TAR_MAGIC_OFF + TAR_MAGIC.length).equals(TAR_MAGIC)) return 'tar';
    return null;
  } catch (_) {
    return null;
  }
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout: 300000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr && stderr.trim() ? stderr.trim() : err.message));
      else resolve(stdout);
    });
  });
}

// Resolve the path to Windows' bundled bsdtar (libarchive). Using the full
// System32 path avoids picking up a different `tar` (e.g. GNU tar from Git)
// that happens to be earlier on PATH.
function windowsTar() {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const p = path.join(root, 'System32', 'tar.exe');
  try { if (fs.existsSync(p)) return p; } catch (_) {}
  return 'tar'; // last resort: let execFile search PATH
}

/**
 * Extract an archive into outDir. outDir is created if missing.
 *   zip  -> PowerShell Expand-Archive (always available on Win10+), tar fallback.
 *   7z/rar/tar/gz/bz2/xz -> Windows bsdtar (libarchive) by full path.
 */
async function extract(file, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const fmt = detectArchive(file) || (path.extname(file).toLowerCase().replace('.', '') || 'unknown');
  logger.info(`Extracting archive (${fmt}) ${file} -> ${outDir}`);

  const isZip = fmt === 'zip' || /\.zip$/i.test(file);
  const psCmd = `Expand-Archive -LiteralPath '${file.replace(/'/g, "''")}' -DestinationPath '${outDir.replace(/'/g, "''")}' -Force`;

  if (isZip) {
    try {
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCmd]);
      return outDir;
    } catch (e) {
      logger.warn(`Expand-Archive failed: ${e.message}; trying tar`);
    }
  }

  // tar handles zip too, and is the only option for 7z/rar/tar/gz/bz2/xz.
  try {
    await run(windowsTar(), ['-xf', file, '-C', outDir]);
    return outDir;
  } catch (e) {
    throw new Error(
      `Не удалось распаковать архив (${fmt}). ${isZip ? 'Expand-Archive и tar не справились' : 'системный tar не справился'}. ` +
      `Переупакуйте в .zip — он поддерживается всегда.`
    );
  }
}

// Skip these when walking an extracted tree.
function skip(name) {
  return name === '__MACOSX' || name === '.DS_Store' || name === 'Thumbs.db';
}

/**
 * Find an entry (file or folder) named `name` inside an extracted archive tree
 * (case-insensitive). Returns { kind:'file'|'dir', path, name } or null.
 */
function resolvePayload(root, name) {
  if (!name) return null;
  const want = name.toLowerCase();
  const stack = [root];
  while (stack.length) {
    const d = stack.shift();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); }
    catch (_) { continue; }
    for (const ent of entries) {
      if (skip(ent.name)) continue;
      if (ent.name.toLowerCase() === want) {
        return { kind: ent.isDirectory() ? 'dir' : 'file', path: path.join(d, ent.name), name: ent.name };
      }
      if (ent.isDirectory()) stack.push(path.join(d, ent.name));
    }
  }
  return null;
}

/**
 * Find the first .exe inside a directory tree (used for "run" mode when the
 * archive payload is a folder). Returns an absolute path or null.
 */
function findExe(root) {
  const stack = [root];
  while (stack.length) {
    const d = stack.shift();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); }
    catch (_) { continue; }
    for (const ent of entries) {
      if (skip(ent.name)) continue;
      const p = path.join(d, ent.name);
      if (ent.isFile() && /\.exe$/i.test(ent.name)) return p;
      if (ent.isDirectory()) stack.push(p);
    }
  }
  return null;
}

module.exports = { detectArchive, extract, resolvePayload, findExe };