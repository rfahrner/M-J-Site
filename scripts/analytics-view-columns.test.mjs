/*
 * Regression test: the analytics pages may only select columns their view has.
 *
 * Location Analytics reported $1,037,928.59 of Q3 revenue against 0 drivers,
 * 0 loads, 0 miles and 0 stops, for weeks, on screen, in a live business.
 *
 * analytics-data-compat.js redirects every analytics-page read of loads_shifts
 * to analytics_shifts_all. That view was built to expose exactly the columns
 * the pages selected at the time. Location Analytics' select list later grew
 * driver_name_text and load_cancelled -- countDrivers() needs both, one to
 * count drivers typed by name and one to skip loads we cancelled -- and the
 * view was never widened to match.
 *
 * PostgREST rejects the WHOLE request over a column name the relation does not
 * have, so the page received no shifts. Routes hang off shift_id IN (...), so
 * mileage, stops, salvage, backhauls and TONU emptied with them. Revenue came
 * from a view that did answer, and a page showing real money beside zero
 * drivers reads as a quiet quarter, not a failed query.
 *
 * Nothing in the browser catches this: the error is one console line on a page
 * nobody has devtools open on. So it is caught here instead, from the view
 * definition checked into supabase/migrations.
 *
 * Run: node scripts/analytics-view-columns.test.mjs
 */

import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (n) => readFileSync(new URL(n, root), 'utf8');

let failures = 0;
function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) { console.log(`       expected: ${JSON.stringify(expected)}\n       actual:   ${JSON.stringify(actual)}`); failures++; }
}

// --- What the view actually exposes -------------------------------------
// Read from the newest migration that redefines it, so the test tracks the
// schema rather than a copy of it that can rot.
const migDir = new URL('supabase/migrations/', root);
const migration = readdirSync(migDir)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .reverse()
  .map((f) => readFileSync(new URL(f, migDir), 'utf8'))
  .find((sql) => /create or replace view public\.analytics_shifts_all/i.test(sql));
if (!migration) throw new Error('no migration defines analytics_shifts_all');

// Only the first UNION branch -- both branches must agree on output names, and
// Postgres takes the names from the first.
const body = /create or replace view public\.analytics_shifts_all as([\s\S]*?)union all/i.exec(migration)[1];
const viewCols = new Set(
  body.slice(body.toLowerCase().indexOf('select') + 6, body.toLowerCase().lastIndexOf('from'))
    .split(',')
    .map((c) => c.trim())
    // "h.driver_name_snapshot as driver_name_text" -> driver_name_text
    .map((c) => (/\sas\s+(\w+)\s*$/i.exec(c) || [])[1] || c.split('.').pop())
    .filter(Boolean)
);

console.log('\n1. the view exposes what the countDrivers() rules need');
// These two are the ones that were missing. Named individually so a failure
// says which rule stops working, not just "a column is absent".
check('driver_name_text -- a driver typed by name is still a driver', viewCols.has('driver_name_text'), true);
check('load_cancelled -- a load we cancelled is not a driver', viewCols.has('load_cancelled'), true);
check('called_off is still there too', viewCols.has('called_off'), true);
check('driver_id, the ordinary case', viewCols.has('driver_id'), true);

console.log('\n2. every analytics page selects only columns it can get');
// Each page's shifts select list, taken from the source rather than restated.
const PAGES = ['location-analytics.js', 'analytics-volume.js', 'analytics-drivers.js'];
for (const page of PAGES) {
  const src = read(page);
  // Both shapes the pages use: fetchAllRows(SHIFTS_TABLE, '...') -- with or
  // without a comment sitting between the two arguments -- and the direct
  // .from(SHIFTS_TABLE).select('...').
  const lists = [
    ...[...src.matchAll(/SHIFTS_TABLE,\s*'([^']+)'/g)].map((m) => m[1]),
    ...[...src.matchAll(/from\(SHIFTS_TABLE\)\s*\.select\('([^']+)'\)/g)].map((m) => m[1]),
  ];
  check(`${page} has a shifts select to check`, lists.length > 0, true);
  for (const list of lists) {
    const missing = list.split(',').map((c) => c.trim()).filter((c) => c && !viewCols.has(c));
    check(`${page}: [${list}]`, missing.join(', ') || 'none missing', 'none missing');
  }
}

console.log('\n3. the compat layer is still what makes this matter');
// If the redirect ever goes away the pages read the base table, which has
// every column, and this whole test is moot rather than wrong. Pin it so the
// reason is discoverable from here.
const COMPAT = read('analytics-data-compat.js');
check('loads_shifts reads are redirected to the view',
  /loads_shifts:\s*'analytics_shifts_all'/.test(COMPAT), true);
check('and only SELECT is redirected, so writes still hit the table',
  /if \(prop === 'select'\)/.test(COMPAT), true);

console.log('\n4. a failed fetch is reported, not drawn as zero');
// The bug was survivable for weeks because an empty result and a broken query
// are the same thing to this page. They must not be again.
const LA = read('location-analytics.js');
check('fetchAllRows records the failure', /reportFetchFailure\(table, error\)/.test(LA), true);
check('the trips loop does too', /reportFetchFailure\(TRIPS_TABLE, tripError\)/.test(LA), true);
check('each range fetch starts a fresh batch', /beginFetchBatch\(\);/.test(LA), true);
check('and the result is put on laState', /laState\.loadError = fetchBatchError\(\);/.test(LA), true);
check('the banner element exists on the page', read('location-analytics.html').includes('id="la-load-error"'), true);
check('and it says the counts are not to be trusted',
  /NOT accurate/.test(LA), true);

console.log(failures ? `\n  ${failures} check(s) FAILED\n` : '\n  All checks passed.\n');
process.exit(failures ? 1 : 0);
