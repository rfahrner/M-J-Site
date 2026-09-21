/*
 * Regression test for a route being saved twice.
 *
 * saveTripNow() INSERTs whenever trip.dbId is falsy. Correct for a new route;
 * catastrophic for one that already exists, because the route is written a
 * SECOND time. The board then shows it twice, accounting copies both rows, and
 * the customer is billed twice for one trip. 13 routes were duplicated this way
 * between 2026-07-16 and 2026-09-18, six of which reached an invoice --
 * $2,747.86 of over-billing.
 *
 * The two real examples below are what made it visible: the second copy was
 * created 73 and 75 seconds after the first, with a LOWER trip_number, which
 * rules out a sub-second double-submit and points at a route whose local
 * database id went missing between saves.
 *
 * Run: npm i --no-save jsdom && node scripts/trip-duplicate-guard.test.mjs
 */

import { readFileSync } from 'node:fs';

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

// A stand-in for the loads_trips table.
const makeLookup = (rows) => ({
  from: () => ({
    select: () => ({
      eq: (_c1, shiftId) => ({
        eq: (_c2, tripId) => ({
          limit: async (n) => ({
            data: rows.filter((r) => r.shift_id === shiftId && r.trip_id === tripId).slice(0, n).map((r) => ({ id: r.id })),
            error: null,
          }),
        }),
      }),
    }),
  }),
});
const makeFinder = (rows) => {
  const c = {};
  new Function('ctx', `
    const TRIPS_TABLE = 'loads_trips';
    const supabaseClient = ctx.client;
    ${extractFunction(BOARD, 'findExistingTripRow')}
    ctx.find = findExistingTripRow;
  `)(Object.assign(c, { client: makeLookup(rows) }));
  return c.find;
};

// ---------------------------------------------------------------------------
console.log('\n1. a route that already exists is adopted, not inserted again');

// The real Orlando Ross case: shift 16066 already holds trip 1294259 as row 40444.
const existing = [
  { id: 40413, shift_id: 16066, trip_id: '1293775' },
  { id: 40423, shift_id: 16066, trip_id: '1293803' },
  { id: 40444, shift_id: 16066, trip_id: '1294259' },
];
const find = makeFinder(existing);

check('the lost row is found by Trip ID',
  await find(16066, { tripId: '1294259' }), 40444);
check('a genuinely new route is not matched',
  await find(16066, { tripId: '1299999' }), null);
check('the same Trip ID on a different shift is not adopted',
  await find(99999, { tripId: '1294259' }), null);

// ---------------------------------------------------------------------------
console.log('\n2. it refuses to guess');

check('a route with no Trip ID yet is treated as new',
  await find(16066, { tripId: '' }), null);
check('whitespace is not a Trip ID', await find(16066, { tripId: '   ' }), null);
check('a missing Trip ID is treated as new', await find(16066, {}), null);
check('no shift id means no lookup', await find(null, { tripId: '1294259' }), null);

// Where the shift is ALREADY duplicated, adopting either row at random would
// just entrench the mistake. Insert-and-be-visible is the safer failure.
const alreadyDuplicated = [
  { id: 40444, shift_id: 16066, trip_id: '1294259' },
  { id: 40445, shift_id: 16066, trip_id: '1294259' },
];
check('an already-duplicated route is not adopted at random',
  await makeFinder(alreadyDuplicated)(16066, { tripId: '1294259' }), null);

// ---------------------------------------------------------------------------
console.log('\n3. a failed lookup must not cost the edit');

const brokenClient = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ limit: async () => { throw new Error('network down'); } }) }) }) }) };
const broken = {};
new Function('ctx', `
  const TRIPS_TABLE = 'loads_trips';
  const supabaseClient = ctx.client;
  ${extractFunction(BOARD, 'findExistingTripRow')}
  ctx.find = findExistingTripRow;
`)(Object.assign(broken, { client: brokenClient }));
check('a lookup failure falls through rather than throwing',
  await broken.find(16066, { tripId: '1294259' }), null);

// ---------------------------------------------------------------------------
console.log('\n4. the guard runs before the insert, every time');

const SAVE = extractFunction(BOARD, 'saveTripNow');
checkTrue('saveTripNow consults it when the id is missing',
  /if \(!trip\.dbId\) \{[\s\S]{0,300}findExistingTripRow\(shiftDbId, trip\)/.test(SAVE));
checkTrue('an adopted row is assigned before the update/insert decision',
  SAVE.indexOf('trip.dbId = existingDbId') < SAVE.indexOf('if (trip.dbId) {'));
checkTrue('adopting is announced rather than silent', /console\.warn\(/.test(SAVE));
// The existing protections must survive.
checkTrue('an existing route still never has its trip_number rewritten',
  /delete payload\.trip_number;/.test(SAVE));
checkTrue('a genuinely new route still picks a free number',
  /payload\.trip_number = await nextFreeTripNumber\(/.test(SAVE));

console.log(failures ? `\n  ${failures} check(s) FAILED\n` : '\n  All checks passed.\n');
process.exit(failures ? 1 : 0);
