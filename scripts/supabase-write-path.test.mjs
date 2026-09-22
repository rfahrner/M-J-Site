/*
 * Regression test for the browser -> Supabase write path.
 *
 * Every bug covered here failed SILENTLY in production: the request either
 * succeeded while writing the wrong thing, or was rejected and the error only
 * reached console.error. Nothing surfaced to the dispatcher, so the board went
 * on showing what they typed while the database held something else. That is
 * why these are pinned by test rather than left to review.
 *
 * Run: npm i --no-save jsdom && node scripts/supabase-write-path.test.mjs
 */

import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const BOARD = readFileSync(new URL('../loadboard.js', import.meta.url), 'utf8');

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
  // Keep a leading `async` -- dropping it turns an async function into one
  // whose body contains a bare `await`, which is a syntax error.
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
console.log('\n1. a value that cannot be parsed never erases the stored one');

const ctx = {};
new Function('ctx', `
  ${extractFunction(BOARD, 'numOrNull')}
  ${extractFunction(BOARD, 'withoutUndefined')}
  ctx.numOrNull = numOrNull; ctx.withoutUndefined = withoutUndefined;
`)(ctx);

check('a blank clears the column', ctx.numOrNull(''), null);
check('null clears the column', ctx.numOrNull(null), null);
check('a plain number goes through', ctx.numOrNull('150'), 150);
check('a decimal goes through', ctx.numOrNull('140.5'), 140.5);
// How people actually type money. Number("1,250.00") is NaN.
check('a thousands separator is tolerated', ctx.numOrNull('1,250.00'), 1250);
check('a currency symbol is tolerated', ctx.numOrNull('$800'), 800);
check('whitespace is tolerated', ctx.numOrNull('  42 '), 42);
// The whole point: garbage must NOT become null.
check('garbage is undefined, not null', ctx.numOrNull('150abc'), undefined);
check('pure text is undefined, not null', ctx.numOrNull('n/a'), undefined);
check('Infinity is rejected', ctx.numOrNull(Infinity), undefined);
check('NaN is rejected', ctx.numOrNull(NaN), undefined);

// undefined keys must be gone before the payload is sent, so the column keeps
// whatever it already held.
const payload = ctx.withoutUndefined({ route_miles: undefined, stop_count: 3, notes: null });
check('an unparseable field is dropped from the payload', 'route_miles' in payload, false);
check('a good field survives', payload.stop_count, 3);
check('an intentional null survives', payload.notes, null);
checkTrue('a dropped key cannot reach the wire',
  !Object.prototype.hasOwnProperty.call(JSON.parse(JSON.stringify(payload)), 'route_miles'));

// ---------------------------------------------------------------------------
console.log('\n2. trip_number is an identity, not an array position');

const SAVE = extractFunction(BOARD, 'saveTripNow');
checkTrue('an existing route never has its trip_number rewritten',
  /delete payload\.trip_number;[\s\S]{0,400}\.update\(payload\)\.eq\("id", trip\.dbId\)/.test(SAVE));
checkTrue('a new route asks for a free number instead of using its position',
  /payload\.trip_number = await nextFreeTripNumber\(shiftDbId, tripNumber\);/.test(SAVE));

const clientWith = (numbers) => ({
  from: () => ({ select: () => ({ eq: async () => ({ data: numbers.map((n) => ({ trip_number: n })), error: null }) }) }),
});
const makeNext = (numbers) => {
  const c = {};
  new Function('ctx', `
    const TRIPS_TABLE = 'loads_trips';
    const supabaseClient = ctx.client;
    ${extractFunction(BOARD, 'nextFreeTripNumber')}
    ctx.nextFreeTripNumber = nextFreeTripNumber;
  `)(Object.assign(c, { client: clientWith(numbers) }));
  return c.nextFreeTripNumber;
};

// Route 1 was deleted, so the DB holds 2 and 3 while the array holds 2 entries.
// Adding a route must not reuse 2 or 3.
const SHIFT = 99; // nextFreeTripNumber(shiftDbId, preferred)
check('a free position is used as-is', await makeNext([2, 3])(SHIFT, 4), 4);
check('a taken position falls to the lowest free number', await makeNext([2, 3])(SHIFT, 2), 1);
check('with 1,2,3 taken the next is 4', await makeNext([1, 2, 3])(SHIFT, 2), 4);
check('an empty shift starts at the position asked for', await makeNext([])(SHIFT, 1), 1);
// The real scenario: route 1 was deleted, so the database holds 2 and 3 while
// the array holds two routes. Adding a third must not collide with either.
check('after a delete, a new route avoids the surviving numbers',
  await makeNext([2, 3])(SHIFT, 3), 1);

