// preload.js — secure bridge between the sandboxed renderer and the main process.
// Exposes a small, explicit API on window.api; no Node surface leaks.

const { contextBridge, ipcRenderer } = require('electron');

// Apply the persisted interface theme before first paint so light-theme users
// don't see a dark flash. Runs in the preload's isolated world; setting an
// attribute on <html> is safe and propagates to the page's CSS immediately.
try {
  const s = ipcRenderer.sendSync('app:getSettingsSync');
  if (s && s.uiTheme) document.documentElement.setAttribute('data-ui-theme', s.uiTheme);
} catch (_) {}

contextBridge.exposeInMainWorld('api', {
  init: () => ipcRenderer.invoke('app:init'),
  detectVersions: () => ipcRenderer.invoke('app:detectVersions'),
  scanPc: () => ipcRenderer.invoke('app:scanPc'),
  status: (plugin, version) => ipcRenderer.invoke('app:status', { plugin, version }),
  statusAll: (plugins, version) => ipcRenderer.invoke('app:statusAll', { plugins, version }),
  findApp: (name) => ipcRenderer.invoke('app:findApp', { name }),
  install: (plugin, version) => ipcRenderer.invoke('app:install', { plugin, version }),
  cancelInstall: (id) => ipcRenderer.invoke('app:cancelInstall', { id }),
  uninstall: (plugin, version) => ipcRenderer.invoke('app:uninstall', { plugin, version }),
  launchApp: (plugin, version) => ipcRenderer.invoke('app:launchApp', { plugin, version }),
  isRunning: (plugin, version) => ipcRenderer.invoke('app:isRunning', { plugin, version }),
  closeApp: (plugin, version) => ipcRenderer.invoke('app:closeApp', { plugin, version }),
  relaunchElevated: () => ipcRenderer.invoke('app:relaunchElevated'),
  openFolder: (folder) => ipcRenderer.invoke('app:openFolder', { folder }),
  openAeFolder: (version, kind) => ipcRenderer.invoke('app:openAeFolder', { version, kind }),
  openAppsFolder: () => ipcRenderer.invoke('app:openAppsFolder'),
  reloadConfig: () => ipcRenderer.invoke('app:reloadConfig'),
  getSettings: () => ipcRenderer.invoke('app:getSettings'),
  setSettings: (patch) => ipcRenderer.invoke('app:setSettings', patch),
  testServer: (serverUrl) => ipcRenderer.invoke('app:testServer', { serverUrl }),
  configPath: () => ipcRenderer.invoke('app:configPath'),
  openConfig: () => ipcRenderer.invoke('app:openConfig'),
  resetConfig: () => ipcRenderer.invoke('app:resetConfig'),
  pickAeFolder: () => ipcRenderer.invoke('app:pickAeFolder'),
  // App self-update (GitHub Releases).
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  confirmUpdate: (accept) => ipcRenderer.invoke('update:confirm', !!accept),
  onUpdateAvailable: (cb) => ipcRenderer.on('update:available', (_e, info) => cb(info)),
  onUpdateStatus: (cb) => ipcRenderer.on('update:status', (_e, info) => cb(info)),
  onUpdateProgress: (cb) => ipcRenderer.on('update:progress', (_e, info) => cb(info)),
  onUpdateUpToDate: (cb) => ipcRenderer.on('update:up-to-date', (_e, info) => cb(info)),
  onUpdateError: (cb) => ipcRenderer.on('update:error', (_e, info) => cb(info)),
  // Absolute path for a drag-and-dropped File (Electron webUtils, v30+).
  dropPath: (file) => { try { return require('electron').webUtils.getPathForFile(file); } catch (_) { return ''; } },
  onCatalogUpdated: (cb) => ipcRenderer.on('catalog:updated', (_e, plugins) => cb(plugins)),
  openLogs: () => ipcRenderer.invoke('app:openLogs'),
  logs: () => ipcRenderer.invoke('app:logs'),
  clearLogs: () => ipcRenderer.invoke('app:clearLogs'),
  // Progress events streamed from main during an install.
  onProgress: (cb) => ipcRenderer.on('install:progress', (_e, data) => cb(data)),
  // Custom frameless titlebar controls.
  winMinimize: () => ipcRenderer.send('win:minimize'),
  winMaximizeToggle: () => ipcRenderer.send('win:maximizeToggle'),
  winClose: () => ipcRenderer.send('win:close'),
  winIsMaximized: () => ipcRenderer.invoke('win:isMaximized'),
  onMaximizeChange: (cb) => ipcRenderer.on('win:maximizeChanged', (_e, isMax) => cb(isMax)),
});