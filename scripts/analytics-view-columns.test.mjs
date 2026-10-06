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
const MIGRATIONS = readdirSync(migDir)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .reverse()
  .map((f) => readFileSync(new URL(f, migDir), 'utf8'));

function columnsOf(viewName) {
  const re = new RegExp(`create or replace view public\\.${viewName}\\b`, 'i');
  const migration = MIGRATIONS.find((sql) => re.test(sql));
  if (!migration) throw new Error(`no migration defines ${viewName}`);
  // Only the first UNION branch -- both branches must agree on output names,
  // and Postgres takes the names from the first.
  const bodyRe = new RegExp(`create or replace view public\\.${viewName} as([\\s\\S]*?)union all`, 'i');
  const body = bodyRe.exec(migration)[1];
  return new Set(
    body.slice(body.toLowerCase().indexOf('select') + 6, body.toLowerCase().lastIndexOf('from'))
      .split(',')
      .map((c) => c.trim())
      // "h.driver_name_snapshot as driver_name_text" -> driver_name_text
      .map((c) => (/\sas\s+(\w+)\s*$/i.exec(c) || [])[1] || c.split('.').pop())
      .filter(Boolean)
  );
}

const viewCols = columnsOf('analytics_shifts_all');

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

console.log('\n2b. a FILTER column counts too -- PostgREST rejects on those as well');
/*
 * This is the hole the Location Analytics financial outage went through on
 * 2026-10-06. Section 2 above only reads .select() lists. But
 * .neq('status','deleted') names a column just as surely, and PostgREST
 * rejects the whole request over it the same way -- so every financial column
 * on the page rendered $0.00 for a week while the database held ~$90k of
 * revenue for the week on screen.
 *
 * Any method that names a column is checked, not just select.
 */
const FILTER_METHODS = 'eq|neq|gt|gte|lt|lte|is|in|like|ilike|contains|order';
const ACCOUNTING_COLS = columnsOf('analytics_accounting_all');
const VIEW_FOR_TABLE = {
  SHIFTS_TABLE: viewCols,
  TRIPS_TABLE: columnsOf('analytics_trips_all'),
  ACCOUNTING_TABLE: ACCOUNTING_COLS,
};

for (const page of PAGES) {
  const src = read(page);
  for (const [tableConst, cols] of Object.entries(VIEW_FOR_TABLE)) {
    // Take the WINDOW after each mention of this table, then find every filter
    // inside it. Matching table-then-filter in one regex finds only the FIRST
    // filter of each chain -- which on Location Analytics is .eq('location'),
    // so .neq('status') two lines later went unseen and this test passed
    // straight through the outage it is named for.
    //
    // The window stops at the next _TABLE constant: these pages fetch shifts
    // and then immediately fetch their trips, so a window that runs on reads
    // `.in('shift_id', ...)` off the trips query and blames it on shifts.
    const named = new Set();
    const at = new RegExp(tableConst, 'g');
    for (const m of src.matchAll(at)) {
      let window = src.slice(m.index + tableConst.length, m.index + tableConst.length + 600);
      const nextTable = window.search(/_TABLE/);
      if (nextTable !== -1) window = window.slice(0, nextTable);
      const f = new RegExp(`\\.(?:${FILTER_METHODS})\\(\\s*'([a-z_]+)'`, 'g');
      for (const fm of window.matchAll(f)) named.add(fm[1]);
    }
    const missing = [...named].filter((c) => !cols.has(c));
    check(`${page}: filters on ${tableConst} [${[...named].join(', ') || 'none'}]`,
      missing.join(', ') || 'none missing', 'none missing');
  }
}

console.log('\n2c. every view the compat layer redirects to is checked by name');
/*
 * The 2026-09-25 outage was analytics_shifts_all. The 2026-10-06 one was
 * analytics_accounting_all -- a DIFFERENT view, one this test did not look at.
 * Checking only the view that broke last time is how the same bug arrives
 * through the next one along, so the mapping itself is the list.
 */
const MAPPED = [...read('analytics-data-compat.js')
  .matchAll(/(\w+):\s*'(analytics_\w+)'/g)].map((m) => ({ table: m[1], view: m[2] }));
check('the compat layer still maps tables to views', MAPPED.length > 0, true);
for (const { table, view } of MAPPED) {
  let known = true;
  try { columnsOf(view); } catch (e) { known = false; }
  check(`${view} (for ${table}) is defined by a migration in the repo`, known, true,
    'a view with no migration cannot be checked, so a page can out-grow it unnoticed');
}

check('analytics_accounting_all carries status, the column the outage needed',
  ACCOUNTING_COLS.has('status'), true);

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
check('the trips loop does too', /fetchAllRows\(TRIPS_TABLE,/.test(LA), true);
check('each range fetch starts a fresh batch', /beginFetchBatch\(\);/.test(LA), true);
check('and the result is put on laState', /laState\.loadError = fetchBatchError\(\);/.test(LA), true);
check('the banner element exists on the page', read('location-analytics.html').includes('id="la-load-error"'), true);
check('and it says the counts are not to be trusted',
  /NOT accurate/.test(LA), true);

console.log(failures ? `\n  ${failures} check(s) FAILED\n` : '\n  All checks passed.\n');
process.exit(failures ? 1 : 0);
