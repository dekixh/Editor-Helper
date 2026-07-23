// ui/renderer.js — renderer-side app logic. Talks to main only via window.api.
// No direct filesystem or network access here (sandboxed renderer).

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
// Play a UI cue (no-op if the sound engine isn't loaded). See ui/sound.js.
const sfx = (name) => { if (window.sfx) window.sfx.play(name); };

// Format a bytes/second rate for the download speed readout (Russian units).
function fmtSpeed(bps) {
  if (!bps || bps <= 0) return '';
  const units = ['Б/с', 'КБ/с', 'МБ/с', 'ГБ/с'];
  let v = bps, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (v >= 100 ? Math.round(v) : v.toFixed(1)) + ' ' + units[i];
}

// ---------- Custom titlebar controls ----------
function setMaxIcon(isMax) {
  const max = $('#btnMax');
  if (!max) return;
  max.querySelector('.ico-max').style.display = isMax ? 'none' : '';
  max.querySelector('.ico-restore').style.display = isMax ? '' : 'none';
  max.title = isMax ? 'Восстановить' : 'Развернуть';
}
$('#btnMin').addEventListener('click', () => window.api.winMinimize());
$('#btnMax').addEventListener('click', () => window.api.winMaximizeToggle());
$('#btnClose').addEventListener('click', () => window.api.winClose());
window.api.onMaximizeChange((isMax) => setMaxIcon(isMax));
window.api.winIsMaximized().then(setMaxIcon);

// ---------- State ----------
const state = {
  plugins: [],
  versions: [],
  activeVersion: null,
  category: 'all',  // all | installed | script | plugin | app | favorites | settings
  sort: 'popular',
  query: '',
  statuses: {},   // id -> { status, detail, installedVersion }
  busy: {},       // id -> true while installing
  cancelEls: {},  // id -> [cancel button elements] shown during a download
  userCancel: {}, // id -> true once the user clicks "Отмена" (so we can show a
                  //           neutral "Отменено" even if the abort surfaces as a
                  //           generic error rather than a kind:'cancelled' one)
  running: {},     // id -> true while the launched program is running (Запустить -> Закрыть)
  selVersion: {}, // id -> selected version string
  favorites: loadFavorites(),   // Set<string>
  selectedId: null,             // plugin currently shown in the detail panel
  isAdmin: false,               // lite variant: no in-app catalog editor — admin off
  removing: new Set(),          // id -> true while uninstalling
  multi: false,                 // multi-select (batch remove) mode on/off
  multiSelected: new Set(),     // selected plugin ids while in multi mode
  dl: {},                       // id -> { t, bytes, lastSpeed } live download-speed trackers
};

// ---------- Favorites (persisted in localStorage; no IPC needed) ----------
function loadFavorites() {
  try { return new Set(JSON.parse(localStorage.getItem('aepm_favorites') || '[]')); }
  catch (_) { return new Set(); }
}
function saveFavorites() {
  try { localStorage.setItem('aepm_favorites', JSON.stringify([...state.favorites])); }
  catch (_) {}
}
function toggleFavorite(id) {
  if (state.favorites.has(id)) state.favorites.delete(id);
  else state.favorites.add(id);
  saveFavorites();
}

// ---------- Type icons fallback ----------
const TYPE_ICONS = { script: 'Js', plugin: 'Pl', preset: 'Pr', app: 'Ap' };

/** Build a resolved plugin object (top-level merged with the selected version). */
function resolvePlugin(p) {
  const ver = getVersionEntry(p);
  return {
    ...p,
    version: ver.version,
    fileName: ver.fileName || p.fileName,
    downloadUrl: ver.downloadUrl,
    installPath: ver.installPath || p.installPath,
    installMode: ver.installMode || p.installMode || 'copy',
  };
}
function getVersionEntry(p) {
  const sel = state.selVersion[p.id];
  return p.versions.find((v) => v.version === sel) || p.versions[0]
    || { version: '', fileName: '', downloadUrl: '', installPath: '', installMode: '' };
}
function pickDefaultVersion(p, installedVersion) {
  if (!p.versions.length) return '';
  if (installedVersion && p.versions.some((v) => v.version === installedVersion)) return installedVersion;
  return p.versions[0].version;
}
// Whether an install actually needs a chosen After Effects version. Apps
// (installPath under "applications/") and "run" mode installers don't touch
// any AE-specific folder, so they can be installed without selecting AE.
function needsAeVersion(rp) {
  const mode = (rp.installMode || 'copy').toLowerCase();
  if (mode === 'run') return false;
  return !(rp.installPath || '').toLowerCase().startsWith('applications');
}
function avatarUrl(p) {
  const icon = p.iconResolved || p.icon || '';
  if (!icon) return '';
  if (/^(https?:|data:|file:)/i.test(icon)) return icon;
  return 'file:///' + String(icon).replace(/\\/g, '/');
}
function ratingOf(p) {
  const r = Number(p.rating);
  return isFinite(r) ? Math.max(0, Math.min(5, r)) : 0;
}

// ---------- Init ----------
async function init() {
  setConn('загрузка…', false);
  const res = await window.api.init();
  // Show the real app version (package.json via Electron) in the titlebar,
  // replacing the static HTML placeholder.
  const verEl = document.querySelector('.titlebar-version');
  if (verEl && res.appVersion) verEl.textContent = 'v' + res.appVersion;
  // AE versions are returned even on failure so the version selector stays useful.
  state.versions = res.versions || [];
  state.activeVersion = res.activeVersion || null;
  renderVersions();

  if (!res.ok) {
    state.plugins = [];
    state.statuses = {};
    renderGrid();
    updateCounts();
    updateStats();
    setConn('нет каталога', true);
    toast(res.error || 'Каталог недоступен', 'err');
    return;
  }

  state.plugins = res.plugins || [];
  if (res.warning) toast(res.warning, 'warn');
  await refreshAllStatuses();
  for (const p of state.plugins) {
    state.selVersion[p.id] = pickDefaultVersion(p, state.statuses[p.id]?.installedVersion);
  }
  renderGrid();
  updateCounts();
  updateStats();
  setConn('готово', false);
  // Start polling which launched programs are running (Запустить -> Закрыть).
  startRunningPoller();
}

/**
 * Re-pull the catalog from the server (falls back to local per loadServerCatalog)
 * and re-render. This is what makes new items an admin published appear for
 * regular users without restarting. `silent` suppresses the always-toast and
 * only notifies when new entries actually showed up (used by auto-refresh).
 */
async function reloadCatalog({ silent = false } = {}) {
  try {
    const res = await window.api.reloadConfig();
    if (!res || !res.ok) { if (!silent) toast('Каталог недоступен', 'err'); return; }
    const prevIds = new Set((state.plugins || []).map((p) => p.id));
    const prevSel = state.selectedId;
    state.plugins = res.plugins || [];
    if (res.warning && !silent) toast(res.warning, 'warn');
    if (prevSel && !state.plugins.some((p) => p.id === prevSel)) closeDetail();
    for (const p of state.plugins) {
      if (!state.selVersion[p.id]) state.selVersion[p.id] = pickDefaultVersion(p, state.statuses[p.id]?.installedVersion);
    }
    await refreshAllStatuses();
    renderGrid();
    updateCounts();
    updateStats();
    if (state.selectedId) renderDetail();
    const newCount = state.plugins.filter((p) => !prevIds.has(p.id)).length;
    if (!silent) {
      toast(newCount > 0 ? `Каталог обновлён: +${newCount}` : 'Каталог обновлён', 'ok');
    } else if (newCount > 0) {
      toast(`Появились новые записи: +${newCount}`, 'ok');
    }
  } catch (e) {
    if (!silent) toast('Ошибка обновления каталога: ' + e.message, 'err');
  }
}

function setConn(text, isError) {
  $('#connText').textContent = text;
  $('#connDot').style.background = isError ? 'var(--err)' : 'var(--ok)';
  $('#connDot').style.boxShadow = isError ? '0 0 8px var(--err)' : '0 0 8px var(--ok)';
}

// ---------- Version selector ----------
function renderVersions() {
  const sel = $('#versionSelect');
  sel.innerHTML = '';
  if (!state.versions.length) {
    sel.innerHTML = '<option value="__none__">After Effects не найден</option>';
    $('#versionHint').innerHTML = 'AE не обнаружен. Выберите папку вручную (ниже в списке).';
  } else {
    for (const v of state.versions) {
      const opt = document.createElement('option');
      opt.value = JSON.stringify(v);
      opt.textContent = v.version + (v.supportFiles ? '' : ' (user)');
      sel.appendChild(opt);
    }
    if (state.activeVersion) sel.value = JSON.stringify(state.activeVersion);
    $('#versionHint').textContent = state.versions.length > 1
      ? `Найдено версий: ${state.versions.length}. Выбрана новейшая.`
      : '';
  }
  // Always offer manual folder selection — covers non-standard AE installs.
  const pick = document.createElement('option');
  pick.value = '__pick__';
  pick.textContent = '＋ Выбрать папку AE вручную…';
  sel.appendChild(pick);
}

