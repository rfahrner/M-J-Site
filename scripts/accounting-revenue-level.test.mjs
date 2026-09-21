/*
 * Regression test for the Accounting Revenue Level dropdown.
 *
 * Surfaced by two loads billing $188 and $488 under Aljex. The database trigger
 * prices every auto-sent load from the revenue_1 tier table, hardcoded, but
 * stamped the record revenue_level = 99 -- a value matching no pricing table.
 *
 * The stamp being wrong was not cosmetic. calcRoute() looks up
 * tiers['revenue_' + level]; for 99 it found nothing, fell through to a
 * per-mile rate that also did not exist, and settled on ZERO linehaul revenue.
 * Recalculating such a record -- which happens the instant anyone touches the
 * Cost Level dropdown on that row -- would have dropped an 84.9-mile route from
 * $465 to $100 of stop charges, silently.
 *
 * Run: npm i --no-save jsdom && node scripts/accounting-revenue-level.test.mjs
 */

import { readFileSync } from 'node:fs';

const CALC = readFileSync(new URL('../accountingcalc.js', import.meta.url), 'utf8');
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
  // Start the brace count AFTER the parameter list. calcRoute destructures its
  // argument -- calcRoute({ costLevel, ... }) -- so counting from the first `{`
  // matches the parameter's own brace and extracts nothing but the signature.
  let p = src.indexOf('(', src.indexOf(`function ${name}(`)), parens = 0, j = p;
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

// The real pricing data, as it stands in the live project.
const tiers = {
  revenue_1: [
    { min: 0, max: 0.99, rate: 0 }, { min: 1, max: 25, rate: 281 },
    { min: 25.01, max: 60, rate: 309 }, { min: 60.01, max: 90, rate: 365 },
    { min: 90.01, max: 100, rate: 365 },
  ],
  revenue_2: [
    { min: 0, max: 0.99, rate: 0 }, { min: 1, max: 25, rate: 294 },
    { min: 25.01, max: 60, rate: 412 }, { min: 60.01, max: 90, rate: 459 },
    { min: 90.01, max: 100, rate: 459 },
  ],
  cost_1: [{ min: 60.01, max: 90, rate: 400 }, { min: 90.01, max: 100, rate: 400 }],
};
const settings = {
  revenue_1_per_mile: 2.40, revenue_2_per_mile: 2.80, revenue_3_per_mile: 0,
  cost_1_per_mile: 2.4, market_revenue_divisor: 0.85,
  stop_charge_free_stops: 2, stop_charge_per_stop: 20, stop_charge_revenue_per_stop: 50,
  fsc_rate: 6.158, fsc_multiplier: 0.133,
};

const ctx = {};
new Function('ctx', `
  ${extractFunction(CALC, 'tierLookup')}
  ${extractFunction(CALC, 'calcRoute')}
  ${extractFunction(CALC, 'calcFscPayment')}
  ctx.calcRoute = calcRoute; ctx.calcFscPayment = calcFscPayment;
`)(ctx);

const revenueOf = (level, miles, stops) =>
  ctx.calcRoute({ costLevel: 1, revenueLevel: level, miles, stops, contractRate: 0 }, tiers, settings).totalRevenue;

// ---------------------------------------------------------------------------
console.log('\n1. an unconfigured level bills the default, never nothing');

check('level 1 prices normally', revenueOf(1, 84.9, 2), 465);
check('level 2 prices at the holiday table', revenueOf(2, 84.9, 2), 559);
// These two are the bug. Both used to return 100 -- stop charges only.
check('level 99 falls back to level 1 rather than zeroing', revenueOf(99, 84.9, 2), 465);
check('level 3, which has no tiers configured, also falls back', revenueOf(3, 84.9, 2), 465);
check('a nonsense level cannot empty a customer rate', revenueOf(undefined, 84.9, 2), 465);
// Market is a genuinely different formula and must not be caught by the guard.
check('level 4 still uses the contract-rate divisor',
  ctx.calcRoute({ costLevel: 1, revenueLevel: 4, miles: 84.9, stops: 2, contractRate: 850 }, tiers, settings).revenue,
  1000);

// ---------------------------------------------------------------------------
console.log('\n2. the two reported loads reconcile with Aljex at level 2');

// Aljex: 1985434 = 1215.91, 1986778 = 2787.08
const load = (routes, level) => {
  const base = routes.reduce((sum, [miles, stops]) => sum + revenueOf(level, miles, stops), 0);
  const fsc = ctx.calcFscPayment(settings.fsc_rate, routes.reduce((m, [miles]) => m + miles, 0), settings);
  return Math.round((base + fsc) * 100) / 100;
};
const CHARLES = [[84.9, 2], [95.7, 1]];
const PIERRE = [[77.6, 2], [41.1, 1], [93.8, 1], [95.7, 1], [41.1, 1]];

check('Charles Osborne at level 1 is what the site showed', load(CHARLES, 1), 1027.91);
check('Charles Osborne at level 2 matches Aljex', load(CHARLES, 2), 1215.91);
check('Pierre Paul at level 1 is what the site showed', load(PIERRE, 1), 2299.08);
check('Pierre Paul at level 2 matches Aljex', load(PIERRE, 2), 2787.08);
// What the recalculation would have done before the guard: stop charges only.
check('the difference is exactly what was reported',
  Math.round((load(CHARLES, 2) - load(CHARLES, 1)) * 100) / 100, 188);
check('and for the second load', Math.round((load(PIERRE, 2) - load(PIERRE, 1)) * 100) / 100, 488);

// ---------------------------------------------------------------------------
console.log('\n3. the dropdown says what it means and offers only real levels');

checkTrue('revenue levels are named', /1 — Kroger Core/.test(ACCOUNTING) && /2 — KR Holiday/.test(ACCOUNTING));
checkTrue('cost levels are named', /1 — Carrier Core/.test(ACCOUNTING));
check('level 3 is not offered as a revenue option',
  /REVENUE_LEVELS = \[\[1[^\]]*\], \[2[^\]]*\], \[4[^\]]*\]\]/.test(ACCOUNTING), true);
checkTrue('a record defaults to level 1 when it has none', /rec\.revenue_level \?\? 1/.test(ACCOUNTING));
check('the old bare numeric options are gone', /\[1, 2, 3, 4\]\.map/.test(ACCOUNTING), false);

// An unrecognised stored level must still round-trip rather than being
// silently re-billed as level 1 just because the row rendered.
const sel = {};
new Function('ctx', `
  const escapeHtml = (v) => String(v);
  ${ACCOUNTING.match(/const levelSelect = [\s\S]*?\n    \};/)[0]}
  ctx.levelSelect = levelSelect;
`)(sel);
const REV = [[1, '1 — Kroger Core'], [2, '2 — KR Holiday'], [4, '4 — Market']];
checkTrue('a known level is preselected', sel.levelSelect(REV, 2).includes('value="2" selected'));
checkTrue('an unknown stored level is preserved and marked',
  sel.levelSelect(REV, 99).includes('value="99" selected') && sel.levelSelect(REV, 99).includes('not configured'));
check('a known level does not add a stray option',
  (sel.levelSelect(REV, 1).match(/<option/g) || []).length, 3);

console.log(failures ? `\n  ${failures} check(s) FAILED\n` : '\n  All checks passed.\n');
process.exit(failures ? 1 : 0);
