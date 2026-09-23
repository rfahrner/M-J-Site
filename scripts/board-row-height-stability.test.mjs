/*
 * Regression test: a load must not change height every time the board redraws.
 *
 * Reported as "the rows kind of jumped, it would like re-sort? so its like 2
 * rows up and then come back and then move down a little", while entering
 * routes, with the board on its default Shift Start sort. The order never
 * actually changed -- entering a route cannot alter a Shift Start -- the loads
 * were changing HEIGHT, which slides everything below them up and down.
 *
 * The loop:
 *
 *   1. every route of a load is minimized, so the render path's openTripsFor()
 *      pushed a fresh blank route to give the dispatcher somewhere to type;
 *   2. minimizeTrip() discards a blank route rather than saving an
 *      identity-less one (which is right -- see blank-route-not-saved);
 *   3. the discard redraws, the redraw finds them all minimized again, and
 *      pushes ANOTHER placeholder.
 *
 * Add a row, drop a row, add a row. Redraws come from every debounced save and
 * every realtime echo, so this ran continuously while someone was typing.
 *
 * The rule this pins: rendering the same unchanged load twice must produce the
 * same number of editable route rows. A render is not allowed to mutate how
 * tall the thing it is rendering is.
 *
 * Run: node scripts/board-row-height-stability.test.mjs
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

// ---------------------------------------------------------------------------
// The real functions, lifted out of loadboard.js so this drives shipped code.
const OPEN_SRC = /function openTripsFor\(row\)[\s\S]*?\n  \}\n/.exec(BOARD)[0];
const BLANK_SRC = /function isBlankRoute\(trip\)[\s\S]*?\n  \}\n/.exec(BOARD)[0];

let uid = 0;
const blankTrip = () => ({
  id: `trip_${++uid}`, dbId: null, routeId: '', tripId: '',
  minimized: false, complete: false,
  routeImagePath: '', routeImagePaths: [],
});
const openTripsFor = new Function('blankTrip', `${OPEN_SRC}; return openTripsFor;`)(blankTrip);
const isBlankRoute = new Function(`${BLANK_SRC}; return isBlankRoute;`)();

const realRoute = (routeId, minimized = true) => ({
  ...blankTrip(), routeId, minimized,
});

// ---------------------------------------------------------------------------
console.log('\n1. a load with an open route is left exactly as it is');
{
  const row = { trips: [realRoute('PF6053', false)] };
  const before = row.trips.length;
  openTripsFor(row);
  openTripsFor(row);
  check('no route was added', row.trips.length, before);
}

console.log('\n2. a load with everything minimized gets somewhere to type');
{
  const row = { trips: [realRoute('PF6053'), realRoute('DG5072')] };
  const open = openTripsFor(row);
  check('exactly one editable route', open.length, 1);
  check('and it is blank', isBlankRoute(open[0]), true);
  check('marked as the placeholder', open[0].autoRoutePlaceholder, true);
  check('the load is one row taller', row.trips.length, 3);
}

console.log('\n3. redrawing the same load does not keep growing it');
{
  const row = { trips: [realRoute('PF6053'), realRoute('DG5072')] };
  openTripsFor(row);
  const afterFirstRender = row.trips.length;
  // Every debounced save and every realtime echo calls renderBoardTable().
  for (let i = 0; i < 25; i++) openTripsFor(row);
  check('height is identical after 25 more redraws', row.trips.length, afterFirstRender);
  check('and there is still only one placeholder',
    row.trips.filter((t) => t.autoRoutePlaceholder).length, 1);
}

console.log('\n4. the add / discard / add loop cannot run');
{
  // This is the reported bug, played out. The placeholder gets collapsed --
  // by the dispatcher, or by any path that sets minimized -- and the next
  // render has to decide what to do about it.
  const row = { trips: [realRoute('PF6053')] };
  const placeholder = openTripsFor(row)[0];
  const heightWithPlaceholder = row.trips.length;

  placeholder.minimized = true;          // collapsed
  const again = openTripsFor(row);       // the redraw that followed

  check('the same placeholder came back, not a second one', again[0], placeholder);
  check('it was reopened rather than replaced', again[0].minimized, false);
  check('so the load is the same height it was', row.trips.length, heightWithPlaceholder);
  check('and still carries exactly one placeholder',
    row.trips.filter((t) => t.autoRoutePlaceholder).length, 1);
}

console.log('\n5. a placeholder the dispatcher typed into is a real route');
{
  const row = { trips: [realRoute('PF6053')] };
  const placeholder = openTripsFor(row)[0];
  // Typing into a route clears the flag -- see the input handler.
  placeholder.autoRoutePlaceholder = false;
  placeholder.routeId = 'PF6016';
  check('it is no longer blank', isBlankRoute(placeholder), false);

  placeholder.minimized = true;                 // minimized as a real route
  const open = openTripsFor(row);
  check('a genuinely new blank route is offered', open[0] === placeholder, false);
  check('which is the placeholder again', open[0].autoRoutePlaceholder, true);
  check('and the typed route was kept', row.trips.includes(placeholder), true);
}

console.log('\n6. collapsing the placeholder is a no-op, not a discard');
// minimizeTrip() discards a blank route rather than saving an identity-less
// one. Applied to the placeholder, that discard is what the next render
// immediately undid -- so it has to bail out before the discard instead.
const MINIMIZE = /async function minimizeTrip\([\s\S]*?\n  \}\n/.exec(BOARD)[0];
check('it returns early for the placeholder',
  /if \(trip\.autoRoutePlaceholder && isBlankRoute\(trip\)\) return;/.test(MINIMIZE), true);
check('before reaching the discard',
  MINIMIZE.indexOf('autoRoutePlaceholder') < MINIMIZE.indexOf('discardRoute'), true);
// The discard itself must survive for genuinely empty slots the dispatcher
// added and abandoned -- that is what keeps identity-less routes out of the
// database in the first place.
check('a real empty slot is still discarded', /await discardRoute\(row, trip\);/.test(MINIMIZE), true);

console.log('\n7. nothing else re-adds a placeholder behind its back');
const CODE = BOARD.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
check('only openTripsFor creates one',
  (CODE.match(/autoRoutePlaceholder = true/g) || []).length, 1);

console.log(failures ? `\n  ${failures} check(s) FAILED\n` : '\n  All checks passed.\n');
process.exit(failures ? 1 : 0);