$('#versionSelect').addEventListener('change', async (e) => {
  const val = e.target.value;
  if (val === '__pick__') {
    const r = await window.api.pickAeFolder();
    if (r && r.ok) {
      state.versions = r.versions || state.versions;
      state.activeVersion = r.version;
      renderVersions();
      await refreshAllStatuses();
      renderGrid();
      if (state.selectedId) renderDetail();
      toast('Папка After Effects добавлена', 'ok');
    } else {
      if (r && r.error) toast(r.error, 'err');
      renderVersions(); // reset the dropdown to the active/none option
    }
    return;
  }
  if (val === '__none__') return;
  state.activeVersion = JSON.parse(val);
  await refreshAllStatuses();
  renderGrid();
  if (state.selectedId) renderDetail();
});

// ---------- Status ----------
// One bulk IPC call: main does a single (cached, non-blocking) registry scan
// shared across all run-mode entries and checks copy/both entries concurrently.
// This replaces N serial blocking status round-trips that froze the UI on startup.
async function refreshAllStatuses() {
  if (!state.plugins.length) { state.statuses = {}; return; }
  // Build the resolved list, skipping AE-dependent entries when no AE version is
  // selected (they'd just report not-installed); apps/run entries don't need AE.
  const toCheck = [];
  for (const p of state.plugins) {
    if (p.comingSoon) continue; // announcement — nothing to install/check
    const rp = resolvePlugin(p);
    if (needsAeVersion(rp) && !state.activeVersion) continue;
    toCheck.push(rp);
  }
  if (!toCheck.length) { state.statuses = {}; return; }
  let res;
  try { res = await window.api.statusAll(toCheck, state.activeVersion); }
  catch (e) { toast(`Не удалось получить статусы: ${e.message || e}`, 'err'); return; }
  const statuses = (res && res.ok && res.statuses) ? res.statuses : {};
  for (const rp of toCheck) {
    if (statuses[rp.id]) state.statuses[rp.id] = statuses[rp.id];
  }
}

// ---------- Filtering + sorting ----------
function visiblePlugins() {
  const q = state.query.trim().toLowerCase();
  let list = state.plugins.filter((p) => {
    const st = state.statuses[p.id]?.status;
    if (state.category === 'favorites' && !state.favorites.has(p.id)) return false;
    if (state.category === 'installed' && st !== 'installed') return false;
    if (['script', 'plugin', 'app'].includes(state.category) && p.type !== state.category) return false;
    if (!q) return true;
    return (
      p.name.toLowerCase().includes(q) ||
      p.description.toLowerCase().includes(q) ||
      p.author.toLowerCase().includes(q) ||
      p.tags.some((t) => t.toLowerCase().includes(q))
    );
  });

  const byName = (a, b) => a.name.localeCompare(b.name, 'ru');
  switch (state.sort) {
    case 'az': list.sort(byName); break;
    case 'za': list.sort((a, b) => byName(b, a)); break;
    case 'installed':
      list.sort((a, b) => {
        const ai = state.statuses[a.id]?.status === 'installed' ? 0 : 1;
        const bi = state.statuses[b.id]?.status === 'installed' ? 0 : 1;
        return ai - bi || ratingOf(b) - ratingOf(a);
      });
      break;
    default: list.sort((a, b) => ratingOf(b) - ratingOf(a)); // popular
  }
  return list;
}

// ---------- Counts in the sidebar ----------
function updateCounts() {
  const counts = { all: state.plugins.length, installed: 0, script: 0, plugin: 0, app: 0, favorites: 0 };
  for (const p of state.plugins) {
    const st = state.statuses[p.id]?.status;
    if (st === 'installed') counts.installed++;
    if (p.type === 'script') counts.script++;
    if (p.type === 'plugin') counts.plugin++;
    if (p.type === 'app') counts.app++;
    if (state.favorites.has(p.id)) counts.favorites++;
  }
  $$('.cat-count').forEach((el) => {
    const key = el.dataset.count;
    if (key && counts[key] !== undefined) el.textContent = counts[key];
  });
}

// ---------- Render grid ----------
function renderGrid() {
  const grid = $('#grid');
  grid.innerHTML = '';
  const list = visiblePlugins();
  $('#emptyState').classList.toggle('hidden', list.length > 0);
  for (const p of list) grid.appendChild(buildCard(p));
  // No JS layout logic needed: .grid is a CSS Grid with fixed 290px columns
  // (repeat(auto-fill, 290px), justify-content: start). Cards never stretch —
  // on a wider window more columns appear, on a narrower one they wrap. Card
  // width/height stay uniform (name 2-line clamp, desc 2-line clamp, tags row
  // reserved); the foot is pinned to the bottom via margin-top:auto. Re-layout
  // is handled purely by CSS on resize.
}

