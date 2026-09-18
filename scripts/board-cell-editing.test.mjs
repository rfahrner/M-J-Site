/*
 * Regression test for the "typed value deletes itself / cursor jumps to the
 * route above" bug on a multi-route load.
 *
 * This does NOT re-implement the logic. It lifts the real function bodies out
 * of loadboard.js and runs them against a DOM built to mirror exactly what
 * rowsToHtml() emits for a two-route load -- including the detail that makes
 * the bug possible: route 2 is a SIBLING <tr id="<row.id>__<trip.id>">, not a
 * descendant of <tr id="<row.id>">.
 *
 * Run: npm i --no-save jsdom && node scripts/board-cell-editing.test.mjs
 *
 * Not wired into ci.yml: it needs jsdom, which is deliberately not a
 * dependency of the site itself. Run it by hand when touching the cell
 * editing / realtime merge path.
 */

import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const SRC = readFileSync(new URL('../loadboard.js', import.meta.url), 'utf8');

// ---- lift the real implementations out of the shipped file -----------------
function extractFunction(name) {
  const start = SRC.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`could not find function ${name} in loadboard.js`);
  let i = SRC.indexOf('{', start);
  let depth = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) return SRC.slice(start, i + 1); }
  }
  throw new Error(`unbalanced braces reading ${name}`);
}

const LIFTED = [
  'currentlyEditedField',
  'captureFocusForRerender',
  'markFieldDirty',
  'snapshotDirtyFields',
  'confirmDirtyFieldsSaved',
  'dbFieldsSafeToApply',
].map(extractFunction).join('\n\n');

// Sanity: make sure we lifted the FIXED versions, not something stale.
if (/getElementById\(rowId\)/.test(LIFTED)) {
  throw new Error('lifted currentlyEditedField still uses getElementById(rowId)');
}

// ---- a DOM that matches what the board really renders ---------------------
// row.id = "r_1"; route 1 trip.id = "t_1"; route 2 trip.id = "t_2".
// Shift-level cells live in route 1's <tr> and carry NO data-trip.
const ROW = 'r_1', T1 = 't_1', T2 = 't_2';
const tripCells = (trip) => ['tripId', 'trailer', 'routeMiles', 'stopCount', 'dispatchTime']
  .map((f) => `<td><input class="cell-input" data-row="${ROW}" data-trip="${trip}" data-field="${f}" value=""></td>`)
  .join('');

const dom = new JSDOM(`<!doctype html><html><body>
  <table id="board-table"><tbody>
    <tr id="${ROW}">
      <td><input data-row="${ROW}" data-field="proNumber" value="PRO-1"></td>
      <td><input data-row="${ROW}" data-field="driverName" value="Ewan"></td>
      ${tripCells(T1)}
    </tr>
    <tr id="${ROW}__${T2}" data-parent-row="${ROW}">
      <td colspan="2"></td>
      ${tripCells(T2)}
    </tr>
  </tbody></table>
</body></html>`, { pretendToBeVisual: true });

global.window = dom.window;
global.document = dom.window.document;
global.CSS = dom.window.CSS;

const ctx = {};
new Function('ctx', `${LIFTED}
  ctx.currentlyEditedField = currentlyEditedField;
  ctx.captureFocusForRerender = captureFocusForRerender;
  ctx.markFieldDirty = markFieldDirty;
  ctx.snapshotDirtyFields = snapshotDirtyFields;
  ctx.confirmDirtyFieldsSaved = confirmDirtyFieldsSaved;
  ctx.dbFieldsSafeToApply = dbFieldsSafeToApply;
`)(ctx);

const cell = (trip, field) => document.querySelector(
  `#board-table [data-row="${ROW}"][data-trip="${trip}"][data-field="${field}"]`,
);
const shiftCell = (field) => document.querySelector(
  `#board-table [data-row="${ROW}"][data-field="${field}"]:not([data-trip])`,
);

