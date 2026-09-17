/*
 * Regression test for uniform-route-image-cells.js.
 *
 * The module watches the whole document for DOM changes and normalizes every
 * route-image cell in response. That is only safe if its own writes are
 * idempotent: assigning textContent replaces the child text node even when the
 * string is unchanged, and that is itself a childList mutation the observer is
 * watching. When it was unguarded, one unrelated DOM change anywhere on the
 * page started a loop that rewrote every image cell about 60 times a second,
 * indefinitely -- visible as the IMAGE column flickering narrower and wider
 * while a dispatcher typed, since the board redraws constantly.
 *
 * Part 1 pins the loop shut. Part 2 makes sure it still does its actual job,
 * including after a board redraw and for dropzones outside the board tables
 * (the Load Details modal has them -- see accounting-route-images.js).
 *
 * Run: npm i --no-save playwright && node scripts/image-cell-observer.test.mjs
 *
 * Not wired into ci.yml: it needs playwright, which is deliberately not a
 * dependency of the site. Run it by hand when touching this module or adding
 * another document-wide MutationObserver.
 */

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const MODULE = readFileSync(new URL('../uniform-route-image-cells.js', import.meta.url), 'utf8');

// The preinstalled browser; plain chromium.launch() looks for a build that
// matches whatever playwright version npm just resolved.
const EXECUTABLE = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const DROPZONE = (inner = '') => `<div class="mdz-image-dropzone" data-action="row-image-dropzone">
  ${inner}<input type="file" class="mdz-hidden-file-input"></div>`;
const THUMB = `<span class="mdz-thumb-wrap"><img class="mdz-route-thumb"
  src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"></span>`;

let failures = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) { console.log(`        want ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); failures++; }
}

const browser = await chromium.launch({ executablePath: EXECUTABLE });
const page = await browser.newPage();

await page.setContent(`<!doctype html><html><body>
  <table class="board" id="board-table"><tbody id="tb">
    <tr><td class="col-routeImage">${DROPZONE()}</td></tr>
  </tbody></table>
  <div class="modal">${DROPZONE()}</div>
  <div id="unrelated"></div>
</body></html>`);
await page.addScriptTag({ content: MODULE });
await page.waitForTimeout(200);

// ---- 1. one unrelated DOM change must not start a self-sustaining loop ----
console.log('\n1. the observer does not retrigger itself');

await page.evaluate(() => {
  window.__m = 0;
  new MutationObserver((recs) => { window.__m += recs.length; })
    .observe(document.getElementById('board-table'), { childList: true, subtree: true });
});
// The board mutates constantly in production; one change stands in for that.
await page.evaluate(() => document.getElementById('unrelated').appendChild(document.createElement('span')));
await page.waitForTimeout(1200);
check('no self-inflicted mutations after an unrelated DOM change',
  await page.evaluate(() => window.__m), 0);

// ---- 2. it still normalizes cells, including new ones ----
console.log('\n2. it still does its job');

check('empty cell in the board gets the full hint',
  await page.evaluate(() => document.querySelector('#board-table .mdz-upload-hint')?.textContent),
  'Drop / paste / click');
check('dropzone outside the board tables is normalized too',
  await page.evaluate(() => document.querySelector('.modal .mdz-upload-hint')?.textContent),
  'Drop / paste / click');
check('uniform class applied',
  await page.evaluate(() => document.querySelector('#board-table .mdz-image-dropzone')
    ?.classList.contains('mj-uniform-route-image-cell')), true);

// renderBoardTable() replaces the table's innerHTML wholesale; new cells must
// be picked up.
await page.evaluate(([dzEmpty, dzFull]) => {
  document.getElementById('tb').innerHTML =
    `<tr><td class="col-routeImage">${dzFull}</td></tr><tr><td class="col-routeImage">${dzEmpty}</td></tr>`;
}, [DROPZONE(), DROPZONE(THUMB)]);
await page.waitForTimeout(200);

const hints = await page.evaluate(() =>
  [...document.querySelectorAll('#board-table .mdz-upload-hint')].map((h) => h.textContent));
check('after a redraw, both new cells got a hint', hints.length, 2);
check('occupied cell shows the compact add target', hints[0], '+ Add');
check('empty cell shows the full hint', hints[1], 'Drop / paste / click');

// ---- 3. and it is quiet again once settled ----
console.log('\n3. quiet after the redraw settles');
await page.evaluate(() => { window.__m2 = 0;
  new MutationObserver((recs) => { window.__m2 += recs.length; })
    .observe(document.getElementById('board-table'), { childList: true, subtree: true }); });
await page.waitForTimeout(1000);
check('idle with no mutations', await page.evaluate(() => window.__m2), 0);

await browser.close();
console.log(failures ? `\n  ${failures} check(s) FAILED\n` : '\n  All checks passed.\n');
process.exit(failures ? 1 : 0);
