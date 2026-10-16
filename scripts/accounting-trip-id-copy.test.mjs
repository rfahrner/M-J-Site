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
 *   3. Every load row offers Delete from Accounting, even without a Trip ID.
 *   4. It closes on click-away, Escape and scroll. Accounting never runs
 *      initBoardPage(), so loadboard.js's closers are NOT on this page;
 *      this module owns them. Deleting them as "duplicates" would leave
 *      the menu stuck on screen.
 *   5. Rate Customer, Rate Carrier and Aljex # each offer Copy of their own
 *      value. Adding Delete to every row made this handler preventDefault()
 *      on every row, which took the browser's Cut/Copy/Paste off those three
 *      fields and replaced it with a menu holding Delete alone. Reported
 *      2026-10-16: "it caused our right click - copy to stop working".
 *   6. A selection inside the row is left to the browser, so Copy there takes
 *      the highlighted text rather than the whole cell.
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
      <td><span class="acct-load-reference"><span class="acct-load-text" contenteditable="true" data-action="acct-aljex-number" data-id="101">2012345</span></span></td>
      <td>$<input class="cell-input" data-action="acct-customer-rate" data-id="101" value="900.00"></td>
      <td>$<input class="cell-input" data-action="acct-carrier-pay" data-id="101" value="600.00"></td>
      <td>$<input class="cell-input" data-action="acct-carrier-pay" data-id="101" value="" id="empty-rate"></td>
      <td><input type="checkbox" data-action="acct-sent" data-id="101"></td>
    </tr>
    <tr id="acct-202">
      <td class="other-row-cell">Another load</td>
      <td>$<input class="cell-input" data-action="acct-carrier-pay" data-id="202" value="123.45"></td>
    </tr>
  </tbody></table>
</body>`, { url: 'https://rfahrner.github.io/M-J-Site/accounting.html' });

globalThis.document = dom.window.document;
globalThis.window = dom.window;
globalThis.CustomEvent = dom.window.CustomEvent;
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
  menu().textContent, 'Copy Trip ID 2210556Delete from Accounting');
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
check('the item says Route ID there', menu().textContent, 'Copy Route ID 2210556Delete from Accounting');
$('#acct-location-tabs .location-tab[data-location="delaware"]').classList.remove('is-active');
$('#acct-location-tabs .location-tab[data-location="atlanta"]').classList.add('is-active');
mod.closeAccountingContextMenu();

console.log('\n5. an empty identifier still offers deletion');
const dashEv = rightClick(pill(1));
check('row menu suppresses browser menu', dashEv.defaultPrevented, true);
check('empty identifier still offers deletion', menu().textContent, 'Delete from Accounting');
mod.closeAccountingContextMenu();

console.log('\n6. other cells in the load row also offer deletion');
const cellEv = rightClick($('.plain-cell'));
check('normal row cell opens menu', cellEv.defaultPrevented, true);
check('row offers deletion', menu().textContent, 'Delete from Accounting');
mod.closeAccountingContextMenu();
const loadEv = rightClick($('.acct-load-number'));
check('the Load # cell opens the same row menu', loadEv.defaultPrevented, true);
let deletionId=null;document.addEventListener('accounting:delete-request',e=>{deletionId=e.detail.accountingId;});
leftClick(menu().querySelector('[data-action="acct-delete"]'));
check('deletion targets the actual accounting ID',deletionId,'101');
check('deletion closes the menu',menu(),null);

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

console.log('\n10. the three editable fields each offer Copy of their own value');
/*
 * The regression this section exists for: right-clicking Rate Carrier used to
 * fall through to the browser, and once Delete was offered on every row it
 * produced a menu with Delete and nothing else -- measured on the real page.
 *
 * Note the value sources. An <input>'s text is .value and its textContent is
 * EMPTY, while the Aljex cell is a contenteditable <span> where it is the
 * other way round. Reading the wrong one gives "Copy Rate Carrier " with
 * nothing after it, and copies nothing.
 */
const field = (action) => $(`#acct-101 [data-action="${action}"]`);

