/*
 * Regression test: a load's rate is never saved from an empty rate table, and
 * two clients that disagree cannot fight over it forever.
 *
 * What happened on 2026-09-22. Two loads had their carrier_rate rewritten
 * roughly twice a second for an hour -- 9,443 rows in load_change_history
 * across 22 shifts -- alternating between two values. For shift 16133
 * (Christopher Woods, one route, FA3026, 140.8 miles, 4 stops) those values
 * were:
 *
 *   740     = his tier-3 rate 700 + 2 chargeable stops x $20
 *   532.80  = 140.8 miles x $3.50 over-tier + the same $40 of stops
 *
 * The second is what calcLoadRateBreakdown() returns when it looks for a
 * mileage band in an EMPTY tier list: carrierMileageTier() answers null and
 * the code falls through to the per-mile rate. cachedTiers starts null and
 * loadBoardRateData() returns early on any query error without setting it, so
 * a client in that state prices every Atlanta and Delaware load low -- and
 * saves it. Shift 16141 was the same shape: 1280 (base tiers) against 2580.
 *
 * Two rules:
 *   - no rate tables, no answer: the breakdown says notReady and nothing
 *     persists it;
 *   - and regardless of the reason, a load whose calculated rate is rewritten
 *     far more often than editing explains stops being written by this client.
 *
 * Run: node scripts/rate-not-ready.test.mjs
 */

import { readFileSync } from 'node:fs';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('../', import.meta.url);
const read = (n) => readFileSync(new URL(n, root), 'utf8');

let failures = 0;
function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) { console.log(`       expected: ${JSON.stringify(expected)}\n       actual:   ${JSON.stringify(actual)}`); failures++; }
}

// ---------------------------------------------------------------------------
console.log('\n1. the limiter gives up on a load being fought over');
// There is no package.json, so a bare .js is CommonJS to node; copy it out.
const dir = mkdtempSync(join(tmpdir(), 'mj-rate-'));
const limiterPath = join(dir, 'rate-write-limiter.mjs');
writeFileSync(limiterPath, read('rate-write-limiter.js'));
const { allowRateWrite, forgetRateWrites, rateWriteState } = await import(limiterPath);

const quiet = console.warn;
console.warn = () => {};
let allowed = 0;
for (let i = 0; i < 40; i += 1) if (allowRateWrite(16141, 'PRO# 1991892')) allowed += 1;
console.warn = quiet;
check('it stops well before 40 writes', allowed < 40, true);
check('and it allowed enough for real editing', allowed >= 10, true);
check('once stopped it stays stopped', allowRateWrite(16141), false);
check('a different load is unaffected', allowRateWrite(16133), true);
// The dispatcher typing a rate settles the argument.
forgetRateWrites(16141);
check('a manual rate lets it save again', allowRateWrite(16141), true);
check('with a fresh count', rateWriteState(16141).count, 1);
check('a load with no database id yet is never blocked', allowRateWrite(null), true);

// ---------------------------------------------------------------------------
console.log('\n2. an empty tier table is not a cheaper rate');
const RATES = read('boardrates.js');
check('readiness is exported', /export function isBoardRateDataReady\(/.test(RATES), true);
check('a mileage location needs its bands',
  /return !!\(cachedTiers\[locationKey\] \|\| \[\]\)\.length;/.test(RATES), true);
check('calcLoadRateBreakdown refuses before they are loaded',
  /if \(!isBoardRateDataReady\(locationKey\)\) \{[\s\S]{0,300}notReady: true/.test(RATES), true);
// The per-mile fallback must be unreachable while the table is empty; that is
// what produced 532.80 for a 740 load.
const calcBody = RATES.slice(RATES.indexOf('export function calcLoadRateBreakdown'));
check('the readiness gate comes before any tier lookup',
  calcBody.indexOf('isBoardRateDataReady') < calcBody.indexOf('carrierMileageTier'), true);

// Run the real readiness function against each cache state.
const readySrc = RATES.slice(RATES.indexOf('export function isBoardRateDataReady'));
const readyFn = readySrc.slice(0, readySrc.indexOf('\n}') + 2).replace('export ', '');
const makeReady = (tiers, settings) =>
  new Function('cachedTiers', 'cachedSettings', `${readyFn}; return isBoardRateDataReady;`)(tiers, settings);

check('null caches are not ready', makeReady(null, null)('atlanta'), false);
check('loaded but empty for the location is not ready', makeReady({ delaware: [{}] }, {})('atlanta'), false);
check('bands present is ready', makeReady({ atlanta: [{ min: 0, max: 25 }] }, {})('atlanta'), true);
check('delaware is judged on its own bands', makeReady({ atlanta: [{}] }, {})('delaware'), false);
// Building C and Houston do not price by mileage band, so they are ready as
// soon as anything has loaded.
check('a flat-rate location only needs the caches', makeReady({}, {})('buildingc'), true);

// ---------------------------------------------------------------------------
console.log('\n3. every writer checks before persisting');
for (const [file, label] of [
  ['loadboard.js', 'the board column'],
  ['daily-rate-hierarchy.js', 'the daily rate hierarchy'],
  ['delaware-rate-tiers.js', 'the Delaware recalc'],
  ['daily-rate-modal-sync.js', 'the Load Details sync'],
]) {
  check(`${label} bails on notReady`, /breakdown\.notReady/.test(read(file)), true);
}
for (const [file, label] of [
  ['loadboard.js', 'the board column'],
  ['daily-rate-hierarchy.js', 'the daily rate hierarchy'],
]) {
  check(`${label} goes through the limiter`, /allowRateWrite\(/.test(read(file)), true);
}
// The limiter has to stay a leaf or it cannot be imported by both.
const LIMITER = read('rate-write-limiter.js');
check('the limiter imports nothing', /^\s*import\s/m.test(LIMITER), false);

console.log(failures ? `\n  ${failures} check(s) FAILED\n` : '\n  All checks passed.\n');
process.exit(failures ? 1 : 0);
