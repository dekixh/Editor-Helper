// verify-layout.js — headless layout audit of the catalog grid.
// Loads ui/_grid_verify.html (which uses the REAL styles.css + real .card
// markup) at each target window width and measures:
//   - number of grid columns (auto-computed)
//   - card width
//   - right-side gap (container right edge minus the rightmost card's right edge
//     in the first row) — must be ~0 (cards fill edge-to-edge)
//   - horizontal scroll (document & grid scrollWidth vs clientWidth)
//   - topbar width vs grid-container width (must match)
// Run with: npx electron verify-layout.js
// Prints a results table and exits non-zero on any failure.

const { app, BrowserWindow } = require('electron');
const path = require('path');

const WIDTHS = [1280, 1440, 1600, 1920, 2560];
const HEIGHT = 900;
// Test full rows (multiple of columns) AND partial last rows (the case that
// leaves a void without balancing). Counts chosen to be non-multiples of the
// typical column counts (3..8).
const CASES = [
  { label: 'n14', count: 14 }, { label: 'n3', count: 3 }, { label: 'n5', count: 5 },
  { label: 'n6', count: 6 }, { label: 'n7', count: 7 }, { label: 'n9', count: 9 },
  { label: 'n10', count: 10 }, { label: 'n11', count: 11 },
];

const MEASURE = `(async () => {
  // Wait for the page script to finish building cards.
  for (let i = 0; i < 60 && !window.__gridReady; i++) await new Promise(r => setTimeout(r, 20));
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const grid = document.getElementById('grid');
  const cards = Array.from(grid.querySelectorAll('.card'));
  const containerW = grid.clientWidth;
  const gridRect = grid.getBoundingClientRect();
  const tops = cards.map(c => Math.round(c.getBoundingClientRect().top));
  const firstTop = tops.length ? tops[0] : 0;
  const firstRow = cards.filter((c, i) => Math.round(c.getBoundingClientRect().top) === firstTop);
  const firstLeftGap = firstRow.length ? Math.round(Math.min(...firstRow.map(c => c.getBoundingClientRect().left)) - gridRect.left) : 0;
  const firstRowRightGap = firstRow.length ? Math.round(gridRect.right - Math.max(...firstRow.map(c => c.getBoundingClientRect().right))) : 0;
  const lastTop = tops.length ? tops[tops.length - 1] : 0;
  const lastRow = cards.filter((c, i) => Math.round(c.getBoundingClientRect().top) === lastTop);
  const lastRowCount = lastRow.length;
  // Card width must be FIXED (290px) and identical across ALL cards (no stretch).
  const ws = cards.map(c => Math.round(c.getBoundingClientRect().width));
  const hs = cards.map(c => Math.round(c.getBoundingClientRect().height));
  const cardW = ws.length ? ws[0] : 0;
  const maxCardW = ws.length ? Math.max(...ws) : 0;
  const minCardW = ws.length ? Math.min(...ws) : 0;
  const widthEven = ws.length ? (maxCardW - minCardW) : 0;     // all cards same width
  const maxCardH = hs.length ? Math.max(...hs) : 0;
  const minCardH = hs.length ? Math.min(...hs) : 0;
  const heightEven = hs.length ? (maxCardH - minCardH) : 0;   // all cards same height
  const docHScroll = document.documentElement.scrollWidth - document.documentElement.clientWidth;
  const gridHScroll = grid.scrollWidth - grid.clientWidth;
  const topbar = document.querySelector('.topbar');
  const topbarW = topbar ? Math.round(topbar.getBoundingClientRect().width) : 0;
  const view = document.getElementById('view-catalog');
  const viewW = view ? Math.round(view.getBoundingClientRect().width) : 0;
  return { colCount: firstRow.length, containerW, cardW, maxCardW, minCardW, widthEven,
           maxCardH, minCardH, heightEven, cardCount: cards.length,
           firstLeftGap, firstRowRightGap, lastRowCount,
           docHScroll, gridHScroll, topbarW, viewW };
})()`;

let failures = 0;

function measureOnce(width, count) {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width, height: HEIGHT, show: false, frame: false, resizable: true,
      webPreferences: { contextIsolation: false, nodeIntegration: false, sandbox: false },
    });
    win.setContentSize(width, HEIGHT);
    const file = 'file://' + path.join(__dirname, 'ui', '_grid_verify.html') + '?count=' + count;
    win.loadURL(file);
    win.webContents.once('did-finish-load', async () => {
      // Let layout settle.
      await new Promise((r) => setTimeout(r, 120));
      try {
        const r = await win.webContents.executeJavaScript(MEASURE, true);
        win.close();
        resolve(r);
      } catch (e) {
        win.close();
        resolve({ error: e.message });
      }
    });
  });
}

(async () => {
  await app.whenReady();
  console.log('Catalog grid layout audit (real styles.css, real .card markup)');
  console.log('='.repeat(96));
  for (const w of WIDTHS) {
    for (const c of CASES) {
      const r = await measureOnce(w, c.count);
      if (!r || r.error) { console.log(`W=${w} ${c.label}: ERROR ${r && r.error}`); failures++; continue; }
      // Pass criteria (responsive fill-width grid — cards stretch to fill, equal size):
      const minFloor = r.cardW >= 288;                          // card never shrinks below the 290px floor
      const noOverflow = r.maxCardW <= r.containerW + 2;        // no card wider than the container
      const widthEvenOk = r.widthEven <= 2;                     // ALL cards identical width (equal size)
      const heightEvenOk = r.heightEven <= 2;                   // ALL cards identical height (equal size)
      const leftPacked = r.firstLeftGap <= 2;                  // first card starts at the grid's left edge
      // A FULL first row (count >= columns) must span edge to edge — no right gap.
      const rowFull = r.cardCount >= r.colCount;
      const fillsWidth = !rowFull || r.firstRowRightGap <= 2;   // full rows fill the whole width
      const noHScrollDoc = r.docHScroll <= 0;                   // no document horizontal scroll
      const noHScrollGrid = r.gridHScroll <= 0;                 // no grid horizontal scroll
      const widthAligned = Math.abs(r.topbarW - r.viewW) <= 1;  // topbar == catalog container width
      const ok = minFloor && noOverflow && widthEvenOk && heightEvenOk && leftPacked && fillsWidth && noHScrollDoc && noHScrollGrid && widthAligned;
      if (!ok) failures++;
      const flag = ok ? 'OK ' : 'FAIL';
      console.log(
        `W=${String(w).padStart(4)} ${c.label.padEnd(5)} | ${flag} | cols=${String(r.colCount).padStart(2)} ` +
        `cardW=${String(r.cardW).padStart(3)} wEven=${String(r.widthEven).padStart(2)} ` +
        `cardH=${String(r.maxCardH).padStart(3)} hEven=${String(r.heightEven).padStart(2)} ` +
        `gridW=${String(r.containerW).padStart(4)} 1stL=${String(r.firstLeftGap).padStart(2)} ` +
        `1stR=${String(r.firstRowRightGap).padStart(3)} ` +
        `lastRow=${String(r.lastRowCount).padStart(2)} ` +
        `docH=${String(r.docHScroll).padStart(2)} gridH=${String(r.gridHScroll).padStart(2)} ` +
        `topbarW=${String(r.topbarW).padStart(4)} viewW=${String(r.viewW).padStart(4)}`
      );
    }
  }
  console.log('='.repeat(96));
  if (failures) { console.log(`FAILURES: ${failures}`); app.exit(1); }
  else { console.log('ALL CHECKS PASSED'); app.exit(0); }
})();