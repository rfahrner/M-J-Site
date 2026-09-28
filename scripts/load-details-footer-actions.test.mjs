/*
 * Regression test: Edit and Save in the Load Details footer, and tabs that
 * name the route.
 *
 * The panel scrolls. The in-body Edit button sits at the top of a tab and its
 * Save at the bottom, so on a trip tab -- which is long -- neither is on screen
 * at the moment you want it. Both now also live in the footer beside Close,
 * where they stay put.
 *
 * Two things are easy to get wrong here:
 *
 *  - Two Save buttons must not become two code paths. The footer ones call the
 *    same startLoadDetailsEdit / cancelLoadDetailsEdit / saveLoadDetailsEdit
 *    the in-body ones do; all they add is working out the key from the open
 *    tab instead of reading it off a data attribute.
 *  - They must vanish on the tabs with nothing to edit. Notes, Trip Sheet
 *    Images and Change History only display, and an Edit button that does
 *    nothing is worse than no button.
 *
 * The tabs are now "BA3002/1296760" rather than "BA3002", because a Route ID
 * repeats within a load -- two FRGT legs, two Nestle legs -- and on its own it
 * cannot tell one tab from another.
 *
 * Run: node scripts/load-details-footer-actions.test.mjs
 */

import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (n) => readFileSync(new URL(n, root), 'utf8');
const BOARD = read('loadboard.js');

let failures = 0;
function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) { console.log(`       expected: ${JSON.stringify(expected)}\n       actual:   ${JSON.stringify(actual)}`); failures++; }
}
const extract = (name) =>
  new RegExp(`(?:export )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?\\n  \\}`).exec(BOARD)[0].replace('export ', '');

// ---------------------------------------------------------------------------
console.log('\n1. the tab is named by both numbers');
const tripTabLabel = new Function(`${extract('tripTabLabel')}; return tripTabLabel;`)();
check('route and trip, slashed', tripTabLabel({ routeId: 'BA3002', tripId: '1296760' }, 0), 'BA3002/1296760');
// Either half can be blank on a live board; a dangling slash is not a label.
check('route only', tripTabLabel({ routeId: 'BA3002', tripId: '' }, 0), 'BA3002');
check('trip only', tripTabLabel({ routeId: '', tripId: '1296760' }, 2), '1296760');
check('whitespace is not a value', tripTabLabel({ routeId: '  ', tripId: '  ' }, 3), 'Route 4');
check('neither falls back to the position', tripTabLabel({}, 1), 'Route 2');
check('and the fallback is 1-based', tripTabLabel({ routeId: null, tripId: null }, 0), 'Route 1');

console.log('\n2. the footer knows which tab it is acting on');
const editKey = (tab) =>
  new Function('loadDetailsState', `${extract('loadDetailsEditKey')}; return loadDetailsEditKey();`)({ activeTab: tab });
check('overview edits the load', editKey('overview'), 'overview');
// The in-body button carries the bare local id, so the footer must strip the
// prefix to match -- not pass "trip-abc123" through.
check('a trip tab edits that trip', editKey('trip-abc123'), 'abc123');
for (const tab of ['notes', 'images', 'history']) {
  check(`${tab} has nothing to edit`, editKey(tab), null);
}
check('and no open panel means no key', editKey(undefined), null);

console.log('\n3. the buttons appear and disappear with the state');
// Three buttons is all this needs, and jsdom is not installed in CI -- every
// test the workflow runs gets by on a shim like this one.
const buttons = new Map(['ld-edit-btn','ld-cancel-btn','ld-save-btn'].map((id) => {
  const classes = new Set(['btn','hidden']);
  return [id, { classList: {
    add: (c) => classes.add(c),
    remove: (c) => classes.delete(c),
    contains: (c) => classes.has(c),
    toggle: (c, force) => (force ? classes.add(c) : classes.delete(c)),
  } }];
}));
const $ = (sel) => buttons.get(sel.replace('#','')) || null;
const renderFooter = (state) =>
  new Function('$', 'loadDetailsState', `${extract('loadDetailsEditKey')}\n${extract('renderLoadDetailsFooter')}; return renderLoadDetailsFooter();`)($, state);
