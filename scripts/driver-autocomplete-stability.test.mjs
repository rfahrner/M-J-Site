/*
 * The driver picker stays put, and keeps the row you arrowed to.
 *
 * Reported 2026-10-05: "as I type out a name on the load board, the options
 * are shifting upward to cover what im typing, and if i press the down button
 * and pause itll refresh in a few seconds and wont keep the selection
 * highlighted."
 *
 * Two separate causes.
 *
 * 1. Which side to open on was recomputed on every keystroke. The list
 *    shrinks as a name is typed, so a box that opened BELOW could decide it
 *    now fits ABOVE and jump up over the field -- covering the text being
 *    typed. Re-measuring also raced the DOM: box.scrollHeight was read before
 *    the browser laid out the new contents, so the "above" position came from
 *    the previous list's height and landed on top of the input. The side is
 *    decided once per focus session now and held.
 *
 * 2. renderDriverAcOptions() reset the highlight to -1 every time. A board
 *    redraw refocuses the cell, which reopens the picker, which re-rendered --
 *    so arrowing down and pausing silently lost the selection, and Enter then
 *    did nothing or took the wrong person. The highlight now follows the same
 *    DRIVER, wherever they have moved to in the list.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(join(root, 'loadboard.js'), 'utf8');

let failures = 0;
function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) { console.log(`       expected: ${JSON.stringify(expected)}\n       actual:   ${JSON.stringify(actual)}`); failures++; }
}
const slice = (from, to) => {
  const a = SRC.indexOf(from), b = SRC.indexOf(to);
  if (a < 0 || b < 0) throw new Error(`anchor moved: ${a < 0 ? from : to}`);
  return SRC.slice(a, b);
};
const block = slice('  let driverAcBox = null;', '  function renderDriverList()')
  + '\n' + slice('  function normalizedDriverName(value) {', '  function driverPhoneKeys(');

const DRIVERS = [
  { id: '1', name: 'Samuel Godinez', mc: '1', phone: '1' },
  { id: '2', name: 'Samuel Ortiz', mc: '2', phone: '2' },
  { id: '3', name: 'Samantha Reed', mc: '3', phone: '3' },
  { id: '4', name: 'Gangandeep Aujla', mc: '4', phone: '4' },
];
const dom = new JSDOM(`<!doctype html><body><table id="board-table"><tbody><tr id="r1">
  <td><div class="driver-name-wrap"><input data-driver-ac="true" data-row="r1" data-field="driverName" value=""></div></td>
</tr></tbody></table></body>`, { pretendToBeVisual: true });
const { window } = dom; const doc = window.document;
const input = doc.querySelector('[data-driver-ac="true"]');

// A field low on the page: plenty of room above, little below. That is the
// shape that made the box flip while typing.
let rect = { top: 600, bottom: 624, left: 20, width: 180, height: 24 };
input.getBoundingClientRect = () => rect;
Object.defineProperty(window, 'innerHeight', { value: 700, configurable: true });

const env = {
  $all: (s, r) => [...(r || doc).querySelectorAll(s)],
  escapeHtml: (s) => String(s ?? ''),
  findDriver: (id) => DRIVERS.find((d) => String(d.id) === String(id)) || null,
  driversForLocation: () => DRIVERS,
  openAddDriverModal: () => {},
  state: { activeLocation: 'atlanta' }, document: doc, window,
  requestAnimationFrame: (fn) => fn(),
};
const api = new Function(...Object.keys(env), `${block.replace(/export function/g, 'function')}
  return { openDriverAutocomplete, updateDriverAutocomplete, closeDriverAutocomplete,
           box: () => driverAcBox, highlight: () => driverAcHighlight, matches: () => driverAcMatches,
           openAbove: () => driverAcOpenAbove };`)(...Object.values(env));

const topOf = () => parseFloat(api.box().style.top);
const key = (k) => { const e = new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }); input.dispatchEvent(e); return e; };
const type = (text) => { input.value = text; api.updateDriverAutocomplete(input, 'atlanta'); };
const highlightedName = () => api.matches()[api.highlight()]?.name ?? null;

console.log('\n1. the picker opens on one side and stays there while typing');
input.focus();
api.openDriverAutocomplete(input, 'atlanta', () => {});
const sideAtOpen = api.openAbove();
const topAtOpen = topOf();
check('a side was decided', typeof sideAtOpen, 'boolean');
type('Sam');
check('still the same side after typing', api.openAbove(), sideAtOpen);
type('Samuel');
check('and after narrowing further', api.openAbove(), sideAtOpen);
type('Samuel Godinez');
check('and when only one match is left', api.openAbove(), sideAtOpen);
check('so the box has not jumped', topOf(), topAtOpen);

console.log('\n2. it never sits on top of the field it belongs to');
// Opening below means below the field; opening above means clear of its top.
const boxTop = topOf();
check(sideAtOpen ? 'it is clear above the field' : 'it is below the field',
  sideAtOpen ? boxTop < rect.top : boxTop >= rect.bottom, true);

console.log('\n3. arrowing down and pausing keeps the highlight');
type('Sam');
key('ArrowDown');
check('the first match is highlighted', highlightedName(), 'Samuel Godinez');
// What a board redraw does: close, then reopen on the same field.
api.closeDriverAutocomplete();
input.focus();
api.openDriverAutocomplete(input, 'atlanta', () => {});
check('a redraw does not clear it', highlightedName(), 'Samuel Godinez');
// And a plain re-render, which is what a realtime echo triggers.
type('Sam');
check('nor does a re-render', highlightedName(), 'Samuel Godinez');

console.log('\n4. the highlight follows the driver, not the row number');
key('ArrowDown');
check('now on the second match', highlightedName(), 'Samuel Ortiz');
type('Samuel');   // Samantha drops out, so the list is reordered/shortened
check('still the same person', highlightedName(), 'Samuel Ortiz');

console.log('\n5. a driver who falls out of the list drops the highlight');
type('Godinez');
check('no stale highlight left behind', api.highlight(), -1);
check('and Enter cannot pick someone who is not shown', api.matches()[api.highlight()] ?? null, null);

console.log('\n6. moving to another field decides afresh');
api.closeDriverAutocomplete();
check('closing forgets the side', api.openAbove(), null);

console.log('\n7. the decision is made once, not per render');
const position = /function positionDriverAcBox\(inputEl\)[\s\S]*?\n  \}/.exec(SRC)[0];
check('it only computes a side when none is held', /if \(driverAcOpenAbove === null\)/.test(position), true);
check('and uses the held one', /const openAbove = driverAcOpenAbove;/.test(position), true);
const render = /function renderDriverAcOptions\(query, locationKey\)[\s\S]*?\n  \}/.exec(SRC)[0];
check('the renderer no longer blanks the highlight', /driverAcHighlight = -1;/.test(render), false);
check('it looks the previous driver up by id', /previouslyHighlighted/.test(render), true);

console.log('\n8. Delaware and Kroger use the same edge-safe placement');
for (const location of ['delaware', 'atlanta', 'buildingc']) {
  env.state.activeLocation = location;
  for (const available of [false, true]) {
    if (available) input.dataset.availRow = 'a1';
    else delete input.dataset.availRow;
    rect = { top: 400, bottom: 424, left: 20, width: 180, height: 24 };
    api.openDriverAutocomplete(input, location, () => {});
    check(`${location}/${available}: prefers above`, api.openAbove(), true);
    check('the outer bottom edge is anchored above the input', api.box().style.transform, 'translateY(-100%)');
    check('the anchor leaves a gap', topOf(), rect.top - 2);
    // A scroll can leave less than the old minimum 80px above the field.
    rect.top = 60; rect.bottom = 84;
    api.updateDriverAutocomplete(input, location);
    check('does not force an 80px list into 50px', api.box().style.maxHeight, '50px');
    check('keeps the side when scrolling', api.openAbove(), true);
    api.closeDriverAutocomplete();
    rect.top = 20; rect.bottom = 44;
    api.openDriverAutocomplete(input, location, () => {});
    check('a field at the top opens below', api.openAbove(), false);
    check('below starts after the input', topOf(), 46);
    api.closeDriverAutocomplete();
  }
}
check('arrow navigation never asks ancestors to scroll', /scrollIntoView\(/.test(
  slice('  function setDriverAcHighlight(index)', '  function handleDriverAcKeydown(e)')), false);

console.log(failures ? `\n${failures} failing check(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
