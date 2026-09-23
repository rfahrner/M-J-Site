/*
 * Regression test: Accounting is pushed to, not listened at.
 *
 * Two database triggers used to reach into loads_accounting whenever the board
 * changed -- one on every carrier_rate change, one on every trip edit. So a
 * rate an accountant typed survived only until the board next recalculated
 * that shift, which it does constantly, and the figure changed under them with
 * nothing said. That is the same shape as the rate flicker: everything
 * listening to everything, instead of a change being sent where it belongs.
 *
 * The propagation is automatic again -- a change on the board IS the push, and
 * nobody presses anything -- but it goes through push_shift_to_accounting(),
 * which records what it replaced. The overwrite was never the problem; doing it
 * silently was. A sticky beside the driver name says a figure changed, and it
 * appears ONLY when a number Accounting actually had was replaced by a
 * different one, so it stays worth looking at.
 *
 * Run: node scripts/accounting-push-model.test.mjs
 */

import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (n) => readFileSync(new URL(n, root), 'utf8');
const BOARD = read('loadboard.js');
const ACCT = read('accounting.js');
const CSS = read('loadboard.css');
const ANALYTICS = read('location-analytics.js');

let failures = 0;
function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) { console.log(`       expected: ${JSON.stringify(expected)}\n       actual:   ${JSON.stringify(actual)}`); failures++; }
}

const pages = ['index.html', 'dalaware.html', 'buildingc.html', 'houston.html', 'accounting.html', 'driverlist.html'];

// ---------------------------------------------------------------------------
console.log('\n1. nothing on the board asks a person to push');
check('no Push to Accounting button anywhere',
  pages.filter((p) => read(p).includes('ld-push-accounting')).length, 0);
check('and no handler left behind', /pushOpenLoadToAccounting/.test(BOARD), false);

console.log('\n2. the board still owns the operational figures');
// recomputeRowRate keeps saving carrier_rate; the database trigger is what
// carries it on to Accounting. Nothing here should have changed that.
const RECOMPUTE = /function recomputeRowRate\(row, forceSave\)[\s\S]*?\n  \}/.exec(BOARD)[0];
check('the board still saves the rate', /scheduleShiftSave\(row\)/.test(RECOMPUTE), true);
check('still gated on the rate tables being loaded', /breakdown\.notReady/.test(RECOMPUTE), true);
check('and still behind the write limiter', /allowRateWrite\(/.test(RECOMPUTE), true);

// ---------------------------------------------------------------------------
console.log('\n3. an overwrite is never silent');
check('the sheet draws a sticky from push_note', /function acctPushStickyHtml/.test(ACCT), true);
const STICKY = /function acctPushStickyHtml[\s\S]*?\n\}/.exec(ACCT)[0];
check('nothing is drawn when there is no note', /if \(!rec\.push_note\) return "";/.test(STICKY), true);
check('the note is the tooltip', /title="\$\{escapeHtml\(title\)\}"/.test(STICKY), true);
check('it sits next to the driver name',
  /rec\.driver_name_text \|\| "—"\)\}\$\{acctPushStickyHtml\(rec\)\}/.test(ACCT), true);
check('clicking it clears the note', /data-acct-dismiss-push/.test(ACCT), true);
const DISMISS = /async function dismissAccountingPushNote[\s\S]*?\n\}/.exec(ACCT)[0];
// Only the flag is cleared. The figure the push wrote stays.
check('dismissing clears only the note', /\{ push_note: null \}/.test(DISMISS), true);
check('through the checked save path', /await saveAccountingFields/.test(DISMISS), true);
check('the sticky is styled yellow', /\.acct-push-sticky[\s\S]{0,400}--butter-yellow/.test(CSS), true);
// New CSS: a browser holding the old stylesheet would show no sticky at all.
const tokens = new Set(pages.map((p) => /loadboard\.css\?v=([^"']+)/.exec(read(p))?.[1]));
check('the stylesheet token moved with it', tokens.size, 1);
check('and is not the previous one', tokens.has('20260923-rate-column'), false);

// ---------------------------------------------------------------------------
console.log('\n4. REV/DRIVER counts drivers the way the business does');
const COUNT = /function countDrivers[\s\S]*?\n\}/.exec(ANALYTICS)[0];
const countDrivers = new Function(`${COUNT}; return countDrivers;`)();
const shift = (o) => ({ driver_id: null, driver_name_text: '', load_cancelled: false, called_off: false, ...o });

check('a driver with several shifts counts once',
  countDrivers([shift({ driver_id: 7 }), shift({ driver_id: 7 }), shift({ driver_id: 9 })]), 2);
// He was there. Whether the load earned anything is a different question.
check('a TONU still counts', countDrivers([shift({ driver_id: 7, tonu: true })]), 1);
check('a cancelled load does not', countDrivers([shift({ driver_id: 7, load_cancelled: true })]), 0);
check('nor does a call-off', countDrivers([shift({ driver_id: 7, called_off: true })]), 0);
check('but one cancelled shift does not erase a driver who also worked',
  countDrivers([shift({ driver_id: 7, load_cancelled: true }), shift({ driver_id: 7 })]), 1);
// Five real Atlanta drivers in one week were typed by name rather than picked.
check('a driver typed by name counts',
  countDrivers([shift({ driver_name_text: 'Rodney Reid- Reids Trans - c' })]), 1);
check('spelling noise does not split one person',
  countDrivers([shift({ driver_name_text: 'Ronald  Grey-C' }), shift({ driver_name_text: 'ronald grey-c' })]), 1);
// 19 rows that week had neither an id nor a name: empty board rows.
check('an empty row is not a driver', countDrivers([shift({}), shift({})]), 0);
check('and the id wins when a row has both',
  countDrivers([shift({ driver_id: 7, driver_name_text: 'Someone' }), shift({ driver_id: 7 })]), 1);

console.log(failures ? `\n  ${failures} check(s) FAILED\n` : '\n  All checks passed.\n');
process.exit(failures ? 1 : 0);
