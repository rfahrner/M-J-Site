/*
 * Regression test for the realtime route merge padding a load with phantoms.
 *
 * This is the other half of the duplicate-route bug that
 * scripts/trip-duplicate-guard.test.mjs covers. That one pins the guard in
 * saveTripNow(); this one pins where the route with no dbId came from in the
 * first place.
 *
 * handleRealtimeTripChange() matches an incoming payload to a local route by
 * database id. When that misses -- another dispatcher added a route, or this
 * tab lost track of one -- it used to fall back to
 * parentRow.trips[trip_number - 1], padding the array with blankTrip()s until
 * that index existed. But trip_number is an identity and the array index is a
 * position, and they diverge the moment a route is deleted, which is exactly
 * when this branch runs. The padding left the load carrying routes with no
 * dbId: they render as an empty row under the real one, and saveTripNow()
 * INSERTs anything without a dbId, so the next save wrote a SECOND copy of a
 * real route under whatever trip_number was free.
 *
 * Every duplicate on this board has that signature -- identical Trip ID, and a
 * number LOWER than the original's, because it filled the gap a delete left:
 *
 *   shift 16141  Kelloggs       1297570   numbers 5 then 2
 *   shift 16067  Kimberly Clark 1294647   numbers 3 then 2
 *   shift 16066  PA6013         1294259   numbers 4 then 3
 *
 * Run: node scripts/realtime-trip-merge.test.mjs
 */

import { readFileSync } from 'node:fs';

const BOARD = readFileSync(new URL('../loadboard.js', import.meta.url), 'utf8');

let failures = 0;
function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) { console.log(`       expected: ${JSON.stringify(expected)}\n       actual:   ${JSON.stringify(actual)}`); failures++; }
}

