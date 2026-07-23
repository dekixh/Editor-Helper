// core/server.js — HTTP client for the remote plugin catalog (no auth).
//
// Contract the app expects from the server:
//   GET {serverUrl}/plugins  -> 200 + JSON { "plugins": [ ...catalog entries... ] }
//   GET {serverUrl}/apps     -> 200 + JSON { "apps":     [ ...catalog entries... ] }
// The catalog entries use the same schema as the old local plugins.json:
//   id, name, type, description, rating?, author?, tags?, icon? (URL),
//   installPath?, installMode?, and either flat (version/fileName/downloadUrl)
//   or versions:[{version, fileName, downloadUrl, installPath?, installMode?, changelog?}].
//   downloadUrl may be a Google Drive share link or a direct file URL.
// fetchCatalog() merges /plugins and /apps into one { plugins: [...] } object.

const logger = require('./logger');
const settings = require('./settings');

function joinUrl(base, sub) {
  return String(base || '').replace(/\/+$/, '') + '/' + String(sub).replace(/^\/+/, '');
}

async function fetchJson(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 10000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} ${res.statusText || ''}`.trim());
      err.status = res.status;
      throw err;
    }
    const text = await res.text();
    try { return JSON.parse(text); }
    catch (_) { throw new Error('Сервер вернул не JSON'); }
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Таймаут соединения');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch the full catalog from the server: pulls BOTH /plugins and /apps (the
 * backend stores items with kind 'plugin' | 'app' on separate endpoints) and
 * merges them into one { plugins: [...] } object the client normalizes.
 */
async function fetchCatalog(serverUrl) {
  if (!serverUrl) throw new Error('Сервер не настроен');
  const getOne = async (kind) => {
    const url = joinUrl(serverUrl, kind + 's');
    logger.info(`Fetching catalog: ${url}`);
    return fetchJson(url, 12000);
  };
  const pr = await getOne('plugin');
  let ar;
  try { ar = await getOne('app'); } catch (_) { ar = { apps: [] }; }
  const plugins = (pr && Array.isArray(pr.plugins)) ? pr.plugins : [];
  const apps = (ar && Array.isArray(ar.apps)) ? ar.apps : [];
  return { plugins: plugins.concat(apps) };
}

/**
 * JSON request against the backend (items/versions CRUD for the in-app editor).
 * Returns parsed JSON on 2xx; throws an Error carrying .status otherwise.
 */
async function adminJson(path, { method = 'GET', body, timeoutMs = 15000 } = {}) {
  const s = settings.get();
  if (!s.serverUrl) throw new Error('Сервер не настроен');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(joinUrl(s.serverUrl, path), {
      method,
      signal: ctrl.signal,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) {}
    if (!res.ok) {
      const err = new Error((json && json.error) || `HTTP ${res.status}`);
      err.status = res.status;
      err.json = json;
      throw err;
    }
    return json;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Таймаут соединения');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ── Item/version CRUD (used by the in-app editor's server-sync mode) ─────────
async function listItems() {
  const r = await adminJson('items');
  return (r && Array.isArray(r.items)) ? r.items : [];
}
async function getItem(id) {
  return await adminJson('items/' + encodeURIComponent(id));
}
async function createItem(b) {
  return await adminJson('items', { method: 'POST', body: b });
}
async function updateItem(id, b) {
  return await adminJson('items/' + encodeURIComponent(id), { method: 'PATCH', body: b });
}
async function deleteItem(id) {
  await adminJson('items/' + encodeURIComponent(id), { method: 'DELETE' });
}
async function upsertVersion(itemId, b) {
  // POST /items/:id/versions is an upsert on (item_id, version) — re-posting
  // the same version label updates its fields. Lets the editor save changed
  // versions without tracking which ones changed.
  return await adminJson('items/' + encodeURIComponent(itemId) + '/versions', { method: 'POST', body: b });
}
async function deleteVersion(itemId, vid) {
  await adminJson('items/' + encodeURIComponent(itemId) + '/versions/' + encodeURIComponent(vid), { method: 'DELETE' });
}

/** Connectivity test. Tries /plugins (the required endpoint). */
async function ping(serverUrl) {
  const data = await fetchCatalog(serverUrl);
  if (!data || (typeof data !== 'object')) throw new Error('Некорректный ответ');
  return data;
}

module.exports = {
  fetchCatalog, ping, joinUrl,
  adminJson, listItems, getItem, createItem, updateItem, deleteItem,
  upsertVersion, deleteVersion,
};