for (const [action, expected] of [
  ['acct-customer-rate', 'Copy Rate Customer 900.00Delete from Accounting'],
  ['acct-carrier-pay', 'Copy Rate Carrier 600.00Delete from Accounting'],
  ['acct-aljex-number', 'Copy Aljex # 2012345Delete from Accounting'],
]) {
  const fieldEv = rightClick(field(action));
  check(`${action} opens our menu`, fieldEv.defaultPrevented, true);
  check(`${action} names its column and value`, menu().textContent, expected);
  mod.closeAccountingContextMenu();
}

console.log('\n11. choosing it copies the field, not the cell around it');
clipboardThrows = false;
dom.window.document.execCommand = () => { clipboard = dom.window.document.querySelector('textarea')?.value ?? null; return true; };
rightClick(field('acct-carrier-pay'));
leftClick(menu().querySelector('[data-action="acct-copy-trip-id"]'));
await settle();
// "$600.00" would mean the <td> was read instead of the input.
check('the clipboard has just the number', clipboard, '600.00');
check('and it said which column', calls.status.at(-1).message, 'Rate Carrier 600.00 copied.');

rightClick(field('acct-aljex-number'));
leftClick(menu().querySelector('[data-action="acct-copy-trip-id"]'));
await settle();
check('the Aljex cell copies its text', clipboard, '2012345');

console.log('\n12. an empty rate offers deletion and nothing to copy');
const emptyEv = rightClick($('#empty-rate'));
check('it still opens our menu', emptyEv.defaultPrevented, true);
check('with no Copy item', menu().textContent, 'Delete from Accounting');
let fieldDeletion = null;
document.addEventListener('accounting:delete-request', (e) => { fieldDeletion = e.detail.accountingId; });
leftClick(menu().querySelector('[data-action="acct-delete"]'));
check('deletion still works from a field cell', fieldDeletion, '101');

console.log('\n13. a cell with no field of its own is unchanged');
// Sent is a checkbox: there is no text on it to copy.
rightClick($('#acct-101 [data-action="acct-sent"]'));
check('a checkbox offers deletion only', menu().textContent, 'Delete from Accounting');
mod.closeAccountingContextMenu();

console.log('\n14. a highlighted selection is left to the browser');
/*
 * Restoring the browser menu alone would not have fixed the report -- a
 * right-click leaves no selection, and Chrome greys Copy out when nothing is
 * selected. But when the dispatcher HAS highlighted something, its Copy takes
 * exactly that, including part of a value or text in a plain cell such as
 * Driver or MC that has no field of its own.
 *
 * An <input>'s internal selection is invisible to window.getSelection(), so
 * the two cases are asked separately and both are pinned here.
 */
const rate = field('acct-carrier-pay');
rate.focus();
rate.setSelectionRange(0, 3);
const selEv = rightClick(rate);
check('the browser menu is NOT suppressed', selEv.defaultPrevented, false);
check('and no menu of ours is in the way', menu(), null);

rate.setSelectionRange(3, 3);
const collapsedEv = rightClick(rate);
check('a caret with nothing selected still gets our menu', collapsedEv.defaultPrevented, true);
check('because that is the one-gesture copy', /Copy Rate Carrier/.test(menu().textContent), true);
mod.closeAccountingContextMenu();

// A document selection, which is how a plain cell gets highlighted.
const range = dom.window.document.createRange();
range.selectNodeContents($('.plain-cell'));
const selection = dom.window.getSelection();
selection.removeAllRanges();
selection.addRange(range);
const plainEv = rightClick($('.plain-cell'));
check('a highlighted plain cell keeps the browser menu', plainEv.defaultPrevented, false);
check('and opens nothing of ours', menu(), null);

console.log('\n15. a selection in ANOTHER row does not disarm this one');
// The selection is still on row 101 from the check above.
const otherEv = rightClick($('#acct-202 .other-row-cell'));
check('the other row still offers its own menu', otherEv.defaultPrevented, true);
check('and it is that row being deleted', menu().textContent, 'Delete from Accounting');
let otherDeletion = null;
document.addEventListener('accounting:delete-request', (e) => { otherDeletion = e.detail.accountingId; });
leftClick(menu().querySelector('[data-action="acct-delete"]'));
check('targeting 202, not 101', otherDeletion, '202');
selection.removeAllRanges();

console.log(failures ? `\n${failures} failing check(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
