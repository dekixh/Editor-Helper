#!/usr/bin/env node
// scripts/release.js — publish a GitHub Release for the portable Editor Helper.
//
// Usage:
//   node scripts/release.js              # build + publish (prerelease if version has -beta/-alpha/-rc)
//   node scripts/release.js --no-build   # skip `npm run dist`, use existing dist/Editor-Helper.exe
//   node scripts/release.js --prerelease # force prerelease:true
//   node scripts/release.js --repo owner/repo  # override (default dekixh/Editor-Helper-Lite)
//
// Auth: pulls a token from the local git credential helper (git credential fill
// for https://github.com), so no GH_TOKEN env var is needed. Requires the stored
// credential to have push/admin on the repo (it does for dekixh/Editor-Helper-Lite).

const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

const DEFAULT_REPO = 'dekixh/Editor-Helper-Lite';
const ASSET_NAME = 'Editor-Helper.exe';
const ROOT = path.resolve(__dirname, '..');
const DIST_EXE = path.join(ROOT, 'dist', ASSET_NAME);
const UA = 'Editor-Helper-Release';

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const noBuild = argv.includes('--no-build');
const forcePre = argv.includes('--prerelease');
const repoArg = (argv.find((a) => a.startsWith('--repo=')) || '').split('=')[1];
const REPO = repoArg || DEFAULT_REPO;

// ── token via git credential fill ───────────────────────────────────────────
function getToken() {
  return new Promise((resolve, reject) => {
    const p = spawn('git', ['credential', 'fill'], { stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error('git credential fill failed'));
      const m = out.match(/^password=(.+)$/m);
      if (!m) return reject(new Error('no password in git credentials'));
      resolve(m[1].trim());
    });
    p.stdin.write('protocol=https\nhost=github.com\n\n');
    p.stdin.end();
  });
}

// ── github helpers ───────────────────────────────────────────────────────────
async function gh(token, method, url, { body, raw, contentType } = {}) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': UA,
    Authorization: `token ${token}`,
  };
  let payload;
  if (raw) {
    payload = raw;
    headers['Content-Type'] = contentType || 'application/octet-stream';
    headers['Content-Length'] = String(Buffer.byteLength(raw));
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, { method, headers, body: payload, redirect: 'manual' });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, ok: res.ok, json, text, headers: res.headers };
}

// Keep `latest.txt` on main pointing at the newest asset download URL. The web
// installer (Editor-Helper-Setup.exe) reads this single line to know which exe
// to fetch, so the setup exe stays version-agnostic. Uses the Contents API so
// it works headlessly (no local git needed).
async function updatePointer(token, assetUrl) {
  const apiUrl = `https://api.github.com/repos/${REPO}/contents/latest.txt`;
  const get = await gh(token, 'GET', apiUrl);
  let sha = null;
  if (get.ok && get.json && get.json.sha) sha = get.json.sha;
  const content = Buffer.from(assetUrl + '\n').toString('base64');
  const put = await gh(token, 'PUT', apiUrl, {
    body: {
      message: 'chore: update latest.txt pointer [skip ci]',
      content,
      branch: 'main',
      ...(sha ? { sha } : {}),
    },
  });
  if (!put.ok) throw new Error(`update latest.txt ${put.status}: ${put.text}`);
  console.log(`✓ latest.txt → ${assetUrl}`);
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const version = pkg.version;
  const tag = `v${version}`;
  const isPre = forcePre || /-(beta|alpha|rc|pre)/i.test(version);
  console.log(`→ ${REPO}  tag=${tag}  prerelease=${isPre}`);

  // 1. build (unless --no-build)
  if (!noBuild) {
    if (!fs.existsSync(path.join(ROOT, 'node_modules'))) {
      throw new Error('node_modules not found — run `npm install` first');
    }
    console.log('→ building portable exe (npm run dist)…');
    execSync('npm run dist', { cwd: ROOT, stdio: 'inherit', shell: true });
  }
  if (!fs.existsSync(DIST_EXE)) {
    throw new Error(`built exe missing: ${DIST_EXE}`);
  }
  const size = fs.statSync(DIST_EXE).size;
  console.log(`→ asset ${ASSET_NAME} (${(size / 1048576).toFixed(1)} MB)`);

  // 2. token
  const token = await getToken();
  console.log('→ git token obtained');

  // 3. create release
  const bodyText = [
    `Editor Helper ${version}`,
    '',
    'Установите, обновившись из самой программы (Настройки → Обновления программы),',
    'или скачав файл вручную.',
    isPre ? '\n⚠ Это бета-версия.' : '',
  ].join('\n');
  const create = await gh(token, 'POST', `https://api.github.com/repos/${REPO}/releases`, {
    body: {
      tag_name: tag,
      target_commitish: 'main',
      name: `Editor Helper ${version}`,
      body: bodyText,
      draft: false,
      prerelease: isPre,
    },
  });
  if (!create.ok) {
    throw new Error(`create release ${create.status}: ${create.text}`);
  }
  const rel = create.json;
  console.log(`→ release created: ${rel.html_url}`);
  // upload_url looks like https://uploads.github.com/repos/.../releases/123/assets{?name,label}
  const uploadBase = rel.upload_url.replace(/\{[^}]*\}$/, '');

  // 4. upload asset
  const data = fs.readFileSync(DIST_EXE);
  const up = await gh(token, 'POST', `${uploadBase}?name=${encodeURIComponent(ASSET_NAME)}`, {
    raw: data, contentType: 'application/vnd.microsoft.portable-executable',
  });
  if (!up.ok) {
    throw new Error(`upload asset ${up.status}: ${up.text}`);
  }
  console.log(`✓ uploaded ${ASSET_NAME} → ${up.json.browser_download_url}`);

  // 5. update latest.txt pointer for the web installer
  await updatePointer(token, up.json.browser_download_url);

  // 6. (optional) attach the version-agnostic web installer to this release too
  const setupExe = path.join(ROOT, 'dist', 'Editor-Helper-Setup.exe');
  if (fs.existsSync(setupExe)) {
    const sd = fs.readFileSync(setupExe);
    const su = await gh(token, 'POST', `${uploadBase}?name=${encodeURIComponent('Editor-Helper-Setup.exe')}`, {
      raw: sd, contentType: 'application/vnd.microsoft.portable-executable',
    });
    if (su.ok) console.log(`✓ uploaded Editor-Helper-Setup.exe → ${su.json.browser_download_url}`);
    else console.log(`! setup asset upload ${su.status} (ignored)`);
  }

  console.log(`✓ done: ${rel.html_url}`);
}

main().catch((e) => {
  console.error('✗', e.message || e);
  process.exit(1);
});