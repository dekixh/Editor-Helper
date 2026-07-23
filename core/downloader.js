// core/downloader.js
// Downloads a plugin file to a temp path. Google Drive is the primary source.
//
// Modern Google Drive flow (the working one, as of 2024+):
//   1. extract FILE_ID from /file/d/<id>/view, /open?id=<id>, ?id=<id>, ...
//   2. request the direct file endpoint
//        https://drive.usercontent.google.com/download?id=<id>&export=download&confirm=t
//      For public files this returns the file directly (application/octet-stream)
//      with a Content-Length — so we get real progress, not 0%.
//   3. if it returns the HTML "virus scan" confirm page instead, parse the
//      <form action="..."> + hidden inputs (id/export/confirm/uuid) and retry
//      that exact action URL — that is the modern confirm path. (The older
//      drive.google.com/uc host loops forever on the current confirm page, so
//      the download is hand-rolled here against the usercontent endpoint.)
//   4. any text/html that is a permission/sign-in page => "make it public".
//   5. 3 attempts, logged via core/logger.
// Non-Drive URLs fall through to a plain redirect-following downloader.

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const logger = require('./logger');

const DRIVE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

class DownloadError extends Error {
  constructor(message, kind) {
    super(message);
    this.name = 'DownloadError';
    this.kind = kind || 'unknown'; // invalid-link | private | html | http-error | network | cancelled
  }
}

// A cancellation error thrown when an AbortSignal fires mid-download. Kept as a
// DownloadError so the retry loop and callers handle it uniformly via `.kind`.
function cancelledErr() { return new DownloadError('Загрузка отменена.', 'cancelled'); }

// ---------------------------------------------------------------------------
// Google Drive URL parsing
// ---------------------------------------------------------------------------

/**
 * Extract a Google Drive file id from any common share URL form.
 *   https://drive.google.com/file/d/<ID>/view[?usp=sharing]
 *   https://drive.google.com/open?id=<ID>
 *   https://drive.google.com/uc?id=<ID>
 *   https://drive.usercontent.google.com/download?id=<ID>
 *   https://docs.google.com/.../d/<ID>/...
 * Returns null if the URL is not a Google Drive file link.
 */
function parseGoogleDriveId(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const isDrive = host.endsWith('drive.google.com') || host.endsWith('docs.google.com') || host.endsWith('drive.usercontent.google.com');
    if (!isDrive) return null;
    const m1 = u.pathname.match(/\/d\/([A-Za-z0-9_-]+)/);
    if (m1) return m1[1];
    const id = u.searchParams.get('id');
    if (id) return id;
    return null;
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers (redirect-following, streaming, body draining)
// ---------------------------------------------------------------------------

/** GET a URL following 3xx redirects manually. Resolves to the final response. */
function getFollowing(url, headers, maxRedirects, signal) {
  if (maxRedirects == null) maxRedirects = 8;
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(cancelledErr());
    const lib = url.startsWith('http://') ? http : https;
    const req = lib.get(url, { headers: headers || {}, signal }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (maxRedirects <= 0) return reject(new DownloadError('Слишком много перенаправлений.', 'network'));
        const loc = res.headers.location;
        const next = /^https?:\/\//i.test(loc) ? loc : new URL(loc, url).href;
        return resolve(getFollowing(next, headers, maxRedirects - 1, signal));
      }
      resolve(res);
    });
    req.on('error', (e) => { reject(signal && signal.aborted ? cancelledErr() : e); });
    req.setTimeout(120000, () => req.destroy(new DownloadError('Превышен таймаут запроса.', 'network')));
  });
}

/** Stream a response body to a file with real progress (fraction 0..1). */
function streamToFile(res, dest, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const total = res.headers['content-length'] ? parseInt(res.headers['content-length'], 10) : null;
    const stream = fs.createWriteStream(dest);
    let received = 0;
    let done = false;
    const fail = (e) => { if (done) return; done = true; try { stream.destroy(); } catch (_) {} fs.unlink(dest, () => {}); reject(e); };
    if (signal) signal.addEventListener('abort', () => fail(cancelledErr()), { once: true });
    res.on('data', (chunk) => {
      if (signal && signal.aborted) return fail(cancelledErr());
      received += chunk.length;
      if (onProgress) onProgress(total ? received / total : 0, received, total);
    });
    res.pipe(stream);
    stream.on('finish', () => { done = true; stream.close(() => resolve(dest)); });
    stream.on('error', (e) => fail(signal && signal.aborted ? cancelledErr() : e));
    res.on('error', (e) => fail(signal && signal.aborted ? cancelledErr() : e));
  });
}

