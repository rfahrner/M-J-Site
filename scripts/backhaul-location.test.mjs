/*
 * Regression test: the backhaul location prompt.
 *
 * Ticking B/Haul already texted the driver a fixed message. It now asks where
 * the pickup is first, names it in that text -- "a BEVCO Backhaul pickup" --
 * and keeps the answer on the route.
 *
 * Four things here are easy to get wrong:
 *
 *  - The column has to be in DEFAULT_TRIP_COL_ORDER *and* the storage key has
 *    to move. getOrderedTripSubcols() maps over the order saved in the
 *    browser, so a column missing from that list never renders for anyone who
 *    has used the board before -- which is everyone.
 *  - Hidden means hidden by default, not absent. It is in hiddenCols and it
 *    has a stylesheet rule, so the Columns panel can bring it back.
 *  - A blank location must fall back to the old wording rather than texting a
 *    driver "you have a  Backhaul pickup".
 *  - Salvage is a separate flag and must not have grown a prompt.
 *
 * Run: node scripts/backhaul-location.test.mjs
 */

import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (n) => readFileSync(new URL(n, root), 'utf8');
const BOARD = read('loadboard.js');
const CSS = read('loadboard.css');

let failures = 0;
function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) { console.log(`       expected: ${JSON.stringify(expected)}\n       actual:   ${JSON.stringify(actual)}`); failures++; }
}

// The real message builder, lifted out and run.
const SRC = /function backhaulMessageFor\(location\)[\s\S]*?\n  \}/.exec(BOARD)[0];
const FALLBACK = /const BACKHAUL_MESSAGE = "([^"]+)";/.exec(BOARD)[1];
const backhaulMessageFor = new Function('BACKHAUL_MESSAGE', `${SRC}; return backhaulMessageFor;`)(FALLBACK);

// ---------------------------------------------------------------------------
console.log('\n1. the text names the pickup');
check('the location goes in',
  backhaulMessageFor('BEVCO'),
  'This is D&L, you have a BEVCO Backhaul pickup at your last stop. Please Call or text me your return info (what trailer the load is on, if anything was missing or damaged, and your ETA back) when you are done at your last stop, Also a pic of your stores in and out times.');
check('surrounding wording is untouched from what drivers already get',
  backhaulMessageFor('BEVCO').replace('BEVCO ', ''), FALLBACK);
check('whitespace is trimmed', backhaulMessageFor('  BEVCO  '), backhaulMessageFor('BEVCO'));

console.log('\n2. no location is not a broken sentence');
// "you have a  Backhaul pickup" is what a naive template produces.
for (const [label, value] of [['blank', ''], ['spaces', '   '], ['null', null], ['undefined', undefined]]) {
  check(`${label} falls back to the unnamed wording`, backhaulMessageFor(value), FALLBACK);
}

console.log('\n3. the column exists, and can actually render');
check('it is a trip sub-column', /\{ key: "backhaulLocation", label: "B\/Haul Location"/.test(BOARD), true);
check('grouped with the other backhaul columns', /key: "backhaulLocation"[^}]*group: "backhaul"/.test(BOARD), true);
// The backhaul group is not on Delaware; the location must match or Delaware
// gets a column for a checkbox it does not have.
check('and excluded from Delaware like the rest of them',
  /key: "backhaulLocation"[^}]*excludeLocations: \["delaware"\]/.test(BOARD), true);
const ORDER = /const DEFAULT_TRIP_COL_ORDER = \[([\s\S]*?)\];/.exec(BOARD)[1];
check('it is in the default order', ORDER.includes('"backhaulLocation"'), true);
// This is the one that would have made it invisible in production while
// looking perfect in the source.
check('the stored-order key moved, so saved orders are replaced',
  /TRIP_COL_ORDER_STORAGE_KEY = "dl-trip-col-order-v3"/.test(BOARD), true);
check('it sits next to the B/Haul tick that fills it',
  /"backhaul",\s*\n\s*"backhaulLocation"/.test(ORDER), true);

console.log('\n4. hidden by default, but not removed');
const HIDDEN = /hiddenCols: new Set\(\[([\s\S]*?)\]\)/.exec(BOARD)[1];
check('hidden on load', HIDDEN.includes('"backhaulLocation"'), true);
// Without a stylesheet rule the Columns toggle does nothing at all.
check('the stylesheet can hide it', CSS.includes('table.board.hide-col-backhaulLocation .col-backhaulLocation'), true);

console.log('\n5. the prompt comes before the text');
const HANDLER = /if \(t\.checked && \(t\.dataset\.field === "salvage" \|\| t\.dataset\.field === "backhaul"\)\) \{[\s\S]*?\n          \}/.exec(BOARD)[0];
check('backhaul opens the location modal', /openBackhaulLocationModal\(found\.row, trip, phone\)/.test(HANDLER), true);
check('and no longer texts straight away', /textDriverPhone\(phone, BACKHAUL_MESSAGE\)/.test(HANDLER), false);
// Salvage was never part of this request.
check('salvage still texts immediately', /textDriverPhone\(phone, SALVAGE_MESSAGE\)/.test(HANDLER), true);
check('and salvage gets no prompt', /salvage[\s\S]{0,80}openBackhaulLocationModal/.test(HANDLER), false);

console.log('\n6. confirming saves before it texts');
const CONFIRM = /async function confirmBackhaulLocation\(\)[\s\S]*?\n  \}/.exec(BOARD)[0];
check('the route is re-found by id, not held across a redraw',
  /const found = findRowAnywhere\(target\.rowId\);/.test(CONFIRM), true);
check('a route that vanished is reported, not written to',
  /no longer on the board/.test(CONFIRM), true);
check('the save is awaited', /await saveTripNow\(found\.row, trip/.test(CONFIRM), true);
check('the change is logged', /"backhaul_location", before, value/.test(CONFIRM), true);
check('the text uses the location just saved', /textDriverPhone\(target\.phone, backhaulMessageFor\(value\)\)/.test(CONFIRM), true);
// A dispatcher with no phone on file still gets the location recorded.
check('no phone still records the location', CONFIRM.indexOf('saveTripNow') < CONFIRM.indexOf('no phone on file'), true);
// Unchanged value must not write, or every tick churns the row.
check('an unchanged location is not re-saved', /if \(trip\.backhaulLocation !== value\)/.test(CONFIRM), true);

console.log('\n7. it is kept where it can be read and edited');
check('shown in Load Details', /<legend>B\/Haul Location<\/legend><div class="static-text">\$\{escapeHtml\(trip\.backhaulLocation \|\| "—"\)\}/.test(BOARD), true);
check('editable in Load Details', /id="ld-tr-backhaul-location"/.test(BOARD), true);
check('carried into the edit draft', /backhaulLocation: trip\.backhaulLocation \|\| ""/.test(BOARD), true);
check('and saved back out', /if \(backhaulLocationEl\) trip\.backhaulLocation = backhaulLocationEl\.value\.trim\(\);/.test(BOARD), true);
// The column already existed in the database and in both mappers.
check('the db column is mapped out', /backhaul_location: trip\.backhaulLocation \|\| null/.test(BOARD), true);
check('and mapped back in', /backhaulLocation: dbRow\.backhaul_location \|\| ""/.test(BOARD), true);

console.log(failures ? `\n  ${failures} check(s) FAILED\n` : '\n  All checks passed.\n');
process.exit(failures ? 1 : 0);