function extractFunction(src, name) {
  let start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`could not find ${name}`);
  if (src.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
  let p = src.indexOf('(', start), parens = 0, j = p;
  for (; j < src.length; j++) {
    if (src[j] === '(') parens++;
    else if (src[j] === ')') { parens--; if (parens === 0) break; }
  }
  let i = src.indexOf('{', j), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

// The real merge, with everything it reaches for outside itself stubbed. The
// three functions below come from loadboard.js verbatim so the shape of a
// merged route is the shipped shape, not a copy that can drift.
const SOURCES = ['handleRealtimeTripChange', 'tripFromDbRow', 'blankTrip', 'dbFieldsSafeToApply']
  .map((name) => extractFunction(BOARD, name)).join('\n\n');

const CAP = /const MAX_TRIPS_PER_LOAD = (\d+);/.exec(BOARD);
check('the route cap is declared once, as a constant', !!CAP, true);

let renders = 0;
const state = { sheets: {} };
const harness = new Function('state', 'countRender', `
  ${SOURCES}
  const MAX_TRIPS_PER_LOAD = ${CAP ? CAP[1] : 5};
  const dirtyTripFields = new Map();
  const BOARD_IMAGE_BUCKET = 'mondelez-routes';
  let seq = 0;
  const uid = (p) => \`\${p}-\${++seq}\`;
  const parseRouteImagePaths = (v) => (v ? String(v).split(',').filter(Boolean) : []);
  const currentlyEditedField = () => null;
  const captureFocusForRerender = () => () => {};
  const renderBoardTable = () => countRender();
  const batchSignImageUrls = async () => {};
  return { handleRealtimeTripChange, tripFromDbRow };
`)(state, () => { renders += 1; });

const dbRow = (id, number, over = {}) => ({
  id, shift_id: 16141, trip_number: number,
  route_id: 'Kelloggs', trip_id: '1297570', trailer_out: '0325221',
  route_miles: 93.8, stop_count: 1, minimized: true, complete: true,
  ...over,
});

function loadWith(...rows) {
  const row = { id: 'row-1', dbId: 16141, trips: rows.map(harness.tripFromDbRow) };
  state.sheets = { atlanta: [row] };
  return row;
}

const send = (dbTrip, eventType = 'UPDATE') =>
  harness.handleRealtimeTripChange({ eventType, new: dbTrip });

const shape = (row) => row.trips.map((t) => `${t.routeId || '(blank)'}:${t.dbId ?? 'no-id'}`).join(' | ');

// ---------------------------------------------------------------------------
console.log('\n1. the real load: routes 1, 4 and 5 after two deletes');
// Exactly shift 16141 on 2026-09-22. Positions are 0,1,2; numbers are 1,4,5.
let row = loadWith(
  dbRow(40522, 1, { route_id: 'BA3001', trip_id: '1296759', route_miles: 69.6, stop_count: 5 }),
  dbRow(40549, 4, { route_id: 'GA3065', trip_id: '1296955', route_miles: 100.4, stop_count: 3 }),
  dbRow(40550, 5),
);
check('three routes to start', row.trips.length, 3);

// The echo that did the damage: route 5, arriving when this tab no longer has
// its database id -- a completion repair, a reload race, a second dispatcher.
row.trips[2].dbId = null;
send(dbRow(40550, 5));
check('no phantom routes were appended to reach index 4', row.trips.length, 3);
check('the load is not padded with blanks', shape(row).includes('(blank)'), false);
check('every route carries a database id', row.trips.every((t) => t.dbId != null), true);
// Reunited with its id rather than appended alongside it. An id-less copy left
// in the array is what saveTripNow() INSERTs.
check('the route is the same one, given its id back', shape(row),
  'BA3001:40522 | GA3065:40549 | Kelloggs:40550');
check('and it kept its local identity', row.trips[2].id.startsWith('trip-'), true);

// ---------------------------------------------------------------------------
console.log('\n2. a route this tab already knows is merged in place');
row = loadWith(dbRow(40522, 1, { route_id: 'BA3001', trip_id: '1296759' }), dbRow(40550, 5));
send(dbRow(40550, 5, { complete: false, minimized: false }));
check('still two routes', row.trips.length, 2);
check('and the change landed on the one it belongs to', row.trips[1].complete, false);

// ---------------------------------------------------------------------------
console.log('\n3. a route added by another dispatcher shows up exactly once');
row = loadWith(dbRow(40522, 1, { route_id: 'BA3001', trip_id: '1296759' }));
send(dbRow(40600, 2, { route_id: 'PA3070', trip_id: '1299999' }), 'INSERT');
check('it was added', row.trips.length, 2);
check('with its data', row.trips[1].routeId, 'PA3070');
// The echo of its own insert, and the echo of the next dispatcher's edit.
send(dbRow(40600, 2, { route_id: 'PA3070', trip_id: '1299999' }));
send(dbRow(40600, 2, { route_id: 'PA3070', trip_id: '1299999', stop_count: 4 }));
check('repeat echoes do not add it again', row.trips.length, 2);
check('they update it', row.trips[1].stopCount, '4');

// ---------------------------------------------------------------------------
console.log('\n4. a high trip_number cannot stretch the load');
row = loadWith(dbRow(40522, 1, { route_id: 'BA3001', trip_id: '1296759' }));
send(dbRow(40700, 9, { route_id: 'ZZ9999', trip_id: '1300000' }));
check('one unknown route is still just one route', row.trips.length, 2);
const cap = Number(CAP ? CAP[1] : 5);
for (let i = 0; i < 10; i += 1) send(dbRow(41000 + i, 1, { route_id: `X${i}`, trip_id: `13001${i}` }));
check('and the load stops at the cap', row.trips.length, cap);

// ---------------------------------------------------------------------------
console.log('\n5. a payload for a shift this tab is not showing is ignored');
row = loadWith(dbRow(40522, 1, { route_id: 'BA3001', trip_id: '1296759' }));
send(dbRow(40800, 2, { shift_id: 99999 }));
check('nothing was added', row.trips.length, 1);
send({ id: null, shift_id: 16141, trip_number: 2, route_id: 'X' });
check('and a payload with no id is ignored too', row.trips.length, 1);

// ---------------------------------------------------------------------------
console.log('\n6. the positional fallback is gone from the source');
// Comments stripped: this file explains the old behaviour at length, and the
// explanation names the very code it is describing.
const MERGE_CODE = extractFunction(BOARD, 'handleRealtimeTripChange')
  .split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
check('no trips[trip_number - 1] indexing', /trip_number\s*-\s*1/.test(MERGE_CODE), false);
check('no blankTrip() padding in the merge', /blankTrip\(\)/.test(MERGE_CODE), false);
check('the board still repaints for other users', renders > 0, true);

console.log(failures ? `\n  ${failures} check(s) FAILED\n` : '\n  All checks passed.\n');
process.exit(failures ? 1 : 0);
