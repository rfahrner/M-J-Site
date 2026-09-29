/*
 * The customer rate is a figure someone sets, not a figure the site derives.
 *
 * In the accounting workbook, "Current Kroger Rate" holds 10,882 numbers and
 * only 313 of them carry a formula -- and even those come in two unrelated
 * shapes: the mileage bands plus fuel, or carrier cost grossed up to a margin
 * ("Revenue Market", column AN: IF($U=4, cost/0.85, 0)). Across the loads that
 * do carry both a rate and a cost there are 906 distinct cost-to-rate ratios.
 * There is no single formula to copy, so the site stores the number instead.
 *
 * Two database functions used to rebuild total_revenue from the mileage table --
 * sync_standard_accounting_routes_for_shift() on every rate push, and
 * refresh_atlanta_accounting_route_v2() on every change to a route's miles or
 * stops. Both now skip the money when revenue_manual is set. This file pins the
 * browser half: the page has to SET that flag, or the guard never engages.
 *
 * The rule it protects, in the user's words: a change to a rate, a driver rate
 * or the FSC rate applies going forward and does not apply to the past.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ACCT = readFileSync(join(root, 'accounting.js'), 'utf8');

let failures = 0;
function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) console.log(`       expected: ${expected}\n       actual:   ${actual}`);
}

console.log('\n1. typing a customer rate marks it as set');
const FIELDS = /const ACCOUNTING_MONEY_FIELDS = \{[\s\S]*?\};/.exec(ACCT)[0];
check('the customer rate cell declares what it freezes',
  /"acct-customer-rate":[^}]*freezes:\s*"revenue_manual"/.test(FIELDS), true);
check('carrier pay does not -- the board owns that figure',
  /"acct-carrier-pay":[^}]*freezes/.test(FIELDS), false);

const SAVE = /async function saveAccountingMoneyField[\s\S]*?\n\}/.exec(ACCT)[0];
check('the save carries the flag alongside the figure',
  /patch\[field\.freezes\]\s*=/.test(SAVE), true);
check('and it still goes through the checked write path',
  /await saveAccountingFields\(supabaseClient, rec\.id, patch\)/.test(SAVE), true);

// A cleared cell must clear the flag too. Freezing a blank would strand the
// load at no revenue for good -- the one state nothing could ever recompute
// its way out of.
check('clearing the cell releases it back to being calculated',
  /value !== null && value !== undefined/.test(SAVE), true);

console.log('\n2. Market is a level the page can actually choose');
check('level 4 is offered', /\[4, "4 — Market"\]/.test(ACCT), true);
// Level 3 stays out: pricing_settings marks it unconfigured, and calcRoute()
// bills zero linehaul for a level with no tiers.
const LEVELS = /const REVENUE_LEVELS = \[[\s\S]*?\];/.exec(ACCT)[0];
check('level 3 is still not offered', /\[3,/.test(LEVELS), false);

console.log('\n3. recalculating cost never re-prices the customer');
const RECALC = /export async function recalcAccountingRecord[\s\S]*?\n  \}/.exec(ACCT)[0];
check('it checks whether a rate was already set',
  /revenue_manual === true/.test(RECALC), true);
check('and leaves total_revenue out of the write when it was',
  /if \(!revenueIsSet\) acctPatch\.total_revenue/.test(RECALC), true);
check('Market prices off cost, not off miles',
  /revenue_level\) === 4/.test(RECALC) && /market_revenue_divisor/.test(RECALC), true);

// The function's own parameter is called `patch`; a second `const patch` in the
// same scope is a SyntaxError, and the page would not load at all.
check('the local patch does not shadow the parameter',
  /const acctPatch = \{/.test(RECALC) && !/\n\s*const patch = \{/.test(RECALC), true);

console.log(failures ? `\n  ${failures} check(s) FAILED\n` : '\n  All checks passed.\n');
process.exit(failures ? 1 : 0);