let failures = 0;
function check(label, actual, expected) {
  const ok = Object.is(actual, expected) ||
    (typeof actual === 'object' && JSON.stringify(actual) === JSON.stringify(expected));
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}`);
  if (!ok) { console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); failures++; }
}

// =========================================================================
console.log('\n1. currentlyEditedField sees the cell the cursor is actually in');

cell(T2, 'tripId').focus();
check('route 2 tripId is reported while focused', ctx.currentlyEditedField(ROW, T2), 'tripId');
check('route 1 is NOT reported while route 2 has focus', ctx.currentlyEditedField(ROW, T1), null);
check('the shift level is NOT reported while a route cell has focus', ctx.currentlyEditedField(ROW, null), null);

cell(T1, 'tripId').focus();
check('route 1 tripId is reported while focused', ctx.currentlyEditedField(ROW, T1), 'tripId');
check('route 2 is NOT reported while route 1 has focus', ctx.currentlyEditedField(ROW, T2), null);

shiftCell('proNumber').focus();
check('a shift cell is reported with tripId = null', ctx.currentlyEditedField(ROW, null), 'proNumber');
check('a shift cell is NOT reported as a route cell', ctx.currentlyEditedField(ROW, T1), null);
check('another row never matches', ctx.currentlyEditedField('r_99', null), null);

// =========================================================================
console.log('\n2. focus restore after a redraw lands on the same route, not the one above');

const typed = cell(T2, 'tripId');
typed.value = '1293405';
typed.focus();
typed.setSelectionRange(7, 7);
const restore = ctx.captureFocusForRerender();

// A realtime redraw replaces the table's innerHTML: same markup, new nodes.
document.querySelector('#board-table tbody').innerHTML =
  document.querySelector('#board-table tbody').innerHTML;
restore();

check('focus is on route 2 after the redraw', document.activeElement.dataset.trip, T2);
check('focus is still the tripId column', document.activeElement.dataset.field, 'tripId');
check('focus did NOT land on route 1', document.activeElement.dataset.trip === T1, false);

shiftCell('driverName').focus();
const restoreShift = ctx.captureFocusForRerender();
document.querySelector('#board-table tbody').innerHTML =
  document.querySelector('#board-table tbody').innerHTML;
restoreShift();
check('a shift cell restores to a shift cell', document.activeElement.dataset.field, 'driverName');
check('a shift cell does not restore into a route cell', !!document.activeElement.dataset.trip, false);

// =========================================================================
console.log('\n3. a stale realtime payload cannot overwrite an unsaved local edit');

const dirtyTripFields = new Map();
// The dispatcher types 1293405 into route 2's Trip ID.
const localTrip = { id: T2, tripId: '1293405', trailer: '', routeMiles: '' };
ctx.markFieldDirty(dirtyTripFields, T2, 'tripId');

// Tab to Trailer # -- the Trip ID cell is no longer focused. This is the case
// the old focus-based preservation could not cover.
cell(T2, 'trailer').focus();
const domField = ctx.currentlyEditedField(ROW, T2);
check('the focused field is now trailer, not tripId', domField, 'trailer');

// A realtime echo of an EARLIER save arrives, still carrying the old Trip ID.
const stale = { tripId: '', trailer: '', routeMiles: '' };
let applicable = ctx.dbFieldsSafeToApply(stale, dirtyTripFields, T2, domField);
Object.assign(localTrip, applicable, { id: localTrip.id });
check('the typed Trip ID survived the stale echo', localTrip.tripId, '1293405');

// Now the debounced save goes out and the database acknowledges that value.
const sent = ctx.snapshotDirtyFields(dirtyTripFields, T2, localTrip);
ctx.confirmDirtyFieldsSaved(dirtyTripFields, T2, sent, localTrip);
check('the field is no longer dirty once acknowledged', dirtyTripFields.has(T2), false);

// A legitimate remote change from another dispatcher must now apply.
applicable = ctx.dbFieldsSafeToApply({ tripId: '9999999' }, dirtyTripFields, T2, null);
Object.assign(localTrip, applicable);
check('a genuine remote change still syncs after the save', localTrip.tripId, '9999999');

// =========================================================================
console.log('\n4. typing again during the round trip keeps the newer value');

ctx.markFieldDirty(dirtyTripFields, T2, 'tripId');
localTrip.tripId = '111';
const inFlight = ctx.snapshotDirtyFields(dirtyTripFields, T2, localTrip); // sends 111
localTrip.tripId = '222';                                                 // typed again
ctx.confirmDirtyFieldsSaved(dirtyTripFields, T2, inFlight, localTrip);
check('still dirty because 222 was never sent', dirtyTripFields.get(T2)?.has('tripId'), true);
applicable = ctx.dbFieldsSafeToApply({ tripId: '111' }, dirtyTripFields, T2, null);
Object.assign(localTrip, applicable);
check('the echo of 111 does not undo 222', localTrip.tripId, '222');

// =========================================================================
console.log('\n5. route 1 and the shift level are protected the same way');

const dirtyShiftFields = new Map();
const row = { id: ROW, proNumber: 'PRO-NEW', driverNameText: 'Ewan', driverId: 7 };
ctx.markFieldDirty(dirtyShiftFields, ROW, 'proNumber');
cell(T2, 'tripId').focus(); // cursor is somewhere else entirely
applicable = ctx.dbFieldsSafeToApply(
  { proNumber: 'PRO-OLD', driverNameText: 'Ewan', driverId: 7 },
  dirtyShiftFields, ROW, ctx.currentlyEditedField(ROW, null),
);
Object.assign(row, applicable, { id: row.id });
check('an unsaved PRO# survives while the cursor is in a route cell', row.proNumber, 'PRO-NEW');

const dirtyTrip1 = new Map();
const trip1 = { id: T1, tripId: 'ROUTE1-NEW' };
ctx.markFieldDirty(dirtyTrip1, T1, 'tripId');
applicable = ctx.dbFieldsSafeToApply({ tripId: 'ROUTE1-OLD' }, dirtyTrip1, T1, null);
Object.assign(trip1, applicable, { id: trip1.id });
check('route 1 is protected too', trip1.tripId, 'ROUTE1-NEW');

// =========================================================================
console.log('\n6. the "someone is editing this row" outline survives a redraw');

// isRowBeingEdited reads two module-level presence stores, so declare them
// alongside the lifted function.
const editCtx = {};
new Function('ctx', `
  let editingRowId = null;
  const remoteEditingTimeouts = new Map();
  ${extractFunction('isRowBeingEdited')}
  ctx.isRowBeingEdited = isRowBeingEdited;
  ctx.setLocal = (id) => { editingRowId = id; };
  ctx.setRemote = (dbId) => remoteEditingTimeouts.set(dbId, 1);
  ctx.clearRemote = (dbId) => remoteEditingTimeouts.delete(dbId);