function buildCard(p) {
  const sel = getVersionEntry(p);
  const st = state.statuses[p.id] || { status: 'not-installed', detail: '' };
  const busy = !!state.busy[p.id];
  const multi = p.versions.length > 1;

  const card = document.createElement('div');
  card.className = 'card'
    + (state.selectedId === p.id ? ' selected' : '')
    + (state.multi ? ' multi-mode' : '')
    + (state.multiSelected.has(p.id) ? ' multisel' : '');
  card.dataset.id = p.id;

  // "СКОРО выйдет" announcement: no download yet, so the card is a simple
  // teaser — a СКОРО badge and a "Скоро выйдет" label instead of install/launch
  // buttons. Favorite + selection still work.
  if (p.comingSoon) {
    card.classList.add('coming-soon');
    const av = avatarUrl(p);
    const iconHTML = av
      ? `<img class="avatar-img" src="${escapeHtml(av)}" alt="" draggable="false">`
      : (TYPE_ICONS[p.type] || 'Pl');
    const favOn = state.favorites.has(p.id);
    card.innerHTML = `
      <button class="fav-btn ${favOn ? 'on' : ''}" data-action="fav" title="${favOn ? 'Убрать из избранного' : 'В избранное'}" aria-label="Избранное">
        <svg viewBox="0 0 18 18"><path d="M9 2.6l1.9 4 4.1.5-3 2.8.8 4.1-3.8-2.1-3.8 2.1.8-4.1-3-2.8 4.1-.5z" fill="${favOn ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>
      </button>
      <div class="card-inner">
        <div class="card-head">
          <div class="card-check" data-action="check" aria-label="Выбрать" role="checkbox"></div>
          <div class="card-icon type-${p.type}">${iconHTML}</div>
          <div class="card-titlewrap">
            <div class="card-name">${escapeHtml(p.name)}</div>
            <div class="card-meta">
              <span class="card-soon-badge">СКОРО</span>
              <span class="card-type-badge">${escapeHtml(p.type)}</span>
              ${p.author ? `<span>${escapeHtml(p.author)}</span>` : ''}
            </div>
          </div>
        </div>
        <div class="card-desc">${escapeHtml(p.description) || '—'}</div>
        <div class="card-tags">${p.tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>
        <div class="card-foot">
          <div class="foot-left"><div class="status soon"><span class="sdot"></span><span>Анонс</span></div></div>
          <div class="foot-btns"><span class="card-soon-label">Скоро выйдет</span></div>
        </div>
      </div>
    `;
    card.addEventListener('click', (e) => {
      if (state.multi) { toggleMultiSel(p.id); return; }
      if (e.target.closest('[data-action]')) return;
      selectPlugin(p.id);
    });
    card.querySelector('.fav-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFavorite(p.id);
      if (state.category === 'favorites') renderGrid();
      if (state.selectedId === p.id) renderDetail();
    });
    return card;
  }

  const statusText = {
    installed: 'Установлено',
    'update-available': 'Доступно обновление',
    'not-installed': 'Не установлено',
  }[st.status] || 'Не установлено';

  const mode = (sel.installMode || p.installMode || 'copy').toLowerCase();
  const modeBadge = { copy: 'Копирование', run: 'Установщик', both: 'Копирование + запуск' }[mode] || 'Копирование';

  // A "Запустить" button for installed programs (run / both modes — apps with an
  // .exe to run; pure copy-mode plugins are not launchable). Wired to onLaunch.
  const isProgram = (mode === 'run' || mode === 'both');
  const showLaunchCard = isProgram && (st.status === 'installed' || st.status === 'update-available');
  // When the program is installed, "Запустить" is the primary action and
  // "Переустановить" is demoted to a secondary compact button — a swap of both
  // position and style. Only the installed state swaps; "Обновить" keeps its own
  // look and copy-mode plugins have no launch button.
  const launchPrimary = isProgram && st.status === 'installed';
  // "Переустановить" is gone: once installed, the install/reinstall button is
  // not shown (the user asked to remove it). Keep "Установить"/"Обновить" for
  // the not-installed / update-available states, and keep the button while an
  // install is in flight so the progress bar has a home.
  const showInstallCard = busy || st.status !== 'installed';

  let btnLabel = 'Установить', btnClass = '';
  if (busy) { btnLabel = 'Устанавливается…'; btnClass = ''; }
  else if (mode === 'run') { btnLabel = st.status === 'installed' ? 'Переустановить' : 'Установить'; btnClass = ''; }
  else if (mode === 'both') {
    // both-mode reinstall also runs the payload, but with a dedicated "Запустить"
    // button present we keep the reinstall label short.
    if (st.status === 'installed') { btnLabel = 'Переустановить'; btnClass = 'installed'; }
    else { btnLabel = 'Установить + запустить'; btnClass = ''; }
  }
  else if (st.status === 'installed') { btnLabel = 'Переустановить'; btnClass = 'installed'; }
  else if (st.status === 'update-available') { btnLabel = 'Обновить'; btnClass = 'update'; }

  // A "Удалить" button on the card, shown only when something is installed or
  // an update is available. Wired to onUninstall (deletes the file for copy/both
  // modes, clears the installed-state record for run mode).
  const showRemoveCard = (st.status === 'installed' || st.status === 'update-available');

  const versionOptions = p.versions
    .map((v) => `<option value="${escapeHtml(v.version)}"${v.version === sel.version ? ' selected' : ''}>${v.version ? 'v' + escapeHtml(v.version) : 'latest'}</option>`)
    .join('');

  const av = avatarUrl(p);
  const iconHTML = av
    ? `<img class="avatar-img" src="${escapeHtml(av)}" alt="" draggable="false">`
    : (TYPE_ICONS[p.type] || 'Pl');

  const favOn = state.favorites.has(p.id);

  card.innerHTML = `
    <button class="fav-btn ${favOn ? 'on' : ''}" data-action="fav" title="${favOn ? 'Убрать из избранного' : 'В избранное'}" aria-label="Избранное">
      <svg viewBox="0 0 18 18"><path d="M9 2.6l1.9 4 4.1.5-3 2.8.8 4.1-3.8-2.1-3.8 2.1.8-4.1-3-2.8 4.1-.5z" fill="${favOn ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>
    </button>
    <div class="card-inner">
      <div class="card-head">
        <div class="card-check" data-action="check" aria-label="Выбрать" role="checkbox"></div>
        <div class="card-icon type-${p.type}">${iconHTML}</div>
        <div class="card-titlewrap">
          <div class="card-name">${escapeHtml(p.name)}</div>
          <div class="card-meta">
            ${sel.version ? `<span class="card-ver">v${escapeHtml(sel.version)}</span>` : ''}
            <span class="card-type-badge">${escapeHtml(p.type)}</span>
            <span class="card-mode-badge" title="Способ установки">${escapeHtml(modeBadge)}</span>
            ${p.author ? `<span>${escapeHtml(p.author)}</span>` : ''}
          </div>
        </div>
      </div>
      <div class="card-desc">${escapeHtml(p.description) || '—'}</div>
      <div class="card-tags">${p.tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>
      <div class="card-foot">
        <div class="foot-left">
          ${multi ? `<select class="ver-select" title="Версия">${versionOptions}</select>` : ''}
          <div class="status ${st.status}"><span class="sdot"></span><span>${statusText}</span></div>
        </div>
        <div class="foot-btns">
          ${showLaunchCard && launchPrimary ? `<button class="btn" data-action="launch" ${busy ? 'disabled' : ''} title="Запустить программу">Запустить</button>` : ''}
          ${showInstallCard ? `<button class="btn ${launchPrimary ? 'installed card-sec' : btnClass}" data-action="install" ${busy ? 'disabled' : ''}>
            <span class="fill"></span><span class="label">${btnLabel}</span>
          </button>` : ''}
          ${showLaunchCard && !launchPrimary ? `<button class="btn installed card-sec" data-action="launch" ${busy ? 'disabled' : ''} title="Запустить программу">Запустить</button>` : ''}
          ${showRemoveCard ? `<button class="btn danger card-sec card-remove" data-action="remove" ${busy ? 'disabled' : ''} title="Удалить">Удалить</button>` : ''}
        </div>
      </div>
    </div>
  `;

  // Card click: in multi mode toggle selection; otherwise open the detail panel
  // (but not when clicking a control).
  card.addEventListener('click', (e) => {
    if (state.multi) { toggleMultiSel(p.id); return; }
    if (e.target.closest('[data-action]') || e.target.closest('.ver-select')) return;
    selectPlugin(p.id);
  });

  // Favorite toggle.
  card.querySelector('.fav-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleFavorite(p.id);
    card.querySelector('.fav-btn').classList.toggle('on', state.favorites.has(p.id));
    const on = state.favorites.has(p.id);
    card.querySelector('.fav-btn').title = on ? 'Убрать из избранного' : 'В избранное';
    card.querySelector('.fav-btn svg path').setAttribute('fill', on ? 'currentColor' : 'none');
    updateCounts();
    if (state.category === 'favorites') renderGrid();
    if (state.selectedId === p.id) renderDetail();
  });

  // Install button. Select by data-action (not ".btn"): in the swapped layout
  // "Запустить" is the first .btn in the card foot, so ".btn" would bind install
  // onto the launch button.
  const installBtn = card.querySelector('[data-action="install"]');
  if (installBtn) installBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    onInstall(p, card);
  });

  // Remove/uninstall button (only present when installed or update-available).
  const rmBtn = card.querySelector('.card-remove');
  if (rmBtn) rmBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    onUninstall(p);
  });

  // Launch button (installed run/both programs only). Toggles Запустить/Закрыть.
  const launchBtn = card.querySelector('[data-action="launch"]');
  if (launchBtn) {
    launchBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      onLaunchToggle(p);
    });
    paintLaunchBtn(launchBtn, p);
  }

  // Version selector.
  const verSelect = card.querySelector('.ver-select');
  if (verSelect) {
    verSelect.addEventListener('change', async (e) => {
      state.selVersion[p.id] = e.target.value;
      const r = await window.api.status(resolvePlugin(p), state.activeVersion);
      state.statuses[p.id] = r;
      renderGrid();
      if (state.selectedId === p.id) renderDetail();
    });
  }
  return card;
}

// ---------- Right detail panel ----------
function selectPlugin(id) {
  state.selectedId = id;
  $$('.card').forEach((c) => c.classList.toggle('selected', c.dataset.id === id));
  $('#main').classList.add('detail-open');
  $('#detailPanel').setAttribute('aria-hidden', 'false');
  renderDetail();
}

function closeDetail() {
  state.selectedId = null;
  $('#main').classList.remove('detail-open');
  $('#detailPanel').setAttribute('aria-hidden', 'true');
  $$('.card.selected').forEach((c) => c.classList.remove('selected'));
}
$('#detailClose').addEventListener('click', closeDetail);

