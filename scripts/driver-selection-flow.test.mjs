/*
 * Picking a driver finishes the cell. Audit of the whole flow.
 *
 * Reported 2026-10-05: "when I type a drivers name and key down and press
 * enter or click on a driver name, it leaves me in the typing area, so like
 * the options keep poping up... I should stay on the cell, the cell should be
 * selected but the type function should go away."
 *
 * Driving the real functions out of loadboard.js in jsdom found three things,
 * and cleared a fourth:
 *
 *   1. Enter did nothing unless something was highlighted. Typing a full name
 *      and pressing Enter left the text as free text with no profile picked --
 *      it only linked when resolveDriverByName happened to match the typed
 *      string exactly, which is why it felt unreliable rather than broken.
 *      Enter now takes an unambiguous match. It does NOT guess: several
 *      matches with nothing highlighted still falls through, because picking
 *      the first of three Samuels is worse than picking none.
 *
 *   2. The selected-cell marker was set and never cleared. Every driver cell
 *      the dispatcher had been through kept `tabindex="-1"` and
 *      `data-driver-cell-selected` for the rest of the session, so clicking
 *      one landed on the CELL rather than the input -- the click looked
 *      ignored and typing did nothing.
 *
 *   3. Clicking a selected cell did not resume editing.
 *
 *   4. Tab out of a selected cell was already correct, and so was the
 *      click-a-suggestion path. Pinned here so a fix to the above cannot
 *      quietly break them.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(join(root, 'loadboard.js'), 'utf8');

let failures = 0;
function check(label, actual, expected) {
  const ok = Array.isArray(expected)
    ? Array.isArray(actual) && actual.length === expected.length && actual.every((v, i) => v === expected[i])
    : Object.is(actual, expected);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) { console.log(`       expected: ${JSON.stringify(expected)}\n       actual:   ${JSON.stringify(actual)}`); failures++; }
}
function slice(from, to) {
  const a = SRC.indexOf(from), b = SRC.indexOf(to);
  if (a < 0 || b < 0) throw new Error(`anchor moved: ${a < 0 ? from : to}`);
  return SRC.slice(a, b);
}
// The autocomplete, the cell-selection helpers and the Tab handler, verbatim.
const block = slice('  let driverAcBox = null;', '  function renderDriverList()')
  + '\n' + slice('  function normalizedDriverName(value) {', '  function driverPhoneKeys(');

const dom = new JSDOM(`<!doctype html><body><table id="board-table"><tbody><tr id="r1">
  <td class="pin pin-pro"><input class="cell-input" data-row="r1" data-field="proNumber" value=""></td>
  <td class="pin pin-driver"><div class="driver-name-wrap"><input class="cell-input" data-driver-ac="true" data-row="r1" data-field="driverName" value=""></div></td>
  <td class="col-shiftStart"><input class="cell-input" data-row="r1" data-field="shiftStart" value=""></td>
</tr></tbody></table></body>`, { pretendToBeVisual: true });
const { window } = dom;
const doc = window.document;

const drivers = [
  { id: '1', name: 'Samuel Godinez', location: 'atlanta' },
  { id: '2', name: 'Samuel Ortiz', location: 'atlanta' },
  { id: '3', name: 'Gangandeep Aujla', location: 'atlanta' },
];
const added = [];
const picked = [];
const env = {
  $all: (sel, r) => [...(r || doc).querySelectorAll(sel)],
  escapeHtml: (s) => String(s ?? ''),
  findDriver: (id) => drivers.find((d) => String(d.id) === String(id)) || null,
  driversForLocation: () => drivers,
  openAddDriverModal: (_, name) => added.push(name),
  state: { activeLocation: 'atlanta' },
  document: doc,
  window,
  requestAnimationFrame: (fn) => fn(),
};
const api = new Function(...Object.keys(env), `${block.replace(/export function/g, 'function')}
  return { openDriverAutocomplete, updateDriverAutocomplete, closeDriverAutocomplete, handleRowAwareTab,
           box: () => driverAcBox };`)(...Object.values(env));

const $ = (s) => doc.querySelector(s);
const driverInput = $('[data-driver-ac="true"]');
const cell = driverInput.closest('td');
const table = $('#board-table');
table.addEventListener('keydown', (e) => api.handleRowAwareTab(e, '#board-table'));
table.addEventListener('focusin', (e) => {
  if (e.target.dataset?.driverAc === 'true') {
    api.openDriverAutocomplete(e.target, 'atlanta', (drv) => { e.target.value = drv.name; picked.push(drv.name); });
  }
});
table.addEventListener('focusout', (e) => { if (e.target.dataset?.driverAc === 'true') api.closeDriverAutocomplete(); });
table.addEventListener('input', (e) => { if (e.target.dataset?.driverAc === 'true') api.updateDriverAutocomplete(e.target, 'atlanta'); });

const boxOpen = () => { const b = api.box(); return !!b && !b.classList.contains('hidden'); };
const selected = () => cell.hasAttribute('data-driver-cell-selected');
const focusIsOn = () => doc.activeElement === cell ? 'cell' : doc.activeElement === driverInput ? 'input'
  : doc.activeElement?.dataset?.field || 'elsewhere';
const key = (el, k, o = {}) => { const e = new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...o }); el.dispatchEvent(e); return e; };
const type = (el, text) => { el.value = text; el.dispatchEvent(new window.Event('input', { bubbles: true })); };
const tick = () => new Promise((r) => setTimeout(r, 0));
async function startTyping(text) {
  picked.length = 0;
  $('[data-field="proNumber"]').focus(); await tick();
  driverInput.value = ''; driverInput.focus();
  type(driverInput, text);
}

console.log('\n1. the editor is open while typing');
await startTyping('Samuel');
check('suggestions are showing', boxOpen(), true);
check('and the caret is in the field', focusIsOn(), 'input');
check('the cell is not "selected" while being edited', selected(), false);

console.log('\n2. Enter on one unambiguous match picks it — no arrow key needed');
await startTyping('Samuel Godinez');
key(driverInput, 'Enter');
check('the driver was picked', picked, ['Samuel Godinez']);
check('the suggestions are gone', boxOpen(), false);
check('focus stayed on the cell', focusIsOn(), 'cell');
check('and the cell reads as selected', selected(), true);

console.log('\n3. Enter after arrowing picks the highlighted one');
await startTyping('Samuel');
key(driverInput, 'ArrowDown');
key(driverInput, 'ArrowDown');
key(driverInput, 'Enter');
check('the second match was taken', picked, ['Samuel Ortiz']);
check('editor closed', boxOpen(), false);
check('cell selected', selected(), true);

console.log('\n4. Enter does NOT guess between several matches');
await startTyping('Samuel');
key(driverInput, 'Enter');
check('nothing was picked', picked.length, 0);
check('but the editor still closed', boxOpen(), false);
check('and the cell is selected, with the text left alone', selected(), true);
check('the typed text survives', driverInput.value, 'Samuel');

console.log('\n5. sloppy spacing still finds the driver');
// The search used to compare raw text, so a double space matched nobody and
// the list offered to ADD a driver who was already on file.
await startTyping('samuel  godinez');   // sloppy case and spacing
key(driverInput, 'Enter');
check('the exact match was taken', picked, ['Samuel Godinez']);

console.log('\n6. Tab from the selected cell enters the next cell\'s editor');
await startTyping('Gangandeep Aujla');
key(driverInput, 'Enter');
check('selected first', focusIsOn(), 'cell');
const tab = key(doc.activeElement, 'Tab');
check('the board handled the Tab itself', tab.defaultPrevented, true);
check('and landed in the next editable cell', focusIsOn(), 'shiftStart');
await tick();
check('the cell it left is no longer selected', selected(), false);
check('and is no longer a focus target', cell.getAttribute('tabindex'), null);

console.log('\n7. Enter or F2 on a selected cell resumes editing');
await startTyping('Gangandeep Aujla');
key(driverInput, 'Enter');
check('selected', focusIsOn(), 'cell');
key(cell, 'F2');
check('F2 puts the caret back', focusIsOn(), 'input');
await tick();
check('and the cell stops being "selected"', selected(), false);

console.log('\n8. clicking a selected cell resumes editing too');
await startTyping('Gangandeep Aujla');
key(driverInput, 'Enter');
check('selected', selected(), true);
const md = new window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
cell.dispatchEvent(md);
check('the cell did not swallow the click', md.defaultPrevented, true);
check('the caret is back in the field', focusIsOn(), 'input');

console.log('\n9. clicking a suggestion behaves exactly like Enter');
await startTyping('Gang');
const item = api.box().querySelector('[data-pick-driver]');
check('a suggestion is rendered', !!item, true);
item.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
check('it was picked', picked, ['Gangandeep Aujla']);
check('editor closed', boxOpen(), false);
check('cell selected', focusIsOn(), 'cell');

console.log('\n10. a name nobody has offers to add it');
await startTyping('Nobody Here');
added.length = 0;
key(driverInput, 'Enter');
check('the add-driver flow opened', added, ['Nobody Here']);
check('with nothing picked', picked.length, 0);

console.log('\n11. Escape backs out without picking');
await startTyping('Samuel Godinez');
key(driverInput, 'Escape');
check('editor closed', boxOpen(), false);
check('nothing picked', picked.length, 0);
check('and the caret is still in the field', focusIsOn(), 'input');

console.log('\n12. only ever one selected cell');
await startTyping('Gangandeep Aujla');
key(driverInput, 'Enter');
check('exactly one cell is marked', doc.querySelectorAll('td[data-driver-cell-selected]').length, 1);

console.log(failures ? `\n${failures} failing check(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