`)(editCtx);

check('a row nobody is editing is not outlined',
  editCtx.isRowBeingEdited({ id: ROW, dbId: 10 }), false);

editCtx.setLocal(ROW);
check('this session\'s own edited row is outlined',
  editCtx.isRowBeingEdited({ id: ROW, dbId: 10 }), true);
check('a different row is not', editCtx.isRowBeingEdited({ id: 'r_2', dbId: 11 }), false);

editCtx.setLocal(null);
editCtx.setRemote(11);
check('a row another dispatcher is editing is outlined',
  editCtx.isRowBeingEdited({ id: 'r_2', dbId: 11 }), true);
editCtx.clearRemote(11);
check('and stops being outlined when they leave',
  editCtx.isRowBeingEdited({ id: 'r_2', dbId: 11 }), false);
check('an unsaved row (no dbId) never matches a remote edit',
  editCtx.isRowBeingEdited({ id: 'r_3', dbId: null }), false);

// The whole point: rowClasses must emit it, so a full redraw rebuilds it.
check('rowClasses derives the class at render time',
  /isRowBeingEdited\(row\) \? "is-being-edited"/.test(SRC), true);

// =========================================================================
console.log(failures ? `\n${failures} check(s) FAILED\n` : '\nAll checks passed.\n');
process.exit(failures ? 1 : 0);