function renderDetail() {
  const p = state.plugins.find((x) => x.id === state.selectedId);
  const body = $('#detailBody');
  if (!p) { body.innerHTML = ''; return; }

  // "СКОРО выйдет" announcement: teaser detail — no install/launch/remove, just
  // a banner + description + favorite. Branch before getVersionEntry() since a
  // coming-soon item has no versions.
  if (p.comingSoon) {
    const av = avatarUrl(p);
    const iconHTML = av
      ? `<img class="avatar-img" src="${escapeHtml(av)}" alt="" draggable="false">`
      : (TYPE_ICONS[p.type] || 'Pl');
    const favOn = state.favorites.has(p.id);
    body.innerHTML = `
      <div class="detail-hero">
        <div class="card-icon type-${p.type}">${iconHTML}</div>
        <div>
          <div class="detail-name">${escapeHtml(p.name)}</div>
          <div class="detail-author">${escapeHtml(p.author || '—')}</div>
        </div>
      </div>
      <div class="detail-soon-banner">СКОРО выйдет</div>
      <div class="detail-section">
        <div class="detail-label">Описание</div>
        <div class="detail-desc">${escapeHtml(p.description) || '—'}</div>
      </div>
      ${p.tags.length ? `<div class="detail-section"><div class="detail-label">Теги</div><div class="detail-tags">${p.tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div></div>` : ''}
      <div class="detail-section">
        <div class="detail-label">Информация</div>
        <div class="detail-row"><span>Тип</span><b>${escapeHtml(p.type)}</b></div>
        <div class="detail-row"><span>Статус</span><span class="detail-status soon"><span class="sdot"></span>Анонс</span></div>
      </div>
      <div class="detail-actions">
        <button class="detail-open-folder" id="detailFav">${favOn ? '★ В избранном' : '☆ В избранное'}</button>
      </div>
    `;
    const dFav = $('#detailFav');
    if (dFav) dFav.addEventListener('click', () => { toggleFavorite(p.id); updateCounts(); renderDetail(); renderGrid(); });
    return;
  }

  const sel = getVersionEntry(p);
  const st = state.statuses[p.id] || { status: 'not-installed', detail: '' };
  const busy = !!state.busy[p.id];
  const av = avatarUrl(p);
  const iconHTML = av
    ? `<img class="avatar-img" src="${escapeHtml(av)}" alt="" draggable="false">`
    : (TYPE_ICONS[p.type] || 'Pl');
  const favOn = state.favorites.has(p.id);

  const statusText = {
    installed: 'Установлено',
    'update-available': 'Доступно обновление',
    'not-installed': 'Не установлено',
  }[st.status] || 'Не установлено';

  const mode = (sel.installMode || p.installMode || 'copy').toLowerCase();
  const modeText = { copy: 'Копирование в папку', run: 'Запуск установщика', both: 'Копирование + запуск' }[mode] || 'Копирование';

  const isInstalled = st.status === 'installed';
  const isUpdate = st.status === 'update-available';
  // "Запустить" for installed programs (run / both — apps with an .exe).
  const showLaunch = (mode === 'run' || mode === 'both') && (isInstalled || isUpdate);
  // Installed program: "Запустить" becomes primary, "Переустановить" secondary
  // (swap of position + style), mirroring the card. Only the installed state.
  const launchPrimary = (mode === 'run' || mode === 'both') && isInstalled;

  let primaryLabel = 'Установить', primaryClass = '';
  if (busy) primaryLabel = 'Устанавливается…';
  else if (mode === 'run') primaryLabel = isInstalled ? 'Переустановить' : 'Установить';
  else if (mode === 'both') {
    if (isInstalled) { primaryLabel = 'Переустановить'; primaryClass = 'installed'; }
    else { primaryLabel = 'Установить + запустить'; }
  }
  else if (isInstalled) { primaryLabel = 'Переустановить'; primaryClass = 'installed'; }
  else if (isUpdate) { primaryLabel = 'Обновить'; primaryClass = 'update'; }

  const showRemove = isInstalled || isUpdate;

  const versionOptions = p.versions
    .map((v) => `<option value="${escapeHtml(v.version)}"${v.version === sel.version ? ' selected' : ''}>${v.version ? 'v' + escapeHtml(v.version) : 'latest'}</option>`)
    .join('');

  body.innerHTML = `
    <div class="detail-hero">
      <div class="card-icon type-${p.type}">${iconHTML}</div>
      <div>
        <div class="detail-name">${escapeHtml(p.name)}</div>
        <div class="detail-author">${escapeHtml(p.author || '—')}</div>
      </div>
    </div>

    <div class="detail-section">
      <div class="detail-label">Описание</div>
      <div class="detail-desc">${escapeHtml(p.description) || '—'}</div>
    </div>

    ${p.tags.length ? `<div class="detail-section"><div class="detail-label">Теги</div><div class="detail-tags">${p.tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div></div>` : ''}

    <div class="detail-section">
      <div class="detail-label">Информация</div>
      <div class="detail-row"><span>Тип</span><b>${escapeHtml(p.type)}</b></div>
      <div class="detail-row"><span>Версия</span><b>${sel.version ? 'v' + escapeHtml(sel.version) : 'latest'}</b></div>
      <div class="detail-row"><span>Способ установки</span><b>${escapeHtml(modeText)}</b></div>
      <div class="detail-row"><span>Файл</span><b>${escapeHtml(sel.fileName || '—')}</b></div>
      <div class="detail-row"><span>Статус</span><span class="detail-status ${st.status}"><span class="sdot"></span>${statusText}</span></div>
    </div>

    ${sel.changelog ? `<div class="detail-section"><div class="detail-label">Changelog</div><div class="detail-changelog">${escapeHtml(sel.changelog)}</div></div>` : ''}

    ${p.versions.length > 1 ? `<div class="detail-section"><div class="detail-label">Версия</div><select class="ver-select" id="detailVer" style="width:100%">${versionOptions}</select></div>` : ''}

    <div class="detail-actions">
      ${showLaunch && launchPrimary ? `<button class="btn" id="detailLaunch" title="Запустить программу">Запустить</button>` : ''}
      ${(busy || !isInstalled) ? `<button class="btn ${launchPrimary ? 'installed' : primaryClass}" id="detailInstall" ${busy ? 'disabled' : ''}><span class="fill"></span><span class="label">${primaryLabel}</span></button>` : ''}
      ${showLaunch && !launchPrimary ? `<button class="btn installed" id="detailLaunch" title="Запустить программу">Запустить</button>` : ''}
      ${showRemove ? `<button class="btn danger" id="detailRemove">Удалить</button>` : ''}
    </div>
    <div class="detail-actions">
      <button class="detail-open-folder" id="detailFav">${favOn ? '★ В избранном' : '☆ В избранное'}</button>
      <button class="detail-open-folder" id="detailFolder">Открыть папку</button>
    </div>
  `;

  // Detail actions.
  const dInstall = $('#detailInstall');
  if (dInstall) dInstall.addEventListener('click', () => onInstall(p, null));
  const dLaunch = $('#detailLaunch');
  if (dLaunch) {
    dLaunch.addEventListener('click', () => onLaunchToggle(p));
    paintLaunchBtn(dLaunch, p);
  }
  const dRemove = $('#detailRemove');
  if (dRemove) dRemove.addEventListener('click', () => onUninstall(p));
  const dFav = $('#detailFav');
  if (dFav) dFav.addEventListener('click', () => {
    toggleFavorite(p.id);
    updateCounts();
    renderDetail();
    renderGrid();
  });
  const dFolder = $('#detailFolder');
  if (dFolder) dFolder.addEventListener('click', () => openDetailFolder(p));
  const dVer = $('#detailVer');
  if (dVer) dVer.addEventListener('change', async (e) => {
    state.selVersion[p.id] = e.target.value;
    const r = await window.api.status(resolvePlugin(p), state.activeVersion);
    state.statuses[p.id] = r;
    renderGrid();
    renderDetail();
  });
}

async function openDetailFolder(p) {
  const rp = resolvePlugin(p);
  const mode = (rp.installMode || 'copy').toLowerCase();
  if (mode === 'run' || !rp.installPath) { toast('Папка назначения не используется для этого режима.', 'warn'); return; }
  if (rp.type === 'app') { await window.api.openAppsFolder(); return; }
  if (!state.activeVersion) { toast('Версия After Effects не выбрана.', 'warn'); return; }
  const r = await window.api.openAeFolder(state.activeVersion, rp.installPath.startsWith('Plug-ins') ? 'plugins' : 'scripts');
  if (!r.ok) toast(r.error, 'err');
}

// ---------- Install / Uninstall ----------
// Launch / close an installed program (run / both modes). The same button is
// "Запустить" when the program is not running and "Закрыть" when it is. The
// main process resolves the .exe (installs.json for both, registry for run,
// AE Support Files for After Effects), runs it via the OS shell, and can kill
// the matching process so "Закрыть" actually terminates the app.
async function onLaunchToggle(p) {
  const rp = resolvePlugin(p);
  if (state.running[p.id]) {
    let r;
    try { r = await window.api.closeApp(rp, state.activeVersion); }
    catch (e) { r = { ok: false, error: e.message }; }
    if (!r.ok) { toast(`Не удалось закрыть: ${r.error}`, 'err'); return; }
    state.running[p.id] = false;
    syncRunButtons();
    toast(r.alreadyGone ? `${p.name} уже не запущен` : `Закрыто: ${p.name}`, 'ok');
    return;
  }
  let r;
  try { r = await window.api.launchApp(rp, state.activeVersion); }
  catch (e) { r = { ok: false, error: e.message }; }
  if (!r.ok) { toast(`Не удалось запустить: ${r.error}`, 'err'); return; }
  state.running[p.id] = true;
  syncRunButtons();
  toast(`Запущено: ${p.name}`, 'ok');
}

// Paint one launch button to match the current running state: "Закрыть" (red)
// when the program is running, "Запустить" otherwise.
function paintLaunchBtn(btn, p) {
  if (!btn) return;
  const running = !!state.running[p.id];
  btn.textContent = running ? 'Закрыть' : 'Запустить';
  btn.title = running ? 'Закрыть программу' : 'Запустить программу';
  btn.classList.toggle('launch-close', running);
}

// Update every visible launch button (cards + the detail panel) in place,
// without a full re-render — called when running state changes.
function syncRunButtons() {
  for (const card of document.querySelectorAll('.card')) {
    const btn = card.querySelector('[data-action="launch"]');
    if (btn) paintLaunchBtn(btn, state.plugins.find((x) => x.id === card.dataset.id) || { id: card.dataset.id });
  }
  const dBtn = $('#detailLaunch');
  if (dBtn && state.selectedId) {
    const p = state.plugins.find((x) => x.id === state.selectedId);
    if (p) paintLaunchBtn(dBtn, p);
  }
}

// Poll which launched programs are currently running, so the button flips to
// "Закрыть" automatically when the user starts the app elsewhere (or quits it).
// Only checks installed run/both plugins; skips the round when the window is
// hidden. Lightweight: a few fast PowerShell probes every few seconds.
let _runningTimer = null;
async function pollRunning() {
  if (document.hidden || !state.plugins.length) return;
  let changed = false;
  await Promise.all(state.plugins.map(async (p) => {
    const rp = resolvePlugin(p);
    const mode = (rp.installMode || 'copy').toLowerCase();
    const st = state.statuses[p.id]?.status;
    const eligible = (mode === 'run' || mode === 'both') && (st === 'installed' || st === 'update-available');
    if (!eligible) {
      if (state.running[p.id]) { state.running[p.id] = false; changed = true; }
      return;
    }
    let run = false;
    try { const r = await window.api.isRunning(rp, state.activeVersion); run = !!(r && r.ok && r.running); }
    catch (_) {}
    if (!!state.running[p.id] !== run) { state.running[p.id] = run; changed = true; }
  }));
  if (changed) syncRunButtons();
}
function startRunningPoller() {
  if (_runningTimer) return;
  _runningTimer = setInterval(pollRunning, 4000);
}

async function onInstall(p, card) {
  if (state.busy[p.id]) return;
  const rp = resolvePlugin(p);
  if (needsAeVersion(rp) && !state.activeVersion) { toast('Сначала выберите версию After Effects.', 'warn'); return; }
  state.busy[p.id] = true;
  delete state.userCancel[p.id]; // fresh install — clear any stale cancel flag

  // Reflect busy state on the card install button (if visible) + the detail
  // install button. Select the card one by data-action (not ".btn") because in
  // the swapped layout "Запустить" is the first .btn in the card foot.
  const cardEl = card || document.querySelector(`.card[data-id="${cssEscape(p.id)}"]`);
  const btns = [];
  if (cardEl) {
    const iBtn = cardEl.querySelector('[data-action="install"]');
    if (iBtn) btns.push({ btn: iBtn, fill: iBtn.querySelector('.fill'), label: iBtn.querySelector('.label') });
  }
  const dBtn = $('#detailInstall');
  if (dBtn) btns.push({ btn: dBtn, fill: dBtn.querySelector('.fill'), label: dBtn.querySelector('.label') });
  btns.forEach((b) => { if (b.btn) { b.btn.disabled = true; b.btn.classList.add('is-loading'); } if (b.label) b.label.textContent = 'Подготовка…'; });

  // Show a "Отмена" button next to each install button while the download runs.
  showCancelBtns(p, btns);

  sfx('install'); // soft whoosh — install initialized
  const result = await window.api.install(rp, state.activeVersion);

  if (!result.ok) {
    state.busy[p.id] = false;
    removeCancelBtns(p.id);
    clearDlSpeed(p.id);
    btns.forEach((b) => { if (b.fill) b.fill.style.width = '0%'; if (b.label) b.label.textContent = 'Установить'; if (b.btn) { b.btn.disabled = false; b.btn.classList.remove('is-loading'); } });
    // A user-cancelled download must read as a neutral "Отменено", never an
    // error — even when the abort surfaces as a generic Error (e.g. during the
    // Google Drive / redirect resolve phase, before kind:'cancelled' is set).
    const cancelled = result.cancelled || !!state.userCancel[p.id];
    delete state.userCancel[p.id];
    if (cancelled) toast('Отменено', 'warn');
    else toast(`Ошибка: ${result.error}`, 'err');
    return;
  }

  // run-mode: the downloaded installer only LAUNCHED — the real install happens
  // in the external installer window while we wait. Keep the button in
  // "Устанавливается…" and poll the registry for the app's uninstall entry; only
  // report "Установлено" once it actually appears, so the UI reflects that the
  // program is still installing instead of claiming done the moment the window
  // opened. copy/both modes finish synchronously (file copy completes here).
  const mode = (rp.installMode || 'copy').toLowerCase();
  if (mode === 'run') {
    removeCancelBtns(p.id);
    btns.forEach((b) => { if (b.fill) b.fill.style.width = '100%'; if (b.label) b.label.textContent = 'Устанавливается…'; });
    toast(`Установщик «${p.name}» запущен. Завершите установку в его окне.`, 'ok');
    await waitForAppInstalled(p, rp);
    state.busy[p.id] = false;
    renderGrid();
    renderDetail();
    return;
  }

  removeCancelBtns(p.id);
  clearDlSpeed(p.id);
  state.busy[p.id] = false;
  btns.forEach((b) => { if (b.fill) b.fill.style.width = '100%'; if (b.label) b.label.textContent = 'Готово ✓'; if (b.btn) b.btn.classList.remove('is-loading'); });
  sfx('success'); // success chime — install finished
  toast(`Установлено: ${p.name} ${rp.version ? 'v' + rp.version : ''}`, 'ok');
  const r = await window.api.status(rp, state.activeVersion);
  state.statuses[p.id] = r;
  updateCounts();
  setTimeout(() => { renderGrid(); renderDetail(); }, 600);
}

// Build a small "Отмена" button that aborts the in-flight download for p. The
// install promise then rejects with cancelled and onInstall cleans up + toasts.
function makeCancelBtn(p) {
  const b = document.createElement('button');
  b.className = 'btn danger card-sec cancel-dl';
  b.type = 'button';
  b.textContent = 'Отмена';
  b.title = 'Отменить загрузку';
  b.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (b.disabled) return;
    b.disabled = true;
    b.textContent = 'Отмена…';
    state.userCancel[p.id] = true; // user-initiated → neutral "Отменено", not an error
    try { await window.api.cancelInstall(p.id); } catch (_) {}
  });
  return b;
}

