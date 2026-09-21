/*
 * Regression test for the Accounting page showing one route's Trip ID against
 * a different route.
 *
 * route_id is a free-text route NAME, not a key, and it repeats inside a single
 * load all the time -- a driver running two "FRGT" legs, or two "Nestle" legs.
 * Three separate places looked a route up by that text and took the first hit,
 * so the second route inherited the first one's Trip ID, its completion pill,
 * and its click-through target. The database was right the whole time, which is
 * what made it look like a data problem.
 *
 * The fixtures below are the two real loads that surfaced this.
 *
 * Run: npm i --no-save jsdom && node scripts/accounting-route-identity.test.mjs
 */

import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const COLUMNS = readFileSync(new URL('../accounting-columns.js', import.meta.url), 'utf8');
const ACCOUNTING = readFileSync(new URL('../accounting.js', import.meta.url), 'utf8');

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

// Exactly what loads_accounting_routes holds for these two loads.
const CLIFF = [ // Aljex 1985429 -- both routes named "Nestle"
  { route_number: 1, route_id: 'Nestle', trip_id: '1293447', source_trip_id: 40234 },
  { route_number: 2, route_id: 'Nestle', trip_id: '1293499', source_trip_id: 40309 },
];
const ATIBA = [ // Aljex 1985412 -- routes 2 and 3 both named "FRGT"
  { route_number: 1, route_id: 'FA3012', trip_id: '1292417', source_trip_id: 40210 },
  { route_number: 2, route_id: 'FRGT', trip_id: '1293028', source_trip_id: 40294 },
  { route_number: 3, route_id: 'FRGT', trip_id: '1293444', source_trip_id: 40295 },
];

const chipsFor = (routes) => routes.map((r) => {
  const b = document.createElement('button');
  b.dataset.openAcctRouteText = r.route_id || '';
  b.dataset.acctRouteNumber = String(r.route_number);
  b.dataset.acctSourceTrip = String(r.source_trip_id);
  return b;
});

const ctx = {};
new Function('ctx', `${extractFunction(COLUMNS, 'routeForChip')}\nctx.routeForChip = routeForChip;`)(ctx);

// ---------------------------------------------------------------------------
console.log('\n1. each chip resolves to its OWN route, not the first with that name');

let chips = chipsFor(CLIFF);
check('Cliff route 1 -> 1293447', ctx.routeForChip(CLIFF, chips[0], 0).trip_id, '1293447');
check('Cliff route 2 -> 1293499, not a repeat of 1293447',
  ctx.routeForChip(CLIFF, chips[1], 1).trip_id, '1293499');

chips = chipsFor(ATIBA);
check('Atiba route 1 -> 1292417', ctx.routeForChip(ATIBA, chips[0], 0).trip_id, '1292417');
check('Atiba route 2 -> 1293028', ctx.routeForChip(ATIBA, chips[1], 1).trip_id, '1293028');
check('Atiba route 3 -> 1293444, not a repeat of 1293028',
  ctx.routeForChip(ATIBA, chips[2], 2).trip_id, '1293444');

// The exact failure that was reported: no load may show the same Trip ID twice
// when its stored trip_ids are distinct.
for (const [name, routes] of [['Cliff', CLIFF], ['Atiba', ATIBA]]) {
  const shown = chipsFor(routes).map((b, i) => ctx.routeForChip(routes, b, i).trip_id);
  check(`${name}: no Trip ID is displayed twice`, new Set(shown).size, routes.length);
}

// ---------------------------------------------------------------------------
console.log('\n2. it still works for rows that predate route_number');

const legacy = [
  { route_id: 'FRGT', trip_id: '1293028' },
  { route_id: 'FRGT', trip_id: '1293444' },
];
const bare = legacy.map((r) => {
  const b = document.createElement('button');
  b.dataset.openAcctRouteText = r.route_id;
  return b;
});
check('an old row falls back to position, which is still distinct',
  ctx.routeForChip(legacy, bare[1], 1).trip_id, '1293444');
check('an empty route list returns null', ctx.routeForChip([], bare[0], 0), null);
check('a missing route list returns null', ctx.routeForChip(undefined, bare[0], 0), null);

// ---------------------------------------------------------------------------
console.log('\n3. the live-trip lookup no longer leads with the route name');

const live = {};
new Function('ctx', `
  const liveTripsByShiftId = ctx.byShift;
  const liveTripsById = ctx.byId;
  ${extractFunction(COLUMNS, 'findLiveTripForRoute')}
  ctx.findLiveTripForRoute = findLiveTripForRoute;
`)(Object.assign(live, {
  byShift: new Map([[16017, [
    { id: 40210, route_id: 'FA3012', trip_id: '1292417', complete: true },
    { id: 40294, route_id: 'FRGT', trip_id: '1293028', complete: true },
    { id: 40295, route_id: 'FRGT', trip_id: '1293444', complete: false },
  ]]]),
  byId: new Map([
    [40210, { id: 40210, route_id: 'FA3012', trip_id: '1292417', complete: true }],
    [40294, { id: 40294, route_id: 'FRGT', trip_id: '1293028', complete: true }],
    [40295, { id: 40295, route_id: 'FRGT', trip_id: '1293444', complete: false }],
  ]),
}));

const rec = { source_shift_id: 16017, location: 'atlanta' };
check('route 2 resolves to trip 40294', live.findLiveTripForRoute(rec, ATIBA[1], 1).id, 40294);
check('route 3 resolves to trip 40295, not 40294', live.findLiveTripForRoute(rec, ATIBA[2], 2).id, 40295);
// This is what drove the pill colour: route 3 is incomplete, route 2 is done.
check('route 3 reports its own completion state',
  live.findLiveTripForRoute(rec, ATIBA[2], 2).complete, false);

// Without source_trip_id it must still separate them by Trip ID.
const noSource = { route_number: 3, route_id: 'FRGT', trip_id: '1293444' };
check('Trip ID alone is enough to tell two same-named routes apart',
  live.findLiveTripForRoute(rec, noSource, 2).id, 40295);
// An ambiguous name with nothing else falls to position rather than guessing.
const nameOnly = { route_id: 'FRGT' };
check('an ambiguous name falls back to position instead of the first match',
  live.findLiveTripForRoute(rec, nameOnly, 2).id, 40295);

// ---------------------------------------------------------------------------
console.log('\n4. the chip carries its identity and the click uses it');

checkTrue('chips emit their route number', /data-acct-route-number="\$\{escapeHtml\(String\(r\.route_number\)\)\}"/.test(ACCOUNTING));
checkTrue('chips emit the real trip row id', /data-acct-source-trip="\$\{escapeHtml\(String\(r\.source_trip_id\)\)\}"/.test(ACCOUNTING));
checkTrue('opening a route prefers the exact trip id',
  /openBtn\.dataset\.openAcctTrip \|\| openBtn\.dataset\.acctSourceTrip \|\| null/.test(ACCOUNTING));
check('no caller matches a route by name first any more',
  /routes\.find\(\(candidate\) => String\(candidate\.route_id \|\| ''\)\.trim\(\) === routeId\)/.test(COLUMNS), false);
checkTrue('the route identity fetch includes source_trip_id',
  /select\('accounting_id,route_number,route_id,trip_id,source_trip_id'\)/.test(COLUMNS));

console.log(failures ? `\n  ${failures} check(s) FAILED\n` : '\n  All checks passed.\n');
process.exit(failures ? 1 : 0);
