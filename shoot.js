// shoot.js — capture layout screenshots of the catalog grid at given widths
// and card counts, to visually audit the "neatness" of the last-row balancing.
// Usage: npx electron shoot.js
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const SHOTS = [
  { w: 1440, n: 5 },   // lone last card (4 cols)
  { w: 1920, n: 6 },   // lone last card (5 cols)
  { w: 1920, n: 7 },   // 2-card last row (spans 3+2)
  { w: 2560, n: 9 },   // lone last card (8 cols) — the ugly case
  { w: 2560, n: 3 },   // few items
];
const OUT = path.join(__dirname, 'ui', '_shots');
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  await app.whenReady();
  for (const s of SHOTS) {
    const win = new BrowserWindow({ width: s.w, height: 900, show: false, frame: false,
      webPreferences: { contextIsolation: false, nodeIntegration: false, sandbox: false } });
    win.setContentSize(s.w, 900);
    const url = 'file://' + path.join(__dirname, 'ui', '_grid_verify.html') + '?count=' + s.n;
    await new Promise((res) => { win.loadURL(url); win.webContents.once('did-finish-load', () => res()); });
    await new Promise((r) => setTimeout(r, 250));
    await win.webContents.executeJavaScript(
      `if (typeof window.balanceLastRow === 'function') window.balanceLastRow();`, true);
    await new Promise((r) => setTimeout(r, 150));
    const img = await win.webContents.capturePage();
    const file = path.join(OUT, `w${s.w}_n${s.n}.png`);
    fs.writeFileSync(file, img.toPNG());
    win.close();
    console.log('shot', file);
  }
  app.exit(0);
})();