/*
 * Regression test for how a cancelled load presents on the board.
 *
 * Two behaviours, both asked for together: a cancelled load drops to the
 * bottom of the board, and it fades back the way a released row does on the
 * Accounting sheet, so it is obvious at a glance that it is not running.
 *
 * The sort is a RANK rather than two comparisons, because a load can carry
 * both flags -- a cancelled load that was also marked complete has to sort as
 * cancelled, not as complete. Order is: still running, then completed (those
 * ran, so the paperwork can still matter), then cancelled at the very bottom.
 *
 * The fade is opacity on the whole <tr>, pinned columns included. That looks
 * unsafe -- PRO#, Driver and the checkbox are position:sticky, and opacity
 * makes the row one composited group -- but the sticky cells still paint above
 * their siblings inside the group, on their own opaque background, so nothing
 * bleeds through. Part 3 proves that by sampling pixels rather than asserting
 * it, because getComputedStyle cannot see ancestor opacity at all: it
 * composites at paint time and never appears on the child's own style.
 *
 * Run: npm i --no-save playwright && node scripts/cancelled-load-presentation.test.mjs
 */

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const EXECUTABLE = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const root = new URL('../', import.meta.url);
const read = (n) => readFileSync(new URL(n, root), 'utf8');
const SRC = read('loadboard.js');
const CSS = read('loadboard.css');

let failures = 0;
function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}` + (ok ? '' : `\n       expected: ${expected}\n       actual:   ${actual}`));
}

// ---------------------------------------------------------------------------
console.log('1. cancelled loads sink below everything, completed included');

const rankSrc = /const sinkRank = \(r\) => \([^;]*\);/.exec(SRC);
check('sinkRank is declared in the board sort', !!rankSrc, true);
const sinkRank = new Function('r', `return (${/const sinkRank = \(r\) => (\([^;]*\));/.exec(SRC)[1]});`);

const RUNNING   = { id: 'a', driverName: 'Running' };
const COMPLETE  = { id: 'b', driverName: 'Complete',  shiftComplete: true };
const CANCELLED = { id: 'c', driverName: 'Cancelled', loadCancelled: true };
const CALLEDOFF = { id: 'd', driverName: 'Called off', calledOff: true };
const BOTH      = { id: 'e', driverName: 'Both',       shiftComplete: true, loadCancelled: true };

check('a running load ranks first',   sinkRank(RUNNING), 0);
check('a completed load ranks after', sinkRank(COMPLETE), 1);
check('a cancelled load ranks last',  sinkRank(CANCELLED), 2);
check('a driver call-off counts as cancelled', sinkRank(CALLEDOFF), 2);
check('complete AND cancelled sorts as cancelled', sinkRank(BOTH), 2);

// the sort the board actually runs, with no column sort active
const sorted = [CANCELLED, COMPLETE, CALLEDOFF, RUNNING, BOTH]
  .sort((a, b) => sinkRank(a) - sinkRank(b))
  .map((r) => r.driverName);
check('running first, cancelled last', sorted[0], 'Running');
check('completed in the middle', sorted[1], 'Complete');
check('all three terminal rows at the bottom',
  sorted.slice(2).sort().join(','), 'Both,Called off,Cancelled');

// ---------------------------------------------------------------------------
console.log('\n2. the board marks both flags with the same class');
check('either flag sets is-load-cancelled',
  /\(row\.calledOff \|\| row\.loadCancelled\) \? "is-load-cancelled"/.test(SRC), true);
check('the stylesheet fades that class', /tr\.is-load-cancelled \{ opacity: 0\.55; \}/.test(CSS), true);
// Board hover is a JS-applied class, not native :hover -- see
// scripts/board-row-hover.test.mjs for why.
check('and lifts it on hover',
  /tr\.is-load-cancelled\.site-row-hover-current \{ opacity: 1; \}/.test(CSS), true);

// ---------------------------------------------------------------------------
console.log('\n3. the fade does not let columns bleed through the pinned ones');

const row = (cls) => `
  <tr class="${cls}">
    <td class="pin pin-select"><input class="chk" type="checkbox"></td>
    <td class="pin pin-text"></td>
    <td class="pin pin-pro"><span class="static-text">884512</span></td>
    <td class="pin pin-driver"><span class="static-text">Kovalenko</span></td>
    ${Array.from({ length: 16 }, (_, i) =>
      `<td class="col-x"><span class="static-text">BLOCK${i}HEAVY</span></td>`).join('')}
  </tr>`;

const browser = await chromium.launch({ executablePath: EXECUTABLE });
const page = await browser.newPage({ viewport: { width: 900, height: 300 } });
await page.setContent(`<!doctype html><meta charset="utf-8"><style>${CSS}</style>
  <style>body{margin:0;background:#fff}.grid-scroll{width:700px;overflow:auto}
  td.col-x{min-width:170px;white-space:nowrap;font-weight:900}</style>
  <div id="board-view"><div class="grid-scroll"><table class="board" id="board-table"><tbody>
  ${row('')}${row('is-load-cancelled')}</tbody></table></div></div>`);
await page.waitForTimeout(150);

const clip = await page.evaluate(() => {
  document.querySelector('.grid-scroll').scrollLeft = 1200;
  const td = document.querySelector('tr.is-load-cancelled td.pin-driver');
  const r = td.getBoundingClientRect();
  return { x: Math.round(r.x) + 2, y: Math.round(r.y) + 2,
           width: Math.round(r.width) - 4, height: Math.round(r.height) - 4 };
});
await page.waitForTimeout(80);
const shot = await page.screenshot({ clip });

// Decode the PNG in the browser, where there is a canvas, rather than pulling
// in an image library for one measurement.
const ink = await page.evaluate(async (bytes) => {
  const blob = new Blob([new Uint8Array(bytes)], { type: 'image/png' });
  const bmp = await createImageBitmap(blob);
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const g = c.getContext('2d');
  g.drawImage(bmp, 0, 0);
  const { data } = g.getImageData(0, 0, bmp.width, bmp.height);
  let dark = 0, total = 0;
  for (let i = 0; i < data.length; i += 4) {
    const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    total++;
    if (lum < 140) dark++;
  }
  return { total, dark, pct: +(100 * dark / total).toFixed(1) };
}, Array.from(shot));

// The pinned cell holds one short name. If the scrolled columns were showing
// through, this region would be full of extra ink.
check('the pinned cell still reads as mostly background', ink.pct < 25, true);
const stuck = await page.evaluate(() => {
  const a = document.querySelector('tr:not(.is-load-cancelled) td.pin-driver').getBoundingClientRect().left;
  const b = document.querySelector('tr.is-load-cancelled td.pin-driver').getBoundingClientRect().left;
  return Math.round(a) === Math.round(b);
});
check('and it is still pinned in place while scrolled', stuck, true);

await browser.close();
console.log(failures ? `\n  ${failures} check(s) FAILED\n` : '\n  All checks passed.\n');
process.exit(failures ? 1 : 0);
