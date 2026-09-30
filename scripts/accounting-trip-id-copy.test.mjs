/*
 * Right-click a Trip ID pill on Accounting -> copy it.
 *
 * Left-click on that pill already opens the route's details, so the copy
 * had to go somewhere else; the context menu was free.
 *
 * What this pins, and why each one can regress quietly:
 *
 *   1. The clipboard gets what the pill SAYS. Atlanta's pill is relabelled
 *      to the trip_id by accounting-columns.js after the routes load;
 *      Delaware's keeps the route_id. Copying a dataset value instead of
 *      textContent would silently hand over the wrong one on Atlanta.
 *   2. The menu names the column it is standing on -- "Trip ID" on
 *      Atlanta, "Route ID" on Delaware, matching the renamed header.
 *   3. Right-clicking anywhere else on the sheet leaves the browser's own
 *      menu alone. Accounting is a page people copy cells out of.
 *   4. It closes on click-away, Escape and scroll. Accounting never runs
 *      initBoardPage(), so loadboard.js's closers are NOT on this page;
 *      this module owns them. Deleting them as "duplicates" would leave
 *      the menu stuck on screen.
 *
 * Run: npm i --no-save jsdom && node scripts/accounting-trip-id-copy.test.mjs
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

const root = new URL('../', import.meta.url);
const read = (n) => readFileSync(new URL(n, root), 'utf8');

let failures = 0;
function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) { console.log(`       expected: ${JSON.stringify(expected)}\n       actual:   ${JSON.stringify(actual)}`); failures++; }
}

// The module imports loadboard.js, which cannot load outside a browser.
const dir = mkdtempSync(join(tmpdir(), 'mj-acctcopy-'));
const calls = { status: [] };
globalThis.__copyTestCalls = calls;
writeFileSync(join(dir, 'loadboard.mjs'), `
  const calls = globalThis.__copyTestCalls;
  export const escapeHtml = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  export function setDriverSyncStatus(message, kind) { calls.status.push({ message, kind }); }
`);
writeFileSync(join(dir, 'copy.mjs'),
  read('accounting-trip-id-copy.js').replace("'./loadboard.js'", "'./loadboard.mjs'"));

const dom = new JSDOM(`<!doctype html><body>
  <div id="acct-location-tabs">
    <button class="location-tab is-active" data-location="atlanta">Atlanta</button>
    <button class="location-tab" data-location="delaware">Delaware</button>
  </div>
  <table id="accounting-table"><tbody id="accounting-table-body">
    <tr id="acct-101">
      <td class="acct-load-number">1993193</td>
      <td><button type="button" class="trip-chip" data-open-acct-load="101" data-open-acct-route-text="FRGT">2210556</button></td>
      <td><button type="button" class="trip-chip" data-open-acct-load="101" data-open-acct-route-text="">—</button></td>
      <td class="plain-cell">Kroger</td>
    </tr>
  </tbody></table>
</body>`, { url: 'https://rfahrner.github.io/M-J-Site/accounting.html' });

globalThis.document = dom.window.document;
globalThis.window = dom.window;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });

let clipboard = null;
let clipboardThrows = false;
Object.defineProperty(dom.window.navigator, 'clipboard', {
  configurable: true,
  value: { writeText: async (t) => { if (clipboardThrows) throw new Error('denied'); clipboard = t; } },
});
dom.window.document.execCommand = () => { clipboard = dom.window.document.querySelector('textarea')?.value ?? null; return true; };

const mod = await import(join(dir, 'copy.mjs'));
mod.initAccountingTripIdCopy();

const $ = (s) => dom.window.document.querySelector(s);
const menu = () => $('#acct-context-menu');
const settle = () => new Promise((r) => setTimeout(r, 0));
const pill = (n) => dom.window.document.querySelectorAll('button.trip-chip')[n];

function rightClick(el) {
  const ev = new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 90 });
  el.dispatchEvent(ev);
  return ev;
}
function leftClick(el) {
  el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
}

console.log('\n1. the page actually loads this module');
check('accounting.html includes it',
  /src="accounting-trip-id-copy\.js"/.test(read('accounting.html')), true);

console.log('\n2. right-click on a Trip ID pill offers the copy');
const ev = rightClick(pill(0));
check('the browser menu is suppressed', ev.defaultPrevented, true);
check('our menu opened', !!menu(), true);
check('it names the column and the value',
  menu().textContent, 'Copy Trip ID 2210556');
check('it reuses the board menu styling', menu().className, 'row-context-menu');

console.log('\n3. choosing it copies what the pill says');
leftClick(menu().querySelector('[data-action="acct-copy-trip-id"]'));
await settle();
check('the clipboard has the Trip ID', clipboard, '2210556');
check('the menu closed', menu(), null);
check('and it said so', calls.status.at(-1).message, 'Trip ID 2210556 copied.');
check('as a success, not an error', calls.status.at(-1).kind, 'success');

console.log('\n4. Delaware names the column it is standing on');
$('#acct-location-tabs .location-tab[data-location="atlanta"]').classList.remove('is-active');
$('#acct-location-tabs .location-tab[data-location="delaware"]').classList.add('is-active');
rightClick(pill(0));
check('the item says Route ID there', menu().textContent, 'Copy Route ID 2210556');
$('#acct-location-tabs .location-tab[data-location="delaware"]').classList.remove('is-active');
$('#acct-location-tabs .location-tab[data-location="atlanta"]').classList.add('is-active');
mod.closeAccountingContextMenu();

console.log('\n5. a pill with no Trip ID recorded keeps the browser menu');
const dashEv = rightClick(pill(1));
check('nothing was suppressed', dashEv.defaultPrevented, false);
check('and no menu opened', menu(), null);

console.log('\n6. the rest of the sheet keeps the browser menu');
const cellEv = rightClick($('.plain-cell'));
check('a normal cell is left alone', cellEv.defaultPrevented, false);
check('no menu opened', menu(), null);
const loadEv = rightClick($('.acct-load-number'));
check('the Load # cell is left alone too', loadEv.defaultPrevented, false);

console.log('\n7. the menu goes away the three ways a menu should');
rightClick(pill(0));
leftClick(dom.window.document.body);
check('click-away closes it', menu(), null);

rightClick(pill(0));
dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
check('Escape closes it', menu(), null);

rightClick(pill(0));
$('#accounting-table').dispatchEvent(new dom.window.Event('scroll', { bubbles: true }));
check('scrolling the sheet closes it', menu(), null);

rightClick(pill(0));
const second = rightClick(pill(0));
check('a second right-click leaves exactly one menu',
  dom.window.document.querySelectorAll('#acct-context-menu').length, 1);
check('and it still opened', second.defaultPrevented, true);
mod.closeAccountingContextMenu();

console.log('\n8. a blocked clipboard falls back, and says so if even that fails');
clipboardThrows = true;
clipboard = null;
rightClick(pill(0));
leftClick(menu().querySelector('[data-action="acct-copy-trip-id"]'));
await settle();
check('the textarea fallback still copied it', clipboard, '2210556');
check('no leftover scratch textarea', dom.window.document.querySelector('textarea'), null);

dom.window.document.execCommand = () => false;
clipboard = null;
rightClick(pill(0));
leftClick(menu().querySelector('[data-action="acct-copy-trip-id"]'));
await settle();
check('a total failure is reported, not swallowed', calls.status.at(-1).kind, 'error');

console.log('\n9. left-click on the pill is untouched');
check('the pill still carries its open-route wiring',
  pill(0).getAttribute('data-open-acct-load'), '101');
check('and accounting.js still renders it that way',
  /data-open-acct-load="\$\{rec\.id\}"/.test(read('accounting.js')), true);

console.log(failures ? `\n${failures} failing check(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