// Insert a "Отмена" button right after each install button (card + detail) and
// remember them so they can be removed once the download phase ends.
function showCancelBtns(p, btns) {
  const arr = [];
  btns.forEach((b) => {
    if (b.btn && b.btn.parentElement) {
      const c = makeCancelBtn(p);
      b.btn.parentElement.insertBefore(c, b.btn.nextSibling);
      arr.push(c);
    }
  });
  state.cancelEls[p.id] = arr;
}

function removeCancelBtns(id) {
  const arr = state.cancelEls[id];
  if (arr) { arr.forEach((el) => el.remove()); delete state.cancelEls[id]; }
}

// run-mode install watchdog: the external installer is running in its own
// window. Poll the Windows registry (via app:findApp) for the app's uninstall
// entry and refresh status once it shows up — or give up after a few minutes
// and leave the status for the user to verify. Refreshes state.statuses either
// way so the card reflects whatever is actually on disk.
async function waitForAppInstalled(p, rp) {
  const match = (rp.uninstallName || rp.name || '').trim();
  const POLL_MS = 2500;
  const MAX_MS = 5 * 60 * 1000; // give the user up to 5 min to click through the installer
  let found = false;
  if (match) {
    const started = Date.now();
    while (Date.now() - started < MAX_MS) {
      try { if (await window.api.findApp(match)) { found = true; break; } }
      catch (_) {}
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  } else {
    // No name to match against — can't poll the registry. Wait a beat so the
    // "installing" state is at least visible before we fall back to status.
    await new Promise((r) => setTimeout(r, 2000));
  }
  const r = await window.api.status(rp, state.activeVersion);
  state.statuses[p.id] = r;
  updateCounts();
  if (found) {
    sfx('success'); // run-mode install confirmed
    toast(`Установлено: ${p.name}${r.installedVersion ? ' · ' + r.installedVersion : ''}`, 'ok');
  } else {
    toast(`Установка «${p.name}» ещё не подтверждена — проверьте статус вручную.`, 'warn');
  }
}

// ---------- Uninstall ----------
// Confirmation modal — returns true/false. Single shared dialog so the look is
// consistent and there's only one code path asking before destructive actions.
function confirmDialog(msg, title = 'Удалить?') {
  const m = $('#confirmModal');
  $('#confirmTitle').textContent = title;
  $('#confirmMsg').textContent = msg;
  m.classList.remove('hidden');
  const ok = $('#confirmOk'), cancel = $('#confirmCancel');
  return new Promise((resolve) => {
    const done = (val) => {
      m.classList.add('hidden');
      ok.removeEventListener('click', onOk);
      cancel.removeEventListener('click', onCancel);
      m.removeEventListener('click', onOverlay);
      ok.disabled = false; cancel.disabled = false;
      resolve(val);
    };
    const onOk = () => done(true);
    const onCancel = () => done(false);
    const onOverlay = (e) => { if (e.target === m) done(false); };
    ok.addEventListener('click', onOk);
    cancel.addEventListener('click', onCancel);
    m.addEventListener('click', onOverlay);
  });
}

// Flip the "Удалить" button(s) for a plugin to/from the "Удаление…" busy state.
function setRemoving(id, on) {
  const card = document.querySelector(`.card[data-id="${cssEscape(id)}"]`);
  if (card) {
    const rm = card.querySelector('.card-remove');
    if (rm) { rm.disabled = on; rm.textContent = on ? 'Удаление…' : 'Удалить'; }
  }
  const dRm = $('#detailRemove');
  if (dRm && state.selectedId === id) { dRm.disabled = on; dRm.textContent = on ? 'Удаление…' : 'Удалить'; }
}

// Actually remove one plugin from the computer + refresh its status. No confirm
// here — the caller decides whether to ask first (single remove asks, batch
// remove asks once for all). Returns true on success.
async function doUninstall(p) {
  const rp = resolvePlugin(p);
  if (needsAeVersion(rp) && !state.activeVersion) { toast('Версия After Effects не выбрана.', 'warn'); return false; }
  state.removing.add(p.id);
  setRemoving(p.id, true);
  const r = await window.api.uninstall(rp, state.activeVersion);
  state.removing.delete(p.id);
  setRemoving(p.id, false);
  if (!r.ok) { toast(`Ошибка удаления: ${r.error}`, 'err'); return false; }

  // Report what actually happened on the computer.
  if (r.launched) {
    toast(`Запущен деинсталлятор${r.uninstaller ? ' — ' + r.uninstaller : ''}. Завершите удаление в его окне.`, 'ok');
  } else if (r.uninstallerNoop) {
    const removed = (r.removed && r.removed.length) || 0;
    const failed = (r.errors && r.errors.length) || 0;
    toast(
      `Деинсталлятор «${p.name}» не сработал — ${removed ? 'удалено напрямую' : 'не удалось удалить напрямую'}${failed ? ` · ${r.errors[0].message}` : ''}`,
      removed ? (failed ? 'warn' : 'ok') : 'err'
    );
  } else if (r.direct && r.removed && r.removed.length) {
    const failed = (r.errors && r.errors.length) || 0;
    toast(`Удалено напрямую: ${p.name}${failed ? ` · не удалось ${failed}: ${r.errors[0].message}` : ''}`, failed ? 'warn' : 'ok');
  } else if (r.removed && r.removed.length) {
    const failed = (r.errors && r.errors.length) || 0;
    toast(`Удалено: ${p.name} (${r.removed.length} файл(ов))${failed ? ` · не удалось ${failed}: ${r.errors[0].message}` : ''}`, failed ? 'warn' : 'ok');
  } else if (r.errors && r.errors.length) {
    toast(`Не удалось удалить «${p.name}»: ${r.errors[0].message}`, 'err');
  } else {
    toast(`Запись очищена: ${p.name} (файлы уже отсутствовали)`, 'warn');
  }

  const s = await window.api.status(rp, state.activeVersion);
  state.statuses[p.id] = s;
  updateCounts();
  updateStats();
  renderGrid();
  renderDetail();

  // After any real removal, re-scan the PC (invalidate the registry cache so a
  // just-uninstalled app no longer reads as "Установлено") and refresh the whole
  // catalog so statuses/counts reflect the new state immediately.
  if (r.launched || (r.removed && r.removed.length) || r.direct) {
    await scanAndRefresh();
  }
  sfx('delete'); // soft fade-out — something was removed
  return true;
}

// Scan the PC (clears the registry cache + re-detects AE) and refresh every
// status/counter/render. Shared by the "Сканировать ПК" button and the
// post-uninstall refresh so they stay in sync.
async function scanAndRefresh() {
  setConn('сканирование…', false);
  try {
    const r = await window.api.scanPc();
    if (r && r.ok) {
      state.versions = r.versions || state.versions;
      if (state.versions.length && !state.versions.some((x) => JSON.stringify(x) === JSON.stringify(state.activeVersion))) {
        state.activeVersion = state.versions[0];
      } else if (!state.versions.length) {
        state.activeVersion = null;
      }
      renderVersions();
      await refreshAllStatuses();
      renderGrid();
      renderDetail();
      updateCounts();
      updateStats();
    }
  } catch (e) {
    // Non-fatal: the uninstall itself already succeeded.
  }
  setConn('готово', false);
}

// Single-item remove: ask first, then do it.
async function onUninstall(p) {
  const rp = resolvePlugin(p);
  const hint = rp.installMode === 'run'
    ? ' Программа запустит штатный деинсталлятор; если он не сработает — удалит напрямую. Завершите удаление в окне деинсталлятора.'
    : '';
  const ok = await confirmDialog(`Удалить «${p.name}» с компьютера?${hint}`);
  if (!ok) return;
  await doUninstall(p);
}

// ---------- Multi-select (batch remove) ----------
function toggleMultiSel(id) {
  if (state.multiSelected.has(id)) state.multiSelected.delete(id);
  else state.multiSelected.add(id);
  updateMultiBar();
  const card = document.querySelector(`.card[data-id="${cssEscape(id)}"]`);
  if (card) card.classList.toggle('multisel', state.multiSelected.has(id));
}

function updateMultiBar() {
  const n = state.multiSelected.size;
  $('#multiCount').textContent = `Выбрано: ${n}`;
  $('#multiRemove').disabled = n === 0;
}

function toggleMulti() {
  state.multi = !state.multi;
  state.multiSelected = new Set();
  $('#btnMulti').classList.toggle('active', state.multi);
  $('#multiBar').classList.toggle('hidden', !state.multi);
  updateMultiBar();
  renderGrid();
}
$('#btnMulti').addEventListener('click', toggleMulti);
$('#multiCancel').addEventListener('click', toggleMulti);
$('#multiRemove').addEventListener('click', async () => {
  const plugins = [...state.multiSelected]
    .map((id) => state.plugins.find((p) => p.id === id))
    .filter(Boolean);
  // Only items that are actually installed (or have an update) can be removed.
  const toRemove = plugins.filter((p) => {
    const st = state.statuses[p.id]?.status;
    return st === 'installed' || st === 'update-available';
  });
  if (!toRemove.length) { toast('Среди выбранных нет установленных элементов.', 'warn'); return; }
  const ok = await confirmDialog(`Удалить ${toRemove.length} элемент(ов) с компьютера?`, 'Удалить выбранные?');
  if (!ok) return;
  for (const p of toRemove) await doUninstall(p);
  state.multiSelected = new Set();
  updateMultiBar();
  renderGrid();
  toast(`Удаление завершено: ${toRemove.length} элемент(ов).`, 'ok');
});

// ---------- Progress streaming ----------

// The download-speed readout is kept in its OWN fixed-width slot (never inside
// the install button's label). This is what stops the buttons from scaling /
// reflowing while loading: the label only carries the phase + percent (slow,
// one-way growth), and the volatile speed digits live in .dl-speed / .detail-speed,
// which reserve a constant width regardless of how many digits they show.
function ensureCardSpeed(card) {
  let el = card.querySelector('.dl-speed');
  if (!el) {
    const host = card.querySelector('.foot-left');
    if (!host) return null;
    el = document.createElement('span');
    el.className = 'dl-speed';
    host.appendChild(el);
  }
  return el;
}
function ensureDetailSpeed() {
  const body = $('#detailBody');
  if (!body) return null;
  let el = body.querySelector('.detail-speed');
  if (!el) {
    // Put it in the fav/folder actions row — that row has no flex:1 buttons, so
    // its width never feeds back into the install button row above it.
    const rows = body.querySelectorAll('.detail-actions');
    const host = rows[rows.length - 1] || body;
    el = document.createElement('span');
    el.className = 'detail-speed';
    host.insertBefore(el, host.firstChild);
  }
  return el;
}
function clearDlSpeed(id) {
  delete state.dl[id];
  const card = document.querySelector(`.card[data-id="${cssEscape(id)}"]`);
  if (card) { const el = card.querySelector('.dl-speed'); if (el) { el.textContent = ''; el.classList.remove('on'); } }
  const d = $('#detailBody') && $('#detailBody').querySelector('.detail-speed');
  if (d) { d.textContent = ''; d.classList.remove('on'); }
}

window.api.onProgress((data) => {
  const card = document.querySelector(`.card[data-id="${cssEscape(data.id)}"]`);
  const btns = [];
  if (card) {
    const inst = card.querySelector('.btn[data-action="install"]');
    if (inst) btns.push({ root: inst, fill: inst.querySelector('.fill'), label: inst.querySelector('.label') });
  }
  const dBtn = $('#detailInstall');
  if (dBtn && state.selectedId === data.id) btns.push({ root: dBtn, fill: dBtn.querySelector('.fill'), label: dBtn.querySelector('.label') });
  const pct = Math.round((data.frac || 0) * 100);
  const isLoading = !!data.phase;

  // The "Отмена" button only lives during the download phase; drop it once we
  // move on to unpacking/install/running (onInstall also cleans up on settle).
  if (data.phase && data.phase !== 'downloading') removeCancelBtns(data.id);

  // Live download speed, smoothed over a ~250ms window from byte deltas. Only
  // the downloading phase reports received/total; the last computed speed is
  // kept between window updates so the readout doesn't flicker off.
  let speed = '';
  if (data.phase === 'downloading' && data.received != null) {
    const now = Date.now();
    let prev = state.dl[data.id];
    if (!prev || data.received < prev.bytes) {
      // First event of a new download (or frac reset) — start a fresh window.
      prev = state.dl[data.id] = { t: now, bytes: data.received, lastSpeed: '' };
    } else {
      const dt = now - prev.t;
      if (dt >= 250) {
        const bps = ((data.received - prev.bytes) / dt) * 1000;
        prev.lastSpeed = fmtSpeed(bps);
        prev.t = now;
        prev.bytes = data.received;
      }
    }
    speed = prev.lastSpeed || '';
  } else {
    // Left the downloading phase — drop the tracker so the next download starts clean.
    delete state.dl[data.id];
  }

  // Render speed into the fixed-width slots (never into the button label).
  const cardSpeed = card ? ensureCardSpeed(card) : null;
  const detSpeed = state.selectedId === data.id ? ensureDetailSpeed() : null;
  if (cardSpeed) { cardSpeed.textContent = speed; cardSpeed.classList.toggle('on', !!speed); }
  if (detSpeed) { detSpeed.textContent = speed; detSpeed.classList.toggle('on', !!speed); }

  // Label holds only phase + percent: its width grows slowly with the percent
  // (never jitters with speed). The .is-loading class pins a fixed min-width so
  // even that slow growth can't shift the neighbor buttons during the load.
  const labels = { downloading: `Загрузка ${pct}%`, unpacking: 'Распаковка…', installing: 'Устанавливается…', running: 'Запуск…' };
  btns.forEach((b) => {
    if (!b.label) return;
    b.root.classList.toggle('is-loading', isLoading);
    if (data.phase === 'downloading') { if (b.fill) b.fill.style.width = pct + '%'; }
    else if (data.phase === 'unpacking' || data.phase === 'installing' || data.phase === 'running') { if (b.fill) b.fill.style.width = '100%'; }
    if (labels[data.phase]) b.label.textContent = labels[data.phase];
  });
});

// ---------- Live catalog reload (config file changed on disk) ----------
window.api.onCatalogUpdated(async (plugins) => {
  const prevSel = state.selectedId;
  state.plugins = plugins || [];
  // Drop the detail selection if that plugin is gone.
  if (prevSel && !state.plugins.some((p) => p.id === prevSel)) closeDetail();
  for (const p of state.plugins) {
    if (!state.selVersion[p.id]) state.selVersion[p.id] = pickDefaultVersion(p, state.statuses[p.id]?.installedVersion);
  }
  await refreshAllStatuses();
  renderGrid();
  updateCounts();
  updateStats();
  if (state.selectedId) renderDetail();
  setConn('готово', false);
  toast(`Каталог обновлён: ${state.plugins.length} элементов`, 'ok');
});

// ---------- Search + sort ----------
$('#search').addEventListener('input', (e) => { state.query = e.target.value; renderGrid(); });
$('#sortSelect').addEventListener('change', (e) => { state.sort = e.target.value; renderGrid(); });

// ---------- Refresh button (re-detect AE versions + reload statuses) ----------
$('#btnRefresh').addEventListener('click', async () => {
  const btn = $('#btnRefresh');
  btn.classList.add('spinning');
  btn.disabled = true;
  setConn('обновление…', false);
  try {
    await reloadCatalog();           // pull fresh catalog from the server first
    const v = await window.api.detectVersions();
    state.versions = v.versions || [];
    if (state.versions.length && !state.versions.some((x) => JSON.stringify(x) === JSON.stringify(state.activeVersion))) {
      state.activeVersion = state.versions[0];
    } else if (!state.versions.length) {
      state.activeVersion = null;
    }
    renderVersions();
    await refreshAllStatuses();
    renderGrid();
    renderDetail();
    updateCounts();
    updateStats();
    toast(`Обновлено. Версий AE: ${state.versions.length}`, 'ok');
  } catch (e) {
    toast('Ошибка обновления: ' + e.message, 'err');
  } finally {
    setTimeout(() => { btn.classList.remove('spinning'); btn.disabled = false; }, 600);
  }
});

// ---------- Auto-refresh catalog (so users see admin's new items live) ----------
// The catalog is only fetched on startup by default; without this, a regular
// user never sees items an admin adds unless they restart. Pull silently on
// window focus (debounced 30s) and every 5 min, and only toast when something
// new actually appeared.
let lastAutoRefresh = 0;
const AUTO_REFRESH_MIN_GAP = 30000;   // don't refresh more often than every 30s
const AUTO_REFRESH_INTERVAL = 5 * 60 * 1000; // poll every 5 minutes
async function maybeAutoRefresh(force) {
  const now = Date.now();
  if (!force && now - lastAutoRefresh < AUTO_REFRESH_MIN_GAP) return;
  lastAutoRefresh = now;
  await reloadCatalog({ silent: true });
}
window.addEventListener('focus', () => { maybeAutoRefresh(false); });
setInterval(() => { maybeAutoRefresh(false); }, AUTO_REFRESH_INTERVAL);
// Kick one off shortly after startup so a long-open session catches up.
setTimeout(() => { maybeAutoRefresh(true); }, 15000);

// ---------- Scan PC button (find already-installed plugins/scripts/apps) ----------
// Clears the registry cache + re-detects AE, then re-checks every entry's
// status. copy/both entries are verified on disk (Plug-ins/Scripts/Presets),
// run-mode apps via the Windows registry. Detected ones show as "Установлено".
$('#btnScan').addEventListener('click', async () => {
  const btn = $('#btnScan');
  btn.classList.add('scanning');
  btn.disabled = true;
  setConn('сканирование…', false);
  try {
    const r = await window.api.scanPc();
    if (!r || !r.ok) { toast('Сканирование не удалось: ' + (r && r.error), 'err'); return; }
    state.versions = r.versions || state.versions;
    if (state.versions.length && !state.versions.some((x) => JSON.stringify(x) === JSON.stringify(state.activeVersion))) {
      state.activeVersion = state.versions[0];
    } else if (!state.versions.length) {
      state.activeVersion = null;
    }
    renderVersions();
    await refreshAllStatuses();
    renderGrid();
    renderDetail();
    updateCounts();
    updateStats();
    const installed = Object.values(state.statuses).filter((s) => s && s.status === 'installed').length;
    setConn('готово', false);
    toast(`Сканирование завершено. Найдено установленных: ${installed}`, 'ok');
  } catch (e) {
    toast('Ошибка сканирования: ' + e.message, 'err');
  } finally {
    setTimeout(() => { btn.classList.remove('scanning'); btn.disabled = false; }, 600);
  }
});

// ---------- Category nav ----------
$('#catNav').addEventListener('click', (e) => {
  const btn = e.target.closest('.cat-btn');
  if (!btn) return;
  $$('.cat-btn').forEach((x) => x.classList.remove('active'));
  btn.classList.add('active');
  state.category = btn.dataset.cat;
  const view = btn.dataset.view || 'catalog';
  // Show the right view (catalog / settings — the lite variant has no editor).
  $('#view-catalog').classList.toggle('active', view === 'catalog');
  $('#view-settings').classList.toggle('active', view === 'settings');
  // Hide logs panel when leaving it.
  if (view !== 'settings') $('#view-logs').classList.add('hidden');
  if (view === 'catalog') renderGrid();
});

// ---------- Settings actions ----------
$('#btnOpenScripts').addEventListener('click', () => openAe('scripts'));
$('#btnOpenPlugins').addEventListener('click', () => openAe('plugins'));
$('#btnOpenApps').addEventListener('click', () => window.api.openAppsFolder());

// Config file: show its path, open it for editing, reset to bundled default.
(async () => {
  try { const p = await window.api.configPath(); if (p) $('#configPath').textContent = 'Файл каталога: ' + p; } catch (_) {}
})();
$('#btnResetConfig').addEventListener('click', async () => {
  await window.api.resetConfig();
  toast('Каталог сброшен к стандартному.', 'ok'); // watcher reloads the grid
});

$('#btnOpenLogs').addEventListener('click', () => window.api.openLogs());
$('#btnOpenLogs2').addEventListener('click', () => window.api.openLogs());
$('#btnClearLogs').addEventListener('click', async () => { await window.api.clearLogs(); loadLogs(); });
$('#btnClearLogs2').addEventListener('click', async () => { await window.api.clearLogs(); loadLogs(); });

// ---------- Background (cosmos) settings ----------
// Apply persisted background settings to the live WebGL background. The in-app
// controls were removed from Settings, so the cosmic bg now runs purely from
// the saved bg block in settings.json (theme/speed/starCount/mouseIntensity).
(function () {
  if (!window.bg) return;
  (async () => {
    try {
      const s = await window.api.getSettings();
      const bg = s && s.bg;
      if (bg) window.bg.apply(bg);
    } catch (_) {}
  })();
})();

// ---------- Interface theme (dark / light) ----------
// The preload already applied the persisted theme to <html> before paint to
// avoid a flash; here we sync the toggle buttons to match and persist changes.
(function () {
  const btns = document.querySelectorAll('#uiThemes .bg-theme');
  if (!btns.length) return;
  const apply = (name) => {
    document.documentElement.setAttribute('data-ui-theme', name);
    btns.forEach((b) => b.classList.toggle('active', b.dataset.uiTheme === name));
  };
  btns.forEach((b) => b.addEventListener('click', () => {
    const name = b.dataset.uiTheme;
    apply(name);
    window.api.setSettings({ uiTheme: name }).catch(() => {});
  }));
  (async () => {
    try {
      const s = await window.api.getSettings();
      apply((s && s.uiTheme) || 'dark');
    } catch (_) {}
  })();
})();

// ---------- Interface sound settings ----------
// Load persisted sound settings → apply to the live engine + sync the controls;
// on any control change, update the engine and persist (debounced). The cue
// buttons play each sound type on demand for a quick preview.
(function () {
  if (!window.sfx) return;
  const toggle = $('#soundToggle'), volEl = $('#soundVol');
  const volVal = $('#soundVolVal'), enabledVal = $('#soundEnabledVal');
  let saveTimer = 0;
  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { window.api.setSettings({ sound: window.sfx.get() }).catch(() => {}); }, 400);
  };
  const paint = () => {
    const s = window.sfx.get();
    toggle.setAttribute('aria-checked', String(s.enabled));
    toggle.classList.toggle('active', s.enabled);
    toggle.lastChild.textContent = s.enabled ? 'Выключить' : 'Включить';
    enabledVal.textContent = s.enabled ? 'вкл' : 'выкл';
  };
  toggle.addEventListener('click', () => { window.sfx.setEnabled(!window.sfx.get().enabled); paint(); save(); if (window.sfx.get().enabled) window.sfx.play('click'); });
  volEl.addEventListener('input', () => {
    const v = +volEl.value;
    volVal.textContent = Math.round(v * 100) + '%';
    window.sfx.setVolume(v); save();
  });
  (async () => {
    try {
      const s = await window.api.getSettings();
      const sd = s && s.sound;
      if (sd) {
        window.sfx.apply(sd);
        volEl.value = sd.volume; volVal.textContent = Math.round((+sd.volume) * 100) + '%';
      }
      paint();
    } catch (_) {}
  })();
})();

