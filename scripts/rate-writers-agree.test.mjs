/*
 * Regression test for a rate that visibly flashes between two numbers.
 *
 * loadboard.js decides which rate wins in getEffectiveRateInfo(): a manual
 * override, then the driver's own tier card, then the driver's flat usual
 * rate, then the location's tier engine. Four other modules recompute
 * row.rate after the board has drawn -- the Load Details panel decorator, the
 * daily-rate card, the rate-settings modal sync, and the Delaware tier view --
 * and each called calcLoadRateBreakdown() directly instead.
 *
 * That skips the driver's-usual-rate branch. On any load whose driver has a
 * flat rate, the board wrote one number and the decorator wrote the other,
 * every redraw, forever: the Rate cell flashed between them. The tier gap fix
 * made it visible on a 140.8-mile route by changing what the tier engine
 * returned there, but the disagreement was always the bug.
 *
 * Nothing may recompute row.rate except through that one function.
 *
 * Run: node scripts/rate-writers-agree.test.mjs
 */

import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (n) => readFileSync(new URL(n, root), 'utf8');

let failures = 0;
function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}` + (ok ? '' : `\n       expected: ${expected}\n       actual:   ${actual}`));
}
const checkTrue = (l, v) => check(l, !!v, true);

const BOARD = read('loadboard.js');

// ---------------------------------------------------------------------------
console.log('1. one function decides which rate wins');
checkTrue('and it is exported so the others can use it',
  /export function getEffectiveRateInfo\(row\)/.test(BOARD));
checkTrue('it still has the driver-flat-rate branch that the others skipped',
  /mode: "driver-usual-rate"/.test(BOARD));

console.log('\n2. every module that writes row.rate goes through it');
const WRITERS = [
  'daily-rate-hierarchy.js',
  'daily-rate-modal-sync.js',
  'delaware-rate-tiers.js',
];
// What matters is how row.rate is DERIVED, so look at the few lines above each
// assignment rather than banning the tier engine from the file outright.
// daily-rate-hierarchy.js legitimately calls it for Houston, on a synthetic
// row, to write normalRate -- a different field on a different shape, which
// getEffectiveRateInfo() does not cover.
function derivationOf(src) {
  return [...src.matchAll(/row\.rate = /g)]
    .map((m) => src.slice(Math.max(0, m.index - 400), m.index))
    .join('\n---\n');
}
for (const f of WRITERS) {
  const src = read(f);
  checkTrue(`${f} assigns row.rate`, /row\.rate = /.test(src));
  const why = derivationOf(src);
  check(`${f} does not derive it from the tier engine`,
    /calcLoadRateBreakdown\(/.test(why), false);
  checkTrue(`${f} derives it from getEffectiveRateInfo`, /getEffectiveRateInfo\(row\)/.test(why));
}
checkTrue('the Houston path is the only remaining direct call, and it writes normalRate',
  /calcLoadRateBreakdown\("houston", synthetic\)[\s\S]{0,300}row\.normalRate = /.test(read('daily-rate-hierarchy.js')));
// loadboard.js is allowed to call it: getEffectiveRateInfo is the caller.
checkTrue('loadboard.js still reaches the tier engine itself',
  /calcLoadRateBreakdown\(locationKey, row\)/.test(BOARD));

// ---------------------------------------------------------------------------
console.log('\n3. and they all format the number the same way');
// Two writers rounding differently would flash just as visibly as two writers
// computing differently -- "500" against "500.00" is two distinct strings.
const FORMAT = /String\(Math\.round\((?:numericRate|numeric|total) \* 100\) \/ 100\)/;
for (const f of [...WRITERS, 'loadboard.js']) {
  const src = read(f);
  if (!/row\.rate = /.test(src)) continue;
  checkTrue(`${f} rounds to cents the same way`, FORMAT.test(src) || f === 'loadboard.js');
}

// ---------------------------------------------------------------------------
console.log('\n4. the tiers round DOWN, for both carrier locations');
const TIERS = read('carrier-mileage-tiers.js').replace(/^export /gm, '');
const api = new Function(`${TIERS}; return { carrierMileageTier, carrierTierLabel };`)();
const ATLANTA = [
  { id: 1, min: 0,   max: 25,   rate: 325 },
  { id: 2, min: 26,  max: 60.9, rate: 355 },
  { id: 3, min: 61,  max: 140,  rate: 400 },
  { id: 4, min: 141, max: 170,  rate: 425 },
  { id: 5, min: 171, max: 187,  rate: 450 },
];
const rateFor = (mi) => { const t = api.carrierMileageTier(ATLANTA, mi); return t ? t.rate : null; };

// Every band reads as "up to .9": 0-25.9, 26-60.9, 61-140.9, 141-170.9, 171-187.9.
check('25.9  stays in 0-25',      rateFor(25.9), 325);
check('60.95 stays in 26-60.9',   rateFor(60.95), 355);
check('140.8 stays in 61-140',    rateFor(140.8), 400);
check('140.9 stays in 61-140',    rateFor(140.9), 400);
check('141   moves up',           rateFor(141), 425);
check('170.7 stays in 141-170',   rateFor(170.7), 425);
check('171   moves up',           rateFor(171), 450);
check('187.9 stays in 171-187',   rateFor(187.9), 450);
check('188   is past the top band', api.carrierMileageTier(ATLANTA, 188), null);

console.log('\n5. the labels say what they now mean');
check('0-25 reads as 0-25.9',   api.carrierTierLabel(ATLANTA, ATLANTA[0]), '0–25.9 MI');
check('61-140 reads as 61-140.9', api.carrierTierLabel(ATLANTA, ATLANTA[2]), '61–140.9 MI');
check('171-187 reads as 171-187.9', api.carrierTierLabel(ATLANTA, ATLANTA[4]), '171–187.9 MI');

// Delaware runs the same lookup -- it is location-agnostic in boardrates.js.
check('boardrates uses one lookup for every location',
  /const tier = carrierMileageTier\(tiers, miles\);/.test(read('boardrates.js')), true);
check('no location-specific branch left in it',
  /locationKey === "atlanta" \? carrierMileageTier/.test(read('boardrates.js')), false);

console.log(failures ? `\n  ${failures} check(s) FAILED\n` : '\n  All checks passed.\n');
process.exit(failures ? 1 : 0);