/** Read up to `max` bytes of a response into a string. */
function drainText(res, max = 512 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    res.on('data', (c) => { if (size < max) { chunks.push(c); size += c.length; } });
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    res.on('error', reject);
  });
}

/** Read the first bytes of a file (for a final HTML-vs-file sanity check). */
function readHead(file, n = 64) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, 0);
    fs.closeSync(fd);
    return buf.toString('utf8').trimStart().toLowerCase();
  } catch (_) {
    return '';
  }
}

function isHtmlContentType(ct) {
  return typeof ct === 'string' && ct.includes('text/html');
}
function isHtmlHead(head) {
  return head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('<');
}

// ---------------------------------------------------------------------------
// Google Drive confirm page / permission page detection
// ---------------------------------------------------------------------------

/**
 * Parse the HTML "virus scan" confirm page's <form action="..."> and hidden
 * inputs (id/export/confirm/uuid) into the real download URL. Modern Drive
 * points the form at https://drive.usercontent.google.com/download — that is
 * the only URL that actually serves the file. Returns null if no form found.
 */
function parseDriveFormUrl(body, fileId) {
  const actionM = body.match(/<form[^>]*action="([^"]+)"/i);
  if (!actionM) return null;
  const action = actionM[1].replace(/&amp;/g, '&');
  const inputs = {};
  const re = /<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"/gi;
  let m;
  while ((m = re.exec(body))) inputs[m[1]] = m[2];
  try {
    const u = new URL(action);
    for (const [k, v] of Object.entries(inputs)) u.searchParams.set(k, v);
    if (!u.searchParams.get('id') && fileId) u.searchParams.set('id', fileId);
    return u.href;
  } catch (_) {
    return null;
  }
}

/** A permission/sign-in page (file is private) rather than a confirm page. */
function isPermissionPage(body) {
  return /request access|sign in to continue|accounts\.google\.com\/servicelogin|you need permission|owner of this file|this file is in your trash|access denied/i.test(body);
}

function httpError(statusCode) {
  if (statusCode === 401 || statusCode === 403) {
    return new DownloadError('Доступ запрещён (HTTP 403). Откройте доступ к файлу: «Все, у кого есть ссылка».', 'private');
  }
  if (statusCode === 404) {
    return new DownloadError('Файл не найден (HTTP 404). Неверная ссылка или файл удалён.', 'invalid-link');
  }
  return new DownloadError(`Неожиданный ответ Google Drive (HTTP ${statusCode}).`, 'http-error');
}

/**
 * Single modern-Drive download pass. Hits the usercontent endpoint; if it
 * returns the HTML confirm page, parses the form and retries the form action
 * URL. Streams the final file response to outputPath with real progress.
 */