// ---------------------------------------------------------------------------
console.log('\n3. deleting something cancels the write already queued for it');

const DELETE_ROW = extractFunction(BOARD, 'deleteRow');
const DELETE_TRIP = extractFunction(BOARD, 'deleteTrip');
checkTrue('deleting a load cancels its own and its routes\' pending saves',
  /cancelPendingSaves\(rowId, \(row\.trips \|\| \[\]\)\.map\(\(t\) => t\.id\)\)/.test(DELETE_ROW));
checkTrue('deleting a route cancels that route\'s pending save',
  /cancelPendingSaves\(null, \[tripId\]\)/.test(DELETE_TRIP));
// It has to happen before the row is spliced out, or the trip ids are gone.
checkTrue('cancellation happens before the row is removed',
  DELETE_ROW.indexOf('cancelPendingSaves') < DELETE_ROW.indexOf('rows.splice'));

const CANCEL = extractFunction(BOARD, 'cancelPendingSaves');
checkTrue('the timer is cleared and forgotten', /clearTimeout/.test(CANCEL) && /\.delete\(/.test(CANCEL));

// ---------------------------------------------------------------------------
console.log('\n4. writes go to columns that actually exist');

// loads_shifts has carrier_rate and rate_manual. There is no `rate` column --
// PostgREST rejects the whole request, so the rate AND the manual flag were
// both lost while the screen showed the new number.
for (const file of ['delaware-rate-tiers.js', 'daily-rate-hierarchy.js', 'daily-rate-modal-sync.js']) {
  const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  const shiftUpdates = [...src.matchAll(/loads_shifts'\)[\s\S]{0,120}?\.update\(\{([^}]*)\}/g)].map((m) => m[1]);
  const writesPhantom = shiftUpdates.some((u) => /(^|[\s{,])rate\s*:/.test(u));
  check(`${file} does not write a phantom \`rate\` column`, writesPhantom, false);
  checkTrue(`${file} writes carrier_rate`, /carrier_rate:/.test(src));
}

// ---------------------------------------------------------------------------
console.log('\n5. stop times are upserted against their unique constraint');

check('no bare insert into trip_stops remains',
  /trip_stops"\)\.insert\(/.test(BOARD), false);
check('both save paths upsert on the constraint',
  (BOARD.match(/trip_stops"\)\.upsert\(payload, \{ onConflict: "trip_id,stop_number" \}\)/g) || []).length, 2);

// ---------------------------------------------------------------------------
console.log('\n6. a row is saved under its own date, not the day on screen');

for (const file of ['mondelez.js', 'houston.js']) {
  const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  checkTrue(`${file} saves with row.shiftDate first`, /row\.shiftDate \|\| state\.activeDate/.test(src));
  check(`${file} no longer saves with the active date alone`,
    /RowToDbRow\(row, state\.activeDate\)/.test(src), false);
  checkTrue(`${file} stamps a new row with the day it was created on`,
    /shiftDate: state\.activeDate \|\| null/.test(src));
  checkTrue(`${file} carries the date back from the database`,
    /shiftDate: r\.shift_date \|\| null/.test(src));
}

// ---------------------------------------------------------------------------
console.log('\n7. clearing a rate persists the manual flag going off');

const RECOMPUTE = extractFunction(BOARD, 'recomputeRowRate');
checkTrue('the early return can be overridden', /if \(row\.rate === nextRate && !forceSave\) return;/.test(RECOMPUTE));
checkTrue('the board cell forces it when the rate is cleared',
  /found\.row\.rateManual = false;[\s\S]{0,200}recomputeRowRate\(found\.row, true\)/.test(BOARD));
// Asserted against the function rather than against adjacent lines: what
// matters is that clearing the flag is followed by a forced recompute, not
// that nothing sits between them.
const RESET_RATE = extractFunction(BOARD, 'resetRateToCalculated');
checkTrue('Reset to calculated forces it too',
  /row\.rateManual = false;[\s\S]*recomputeRowRate\(row, true\);/.test(RESET_RATE));

console.log(failures ? `\n  ${failures} check(s) FAILED\n` : '\n  All checks passed.\n');
process.exit(failures ? 1 : 0);
