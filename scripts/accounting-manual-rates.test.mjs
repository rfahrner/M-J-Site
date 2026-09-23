/*
 * Regression test: a rate typed on the Accounting sheet actually saves.
 *
 * The three editable cells on that page saved like this:
 *
 *   supabaseClient.from(ACCOUNTING_TABLE).update({...}).eq("id", rec.id)
 *     .catch((err) => setDriverSyncStatus(...))
 *
 * A PostgREST query builder is a thenable, not a Promise: it has `then` and
 * NO `catch`. That line threw "catch is not a function" inside a bare
 * setTimeout -- and since nothing ever awaited the builder, the request was
 * never sent at all. The number sat on screen looking saved, the database
 * never heard about it, and the next page load showed the old figure. Silent,
 * because the throw had no handler.
 *
 * scripts/accounting-save.test.mjs already asserted `.catch` is undefined on a
 * real builder. That is the whole reason saveAccountingFields() exists; these
 * three cells just never got moved onto it.
 *
 * Run: npm i --no-save @supabase/supabase-js && node scripts/accounting-manual-rates.test.mjs
 */

import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const root = new URL('../', import.meta.url);
const read = (n) => readFileSync(new URL(n, root), 'utf8');
const ACCT = read('accounting.js');

let failures = 0;
function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) { console.log(`       expected: ${JSON.stringify(expected)}\n       actual:   ${JSON.stringify(actual)}`); failures++; }
}

// ---------------------------------------------------------------------------
console.log('\n1. the shape of the bug cannot come back');
// A builder really has no catch -- this is the fact the old code got wrong.
const probe = createClient('https://example.supabase.co', 'test-key',
  { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
check('a PostgREST builder has no .catch',
  typeof probe.from('loads_accounting').update({ a: 1 }).eq('id', 1).catch, 'undefined');

// Nothing in accounting.js may call .catch straight off a builder again.
// Comments stripped first: the note explaining this bug quotes the very line
// it is warning about.
const CODE = ACCT.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
const danger = [...CODE.matchAll(/from\([^)]*\)[\s\S]{0,200}?\.catch\(/g)];
check('no builder is given a .catch', danger.length, 0);

console.log('\n2. every editable cell saves through the checked path');
check('carrier pay is mapped', /"acct-carrier-pay": \{ column: "total_carrier_pay"/.test(ACCT), true);
check('customer rate is mapped', /"acct-customer-rate": \{ column: "total_revenue"/.test(ACCT), true);
check('and the day type too', /saveAccountingMoneyField\(rec, \{ column: "day_type"/.test(ACCT), true);
const SAVE_FN = /async function saveAccountingMoneyField[\s\S]*?\n\}/.exec(ACCT)[0];
check('it awaits saveAccountingFields', /await saveAccountingFields\(supabaseClient, rec\.id/.test(SAVE_FN), true);
check('and reports a failure rather than swallowing it',
  /setDriverSyncStatus\(`Couldn't save \$\{field\.label\}/.test(SAVE_FN), true);

// ---------------------------------------------------------------------------
console.log('\n3. a half-typed figure never blanks a real one');
// Number("1,250.00") is NaN and JSON.stringify turns NaN into null, which
// SUCCEEDS while erasing the column. Same trap numOrNull() exists for.
const NUM = /function numOrUndefined[\s\S]*?\n\}/.exec(ACCT)[0];
const numOrUndefined = new Function(`${NUM}; return numOrUndefined;`)();
check('an empty cell clears the column', numOrUndefined(''), null);
check('a plain number goes through', numOrUndefined('740'), 740);
check('a decimal goes through', numOrUndefined('455.01'), 455.01);
check('money as people type it', numOrUndefined('$1,250.00'), 1250);
check('a half-typed value is left alone, not written as null', numOrUndefined('1,2x'), undefined);
check('letters are left alone too', numOrUndefined('n/a'), undefined);
const INPUT = /table\.addEventListener\("input"[\s\S]*?\n      \}\);/.exec(ACCT)[0];
check('and the handler bails on undefined rather than saving it',
  /if \(val === undefined\) return;/.test(INPUT), true);

// ---------------------------------------------------------------------------
console.log('\n4. a rate changed in Load Details reaches the sheet');
// The database half already worked: trg_sync_accounting_carrier_from_shift_v2
// copies carrier_rate onto the accounting row. What was missing is that
// loads_accounting was never in the supabase_realtime publication, so the
// page's subscription -- written at the same time as the page -- had never
// fired once. Applied as publish_loads_accounting_to_realtime.
const SYNC = /export function setupAccountingRealtimeSync[\s\S]*?\n  \}/.exec(ACCT)[0];
check('the page subscribes to the accounting table',
  /table: "loads_accounting"/.test(SYNC), true);
check('and to its route rows', /table: ACCOUNTING_ROUTES_TABLE/.test(SYNC), true);
check('a route change re-reads that load\'s routes',
  /eq\("accounting_id", accountingId\)/.test(SYNC), true);
check('a deleted route is dropped rather than left behind',
  /delete acctRoutesByAccountingId\[accountingId\]/.test(SYNC), true);
check('both handlers repaint', (SYNC.match(/renderAccountingTable\(\)/g) || []).length, 2);

console.log(failures ? `\n  ${failures} check(s) FAILED\n` : '\n  All checks passed.\n');
process.exit(failures ? 1 : 0);