// ---------- App self-update (GitHub Releases) ----------
// Loads/saves the repo setting, wires the "Проверить обновления" button, and
// reacts to update events from main. On startup main auto-checks; if a newer
// version exists it sends `update:available` and we prompt the user here.
(function () {
  const repoEl = $('#updateRepo');
  const statusEl = $('#updateStatus');
  const btn = $('#btnCheckUpdate');
  if (!repoEl || !btn) return;

  const setStatus = (text, err) => {
    if (!statusEl) return;
    statusEl.textContent = text || '';
    statusEl.className = 'server-hint' + (err ? ' err' : '');
  };

  // Load the saved repo into the field.
  (async () => {
    try {
      const s = await window.api.getSettings();
      repoEl.value = (s && s.update && s.update.repo) || '';
    } catch (_) {}
  })();

  // Persist the repo on change (debounced).
  let saveTimer = 0;
  repoEl.addEventListener('input', () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      window.api.setSettings({ update: { repo: repoEl.value.trim() } }).catch(() => {});
    }, 400);
  });

  btn.addEventListener('click', () => {
    if (window.sfx) window.sfx.play('click');
    setStatus('Проверка…');
    window.api.checkUpdate();
  });

  // A newer version is available (from auto-check or manual) — ask the user.
  window.api.onUpdateAvailable(async (info) => {
    const notes = (info.notes || '').trim();
    const msg = `Доступна новая версия ${info.version}.\n\nОбновить сейчас?` + (notes ? `\n\n${notes.slice(0, 600)}` : '');
    const ok = await confirmDialog(msg, 'Обновление программы');
    if (ok) {
      if (window.toast) window.toast('Загрузка обновления…', 'ok');
      window.api.confirmUpdate(true);
    } else {
      setStatus('Обновление отменено.');
      window.api.confirmUpdate(false);
    }
  });

  window.api.onUpdateStatus((info) => setStatus(info.text || ''));
  window.api.onUpdateProgress((info) => {
    const pct = info && info.total ? Math.round((info.received / info.total) * 100) : null;
    setStatus(pct != null ? `Загрузка… ${pct}%` : 'Загрузка…');
  });
  window.api.onUpdateUpToDate((info) => setStatus(`Установлена последняя версия${info && info.current ? ' (' + info.current + ')' : ''}.`));
  window.api.onUpdateError((info) => setStatus('Ошибка: ' + ((info && info.error) || ''), true));
})();