const shown = () => ['ld-edit-btn','ld-cancel-btn','ld-save-btn']
  .filter((id) => !$('#'+id).classList.contains('hidden'))
  .map((id) => id.replace('ld-','').replace('-btn',''));

renderFooter({ activeTab: 'overview', editMode: null });
check('reading the overview offers Edit', shown().join(','), 'edit');
renderFooter({ activeTab: 'overview', editMode: 'overview' });
check('editing swaps it for Cancel and Save', shown().join(','), 'cancel,save');
renderFooter({ activeTab: 'trip-abc123', editMode: null });
check('a trip tab offers Edit', shown().join(','), 'edit');
renderFooter({ activeTab: 'trip-abc123', editMode: 'abc123' });
check('and edits under its own key', shown().join(','), 'cancel,save');
// Editing one trip then clicking to another must not leave Save on screen
// pointed at the trip you just left.
renderFooter({ activeTab: 'trip-other', editMode: 'abc123' });
check('a different trip is not still in edit mode', shown().join(','), 'edit');
renderFooter({ activeTab: 'notes', editMode: null });
check('Notes shows none of them', shown().join(','), '');
renderFooter({ activeTab: 'history', editMode: 'overview' });
check('nor does a display-only tab with stale edit state', shown().join(','), '');
renderFooter(null);
check('and a closed panel shows none', shown().join(','), '');

console.log('\n4. one code path, reached two ways');
// The footer must not grow its own copy of the save logic.
const WIRING = /on\("ld-close-btn", "click", closeLoadDetailsModal\);[\s\S]*?on\("ld-save-btn"[\s\S]*?\}\);/.exec(BOARD)[0];
check('Edit calls the same starter', /startLoadDetailsEdit\(key\)/.test(WIRING), true);
check('Cancel calls the same canceller', /on\("ld-cancel-btn", "click", cancelLoadDetailsEdit\)/.test(WIRING), true);
check('Save calls the same saver', /saveLoadDetailsEdit\(key\)/.test(WIRING), true);
// A null key means the tab cannot be edited; acting anyway would throw.
check('Edit does nothing without a key', /if \(key\) startLoadDetailsEdit\(key\)/.test(WIRING), true);
check('Save does nothing without a key', /if \(key\) saveLoadDetailsEdit\(key\)/.test(WIRING), true);
// The in-body buttons stay: they are where the eye already is on a short tab.
check('the in-body Edit is still rendered', /data-ld-edit="overview"/.test(BOARD), true);
check('and the in-body Save is too', /data-ld-save="overview"/.test(BOARD), true);

console.log('\n5. the footer cannot fall out of step');
// Every path that changes tab or edit state ends in this one render.
const CONTENT = /function renderLoadDetailsTabContent\(\) \{\s*(?:\/\/[^\n]*\n\s*){0,6}renderLoadDetailsFooter\(\);/.test(BOARD);
check('the tab render refreshes it', CONTENT, true);
check('and closing clears it', /loadDetailsState = null;\n\s*(?:\/\/[^\n]*\n\s*)?renderLoadDetailsFooter\(\);/.test(BOARD), true);

console.log('\n6. every page carrying the panel got the buttons');
for (const page of ['index.html','dalaware.html','buildingc.html','houston.html','driverlist.html','accounting.html']) {
  const html = read(page);
  const ok = ['ld-edit-btn','ld-cancel-btn','ld-save-btn'].every((id) => html.includes(`id="${id}"`));
  check(`${page}`, ok, true);
  // Hidden to start, or they flash on every page load before the first render.
  check(`${page} starts them hidden`, /id="ld-edit-btn"/.test(html) && /class="btn btn-ghost hidden" id="ld-edit-btn"/.test(html), true);
}

console.log(failures ? `\n  ${failures} check(s) FAILED\n` : '\n  All checks passed.\n');
process.exit(failures ? 1 : 0);