async function driveDownloadPass(fileId, outputPath, onProgress, signal) {
  if (signal && signal.aborted) throw cancelledErr();
  const headers = { 'User-Agent': DRIVE_UA, Accept: '*/*' };
  const directUrl = `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t`;
  let res = await getFollowing(directUrl, headers, undefined, signal);
  if (signal && signal.aborted) { try { res.destroy(); } catch (_) {} throw cancelledErr(); }
  if (res.statusCode !== 200) { res.resume(); throw httpError(res.statusCode); }

  if (isHtmlContentType((res.headers['content-type'] || '').toLowerCase())) {
    const body = await drainText(res);
    if (signal && signal.aborted) throw cancelledErr();
    if (isPermissionPage(body)) {
      throw new DownloadError('Файл приватный. Откройте доступ: «Все, у кого есть ссылка».', 'private');
    }
    const next = parseDriveFormUrl(body, fileId);
    if (!next) {
      throw new DownloadError('Google Drive вернул HTML без формы подтверждения. Файл приватный или ссылка недействительна.', 'html');
    }
    logger.info(`Drive confirm page detected — following form action: ${next}`);
    res = await getFollowing(next, headers, undefined, signal);
    if (signal && signal.aborted) { try { res.destroy(); } catch (_) {} throw cancelledErr(); }
    if (res.statusCode !== 200) { res.resume(); throw httpError(res.statusCode); }
    if (isHtmlContentType((res.headers['content-type'] || '').toLowerCase())) {
      const body2 = await drainText(res);
      if (isPermissionPage(body2)) {
        throw new DownloadError('Файл приватный. Откройте доступ: «Все, у кого есть ссылка».', 'private');
      }
      throw new DownloadError('Google Drive вернул HTML даже после подтверждения. Файл приватный или ссылка недействительна.', 'html');
    }
  }

  // Final response is the file — stream it to disk with real progress.
  await streamToFile(res, outputPath, onProgress, signal);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Universal Google Drive downloader (modern flow via drive.usercontent.google.com).
 * @param {string} url   any Google Drive share URL
 * @param {string} outputPath  absolute destination file path
 * @param {(p:number)=>void} [onProgress]  fraction 0..1 (real, from Content-Length)
 * @returns {Promise<string>} outputPath on success
 * @throws {DownloadError} with a `.kind` of invalid-link | private | html | http-error | network
 */
async function downloadFromGoogleDrive(url, outputPath, onProgress, signal) {
  const fileId = parseGoogleDriveId(url);
  if (!fileId) {
    throw new DownloadError('Неверная ссылка Google Drive — не удалось извлечь ID файла.', 'invalid-link');
  }
  logger.info(`Google Drive download: id=${fileId} -> ${outputPath}`);

  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      if (signal && signal.aborted) throw cancelledErr();
      if (onProgress) onProgress(0);
      await driveDownloadPass(fileId, outputPath, onProgress, signal);
      const head = readHead(outputPath);
      if (isHtmlHead(head)) {
        fs.rmSync(outputPath, { force: true });
        throw new DownloadError('Google Drive вернул HTML-страницу вместо файла. Файл приватный или ссылка недействительна.', 'html');
      }
      logger.success(`Downloaded from Google Drive (id=${fileId}): ${fs.statSync(outputPath).size} bytes -> ${outputPath}`);
      if (onProgress) onProgress(1);
      return outputPath;
    } catch (e) {
      lastErr = e instanceof DownloadError ? e : new DownloadError(e.message, 'network');
      logger.warn(`Drive download attempt ${attempt}/3 failed (${lastErr.kind}): ${lastErr.message}`);
      fs.rmSync(outputPath, { force: true });
      // Cancellation and permanent errors — don't waste retries.
      if (lastErr.kind === 'cancelled' || lastErr.kind === 'private' || lastErr.kind === 'invalid-link') break;
    }
  }
  throw lastErr;
}

/**
 * Plain (non-Drive) download with redirect following. Rejects HTML responses
 * so a misconfigured direct link doesn't silently save a web page.
 */
async function downloadDirect(url, dest, onProgress, signal) {
  logger.info(`Direct download: ${url} -> ${dest}`);
  if (signal && signal.aborted) throw cancelledErr();
  const res = await getFollowing(url, { 'User-Agent': DRIVE_UA, Accept: '*/*' }, undefined, signal);
  if (signal && signal.aborted) { try { res.destroy(); } catch (_) {} throw cancelledErr(); }
  if (res.statusCode !== 200) { res.resume(); throw new DownloadError(`HTTP ${res.statusCode} для ${url}`, 'http-error'); }
  if (isHtmlContentType((res.headers['content-type'] || '').toLowerCase())) {
    res.resume();
    throw new DownloadError('Сервер вернул HTML-страницу вместо файла. Проверьте прямую ссылку.', 'html');
  }
  await streamToFile(res, dest, onProgress, signal);
  const head = readHead(dest);
  if (isHtmlHead(head)) {
    fs.rmSync(dest, { force: true });
    throw new DownloadError('Скачанный файл оказался HTML-страницей. Проверьте прямую ссылку.', 'html');
  }
  if (onProgress) onProgress(1);
  return dest;
}

/**
 * Public entry point used by the installer: download a single plugin file to
 * a temp directory. Routes Google Drive URLs to downloadFromGoogleDrive and
 * everything else to the plain downloader.
 * @returns {Promise<string>} absolute path of the downloaded file
 */
async function downloadPlugin(plugin, tmpDir, onProgress, signal) {
  const fileId = parseGoogleDriveId(plugin.downloadUrl);
  const dest = path.join(tmpDir, plugin.fileName);
  // Forward received/total (streamToFile already has them) so callers can show
  // a live download speed — not just a bare fraction.
  const report = (frac, received, total) => { if (onProgress) onProgress(Math.min(0.99, frac), received, total); };

  try { fs.mkdirSync(tmpDir, { recursive: true }); } catch (_) {}

  if (fileId) {
    await downloadFromGoogleDrive(plugin.downloadUrl, dest, report, signal);
  } else {
    await downloadDirect(plugin.downloadUrl, dest, report, signal);
  }

  if (onProgress) onProgress(1);
  return dest;
}

module.exports = { downloadPlugin, downloadFromGoogleDrive, parseGoogleDriveId, DownloadError };