async function openAe(kind) {
  if (!state.activeVersion) { toast('Версия After Effects не выбрана.', 'warn'); return; }
  const r = await window.api.openAeFolder(state.activeVersion, kind);
  if (!r.ok) toast(r.error, 'err');
}

// ---------- Stats ----------
function updateStats() {
  const installed = Object.values(state.statuses).filter((s) => s.status === 'installed').length;
  $('#topStats').textContent = `${state.plugins.length} в каталоге · ${installed} установлено`;
}

// ---------- Logs ----------
async function loadLogs() {
  const r = await window.api.logs();
  const box = $('#logBox');
  box.innerHTML = (r.lines || [])
    .map((l) => {
      const cls = /ERROR/i.test(l) ? 'l-error' : /WARN/i.test(l) ? 'l-warn' : /SUCCESS/i.test(l) ? 'l-success' : 'l-info';
      return `<span class="${cls}">${escapeHtml(l)}</span>`;
    })
    .join('\n');
  box.scrollTop = box.scrollHeight;
}

// ---------- Toasts ----------
function toast(msg, kind = 'ok') {
  if (kind === 'err') sfx('error'); // soft muted error tone on any error toast
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, 3800);
}

// ---------- Helpers ----------
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function cssEscape(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c);
}

// ---------- Boot ----------
// Expose toast globally (used across renderer; the full variant's editor module
// also used it, but that module is not part of the lite variant).
window.toast = toast;
// Wire global hover/click sound delegation (no-op if sound.js isn't loaded).
if (window.sfx) window.sfx.bind();

// ---------- Boot ----------
// The lite variant has no in-app catalog editor (no "Редактор" nav, no editor
// view, no editor.js): end users only install/update plugins from a ready-made
// catalog. Admin/editor access is permanently off here.
state.isAdmin = false;
state.lite = true;

init();