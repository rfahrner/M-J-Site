/*
 * Regression tests for the Stop Times modal and the Mondelez landing tab.
 *
 * Four reported things, three of them in the modal that opens when a route is
 * marked Complete:
 *
 *  - the Mondelez tab opened on West Chester, not All Locations;
 *  - the Time In / Time Out fields were cut off;
 *  - the modal had no Complete checkbox, and should arrive with one ticked;
 *  - "Load checked in" is called "Prospero check in/Post tripped".
 *
 * The Mondelez one is the interesting one. The page already defaulted to the
 * combined view -- that was fixed separately and looked correct in the source
 * -- but renderNav() points a parent tab at its FIRST child, and the first
 * Mondelez child carried ?loc=westchester. initMondelezPage() honours ?loc=,
 * so the default was overwritten before it was ever read. Fixing a default
 * that nothing reaches is why this looked done and wasn't.
 *
 * Run: node scripts/stop-times-modal.test.mjs
 */

import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (n) => readFileSync(new URL(n, root), 'utf8');
const BOARD = read('loadboard.js');
const NAV = read('alerts.js');
const CSS = read('loadboard.css');
const MDZ = read('mondelez.js');

let failures = 0;
function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) { console.log(`       expected: ${JSON.stringify(expected)}\n       actual:   ${JSON.stringify(actual)}`); failures++; }
}

const BOARD_PAGES = ['index.html', 'dalaware.html', 'buildingc.html'];

// ---------------------------------------------------------------------------
console.log('\n1. Mondelez opens on All Locations');
// Both halves have to agree, and only one of them was ever wrong.
check('the page defaults to the combined view', /activeTab: "combined"/.test(MDZ), true);
const MDZ_NAV = /label: "Mondelez",\s*children: \[([\s\S]*?)\],/.exec(NAV)[1];
const firstChild = /href: "(mondelez\.html\?loc=[^"]+)"/.exec(MDZ_NAV)[1];
// renderNav(): `const first = visibleChildren[0]` becomes the parent tab's href.
check('the parent tab lands on the combined view', firstChild, 'mondelez.html?loc=combined');
check('All Locations is not also listed twice',
  (MDZ_NAV.match(/loc=combined/g) || []).length, 1);
check('every DC is still reachable from the dropdown',
  (MDZ_NAV.match(/href: "mondelez\.html\?loc=/g) || []).length, 12);
// The override is what defeated the default, so it has to still be honoured --
// the per-DC links below the parent depend on it.
check('?loc= still selects a tab', /requestedLoc === "combined" \|\| MONDELEZ_LOCATION_KEYS\.has\(requestedLoc\)/.test(MDZ), true);

console.log('\n2. the stop times are readable');
// .cell-input.small is 40px because a board cell needs to be; "14:30" does not
// fit in 40px, which is what clipped them.
check('board cells are still narrow', /\.cell-input\.small \{ text-align: center; width: 40px; \}/.test(CSS), true);
check('the modal rows override that', /\.ld-stop-edit-row \.cell-input \{ width: 92px/.test(CSS), true);

console.log('\n3. Complete arrives ticked');
for (const page of BOARD_PAGES) {
  check(`${page} has the checkbox`, read(page).includes('id="st-complete"'), true);
  check(`${page} ships it checked`, /<input type="checkbox" id="st-complete" checked>/.test(read(page)), true);
}
// Ticked on open regardless of the route's stored state: you got here by
// pressing Complete.
check('opening the modal ticks it', /const completeCheckbox = \$\("#st-complete"\);\s*\n\s*if \(completeCheckbox\) completeCheckbox\.checked = true;/.test(BOARD), true);
check('confirming reads it', /const markComplete = completeBox \? completeBox\.checked : true;/.test(BOARD), true);
// The point of a checkbox is that it can be cleared. Unticking must leave the
// route open, or it is decoration.
check('unticking leaves the route open', /if \(markComplete\) trip\.minimized = true;/.test(BOARD), true);
check('and the history entry matches what happened',
  /if \(markComplete !== wasComplete\)/.test(BOARD), true);
// A page without the checkbox (an older modal) must still complete as before.
check('a missing checkbox still completes', /completeBox \? completeBox\.checked : true/.test(BOARD), true);

console.log('\n4. "Load checked in" is renamed everywhere it is shown');
check('the modal label', read('index.html').includes('<span>Prospero check in/Post tripped</span>'), true);
check('the Load Details trip box', BOARD.includes('<legend>Prospero Check In/Post Tripped</legend>'), true);
check('its edit checkbox', BOARD.includes('<span>Prospero check in/Post tripped</span>'), true);
check('the board\'s missing-fields list', BOARD.includes('label: "Prospero check in/Post tripped"'), true);
check('the accounting route check', read('accounting-columns.js').includes("'Prospero check in/Post tripped'"), true);
check('the load integrity check', read('load-details-integrity.js').includes("'Prospero check in/Post tripped'"), true);
check('the megaboard change log', read('megaboard-control-center.js').includes("'Prospero check in/Post tripped'"), true);
// The old wording must be gone from everything a dispatcher reads, or two
// names for one field end up in circulation.
const shown = ['loadboard.js', 'accounting-columns.js', 'load-details-integrity.js', 'megaboard-control-center.js', ...BOARD_PAGES];
for (const file of shown) {
  check(`no "load checked in" left in ${file}`, /load checked in/i.test(read(file)), false);
}
// The database column is untouched -- this is a label change, not a migration.
check('the column is still checked_in', BOARD.includes('checked_in: !!trip.checkedIn'), true);

console.log('\n5. the stylesheet token moved with the CSS');
const tokens = new Set([...BOARD_PAGES, 'mondelez.html', 'houston.html'].map((p) => /loadboard\.css\?v=([^"']+)/.exec(read(p))?.[1]));
check('every page agrees', tokens.size, 1);
check('and it is not the previous one', tokens.has('20260923-hover-crisp'), false);

console.log(failures ? `\n  ${failures} check(s) FAILED\n` : '\n  All checks passed.\n');
process.exit(failures ? 1 : 0);
