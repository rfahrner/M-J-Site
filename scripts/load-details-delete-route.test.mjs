/*
 * Regression test for "Delete Route" in the Load Details modal.
 *
 * This button permanently removes a route from a load, so the things worth
 * pinning are the guards, not the happy path:
 *   - it is red, and it is disabled when the load has only one route
 *   - the confirmation names the route and says the load itself survives
 *   - a cancelled confirmation changes nothing at all
 *   - the modal recovers, since the tab it is showing is the one being deleted
 *
 * Run: npm i --no-save jsdom && node scripts/load-details-delete-route.test.mjs
 */

import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const BOARD = readFileSync(new URL('../loadboard.js', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../loadboard.css', import.meta.url), 'utf8');

let failures = 0;
function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) { console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); failures++; }
}
const checkTrue = (label, v) => check(label, !!v, true);

function extractFunction(src, name) {
  let start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`could not find ${name}`);
  if (src.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

const dom = new JSDOM('<!doctype html><html><body></body></html>');
global.window = dom.window; global.document = dom.window.document;

// ---------------------------------------------------------------------------
console.log('\n1. the button is red, and refuses to empty a load');

checkTrue('a solid danger style exists', /\.btn-danger \{/.test(CSS));
checkTrue('it is actually red', /\.btn-danger \{[^}]*background: var\(--red-600/.test(CSS));
checkTrue('the disabled state is styled too', /\.btn-danger:disabled \{/.test(CSS));
checkTrue('the button uses it', /data-ld-delete-trip="\$\{tripLocalId\}"/.test(BOARD)
  && /class="btn btn-danger" data-ld-delete-trip/.test(BOARD));
checkTrue('it is disabled when the load has a single route',
  /\(row\.trips \|\| \[\]\)\.length <= 1 \? ' disabled/.test(BOARD));
checkTrue('the disabled button explains why', /A load needs at least one route\. Clear its fields instead\./.test(BOARD));
checkTrue('it only appears while editing',
  BOARD.indexOf('data-ld-delete-trip') > BOARD.indexOf('data-ld-cancel="${tripLocalId}"') - 4000);

// ---------------------------------------------------------------------------
console.log('\n2. the confirmation names the route and the consequence');

const DELETE_TRIP = extractFunction(BOARD, 'deleteTrip');
checkTrue('it refuses the only route outright', /if \(row\.trips\.length <= 1\)/.test(DELETE_TRIP));
checkTrue('the confirmation names the route', /Delete route \$\{label\}/.test(DELETE_TRIP));
checkTrue('it says the load survives', /Only this route goes — the load itself stays/.test(DELETE_TRIP));
checkTrue('it says it cannot be undone', /This can't be undone/.test(DELETE_TRIP));
checkTrue('it cancels any queued write for that route', /cancelPendingSaves\(null, \[tripId\]\)/.test(DELETE_TRIP));
checkTrue('it logs the deletion', /logChange\(row\.dbId, `\$\{labelForRow\(row\)\} — \$\{label\}`, "route_deleted"/.test(DELETE_TRIP));
checkTrue('it deletes the database row', /from\(TRIPS_TABLE\)\.delete\(\)\.eq\("id", trip\.dbId\)/.test(DELETE_TRIP));

// ---------------------------------------------------------------------------
console.log('\n3. the modal repairs itself only when a route really went');

const ctx = {};
new Function('ctx', `
  const loadDetailsState = ctx.state;
  const findRowAnywhere = ctx.findRowAnywhere;
  const deleteTrip = ctx.deleteTrip;
  const renderLoadDetailsTabs = ctx.renderLoadDetailsTabs;
  ${extractFunction(BOARD, 'deleteTripFromLoadDetails')}
  ctx.run = deleteTripFromLoadDetails;
`)(ctx);

function scenario({ deletes }) {
  const row = { id: 'r1', trips: [{ id: 't1' }, { id: 't2' }, { id: 't3' }] };
  const state = {
    rowId: 'r1', activeTab: 'trip-t2', editMode: 't2', editDraft: { dirty: true },
    stopsByTrip: { t1: [], t2: [{ stopNumber: 1 }], t3: [] },
  };
  let rerendered = 0;
  const c = {};
  new Function('ctx', `
    const loadDetailsState = ctx.state;
    const findRowAnywhere = ctx.findRowAnywhere;
    const deleteTrip = ctx.deleteTrip;
    const renderLoadDetailsTabs = ctx.renderLoadDetailsTabs;
    ${extractFunction(BOARD, 'deleteTripFromLoadDetails')}
    ctx.run = deleteTripFromLoadDetails;
  `)(Object.assign(c, {
    state,
    findRowAnywhere: () => ({ row }),
    // Stands in for a confirmed delete or a cancelled one.
    deleteTrip: async (_rowId, tripId) => {
      if (!deletes) return;
      const i = row.trips.findIndex((t) => t.id === tripId);
      if (i !== -1) row.trips.splice(i, 1);
    },
    renderLoadDetailsTabs: () => { rerendered += 1; },
  }));
  return { run: c.run, state, row, rerendered: () => rerendered };
}

let sc = scenario({ deletes: true });
await sc.run('t2');
check('the route is gone', sc.row.trips.map((t) => t.id).join(','), 't1,t3');
check('the modal leaves the tab that no longer exists', sc.state.activeTab, 'overview');
check('edit mode is dropped', sc.state.editMode, null);
check('the half-typed draft is dropped', sc.state.editDraft, null);
check('the deleted route\'s cached stop times are dropped',
  Object.prototype.hasOwnProperty.call(sc.state.stopsByTrip, 't2'), false);
check('the other routes keep their stop times',
  Object.keys(sc.state.stopsByTrip).sort().join(','), 't1,t3');
check('the tabs are rebuilt once', sc.rerendered(), 1);

// Cancelling the confirmation must be a complete no-op -- in particular it must
// not throw the dispatcher out of the tab they were editing.
sc = scenario({ deletes: false });
await sc.run('t2');
check('nothing is removed when the confirmation is declined', sc.row.trips.length, 3);
check('the dispatcher stays on the tab they were editing', sc.state.activeTab, 'trip-t2');
check('their edit mode survives', sc.state.editMode, 't2');
check('their unsaved draft survives', !!sc.state.editDraft, true);
check('nothing is re-rendered', sc.rerendered(), 0);

// Deleting a route while a DIFFERENT tab is open should not move the user.
sc = scenario({ deletes: true });
sc.state.activeTab = 'overview';
await sc.run('t3');
check('an unrelated open tab is left alone', sc.state.activeTab, 'overview');
check('the route still went', sc.row.trips.map((t) => t.id).join(','), 't1,t2');

// ---------------------------------------------------------------------------
console.log('\n4. the click is wired to the handler');

checkTrue('the edit bar button reaches deleteTripFromLoadDetails',
  /const deleteTripBtn = e\.target\.closest\("\[data-ld-delete-trip\]"\);\s*\n\s*if \(deleteTripBtn\) deleteTripFromLoadDetails\(deleteTripBtn\.dataset\.ldDeleteTrip\);/.test(BOARD));

console.log(failures ? `\n  ${failures} check(s) FAILED\n` : '\n  All checks passed.\n');
process.exit(failures ? 1 : 0);
