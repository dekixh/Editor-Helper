// core/updater.js — self-update the PORTABLE Editor Helper app from GitHub Releases.
//
// No token, no electron-updater: the app checks the PUBLIC GitHub Releases API
// for the latest release of `settings.update.repo` ("owner/repo"). If its tag
// (vX.Y.Z) is newer than app.getVersion() and the release has an asset named
// "Editor-Helper.exe", we download that asset, then a detached PowerShell helper
// waits for this process to exit, overwrites the portable launcher
// (PORTABLE_EXECUTABLE_FILE, set by the electron-builder portable wrapper) with
// the downloaded exe, and relaunches it. The next launch extracts the new
// version. Works for a public repo; a private repo would need a token header.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const logger = require('./logger');

const UA = 'Editor-Helper-Updater';
const ASSET_NAME = 'Editor-Helper.exe';

// ── semver helpers (simple, no pre-release) ─────────────────────────────────
function parseSemver(tag) {
  const s = String(tag || '').replace(/^v/i, '').trim();
  const m = s.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [+m[1], +m[2], +m[3]];
}
function cmpVer(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

// ── GitHub Releases latest lookup ────────────────────────────────────────────
// Returns { tag, version:[M,m,p], downloadUrl, notes, name, size, htmlUrl } or
// null if the repo has no usable release. Uses the releases LIST endpoint (not
// /releases/latest) so pre-release/beta builds are also detected; among all
// releases that carry an `Editor-Helper.exe` asset it picks the highest semver.
// Throws on network/HTTP errors.
async function fetchLatestRelease(repo) {
  const url = `https://api.github.com/repos/${repo}/releases?per_page=50`;
  const res = await fetch(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': UA },
  });
  if (res.status === 404) return null; // repo not found / no access
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  const list = await res.json();
  if (!Array.isArray(list) || !list.length) return null;
  let best = null;
  for (const j of list) {
    const tag = j.tag_name || '';
    const version = parseSemver(tag);
    if (!version) continue; // skip non-semver tags
    if (j.draft) continue; // drafts are not published
    const asset = (Array.isArray(j.assets) ? j.assets : []).find(
      (a) => a && a.name === ASSET_NAME,
    );
    if (!asset || !asset.browser_download_url) continue; // no installable asset
    const cand = {
      tag,
      version,
      downloadUrl: asset.browser_download_url,
      name: j.name || tag,
      notes: j.body || '',
      size: asset.size || 0,
      htmlUrl: j.html_url || '',
      prerelease: !!j.prerelease,
    };
    if (!best || cmpVer(cand.version, best.version) > 0) best = cand;
  }
  return best;
}

/**
 * Compare the latest GitHub release to the running app version.
 * @returns { available:boolean, latest:object|null, current:[M,m,p] }
 */
async function checkForUpdate(repo) {
  const { app } = require('electron');
  const current = parseSemver(app.getVersion()) || [0, 0, 0];
  if (!repo || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) {
    throw new Error('Репозиторий не задан (owner/repo)');
  }
  const latest = await fetchLatestRelease(repo);
  if (!latest) return { available: false, latest: null, current };
  const available = cmpVer(latest.version, current) > 0;
  return { available, latest, current };
}

// ── download ────────────────────────────────────────────────────────────────
// Streams the asset to a temp file. onProgress(frac, received, total).
async function downloadAsset(url, destPath, onProgress) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Загрузка ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const out = fs.createWriteStream(destPath);
  let received = 0;
  // res.body is an async-iterable web stream (Node/Electron fetch).
  for await (const chunk of res.body) {
    out.write(Buffer.from(chunk));
    received += chunk.length;
    if (typeof onProgress === 'function') {
      onProgress(total ? received / total : 0, received, total);
    }
  }
  await new Promise((resolve, reject) => { out.end(resolve); out.on('error', reject); });
  return { received, total };
}

// ── install + relaunch ──────────────────────────────────────────────────────
// Spawns a detached PowerShell helper that waits for this process to exit,
// overwrites the portable launcher with the downloaded exe, and relaunches it.
// Call app.exit(0) right after this returns.
function installAndRelaunch(newExePath) {
  const { app } = require('electron');
  const target = process.env.PORTABLE_EXECUTABLE_FILE || app.getPath('exe');
  const pid = process.pid;
  const script = `
$ErrorActionPreference = 'Stop'
try { if ($pid) { Wait-Process -Id ${pid} -Timeout 30 -ErrorAction SilentlyContinue } } catch {}
Start-Sleep -Milliseconds 400
try {
  Copy-Item -LiteralPath '${newExePath.replace(/'/g, "''")}' -Destination '${target.replace(/'/g, "''")}' -Force
  Remove-Item -LiteralPath '${newExePath.replace(/'/g, "''")}' -Force -ErrorAction SilentlyContinue
  Start-Process -FilePath '${target.replace(/'/g, "''")}'
} catch {
  # Last-resort: retry once elevated (e.g. launcher in a protected folder).
  Start-Process -FilePath 'powershell' -Verb RunAs -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-Command',"Copy-Item -LiteralPath ''${newExePath.replace(/'/g, "''")}'' -Destination ''${target.replace(/'/g, "''")}'' -Force; Start-Process -FilePath ''${target.replace(/'/g, "''")}''") -ErrorAction SilentlyContinue
}
`.trim();

  const scriptPath = path.join(os.tmpdir(), `editor-helper-update-${Date.now()}.ps1`);
  fs.writeFileSync(scriptPath, script, 'utf8');
  logger.info(`Update: relaunch helper -> ${scriptPath}`);
  logger.info(`Update: target launcher -> ${target}`);
  const child = spawn('powershell', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', scriptPath,
  ], { detached: true, stdio: 'ignore' });
  child.unref();
  return { scriptPath, target };
}

module.exports = { checkForUpdate, downloadAsset, installAndRelaunch, parseSemver, cmpVer, ASSET_NAME };