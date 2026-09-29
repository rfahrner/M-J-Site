/*
 * A deleted load keeps its money visible and stops counting.
 *
 * loads_accounting.source_shift_id is ON DELETE SET NULL, so deleting a shift
 * always left the billing row behind -- but silently: indistinguishable from a
 * live load, still in every total, with nothing pointing back at what it came
 * from. status = 'deleted' turns that accident into a state you can see.
 *
 * The three halves have to agree, which is what this pins:
 *   - the board marks the Accounting row BEFORE deleting the shift, because
 *     source_shift_id is the only link and it is gone a moment later;
 *   - the sheet draws it struck through AND faded, with a Restore control;
 *   - Location Analytics leaves it out of the totals until it is restored.
 *
 * It is deliberately not 'cancelled'. A cancellation is an operational fact and
 * carries no money by design; a deletion is record-keeping with money still
 * attached. Collapsing them would lose the difference where it matters most.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const LB = readFileSync(join(root, 'loadboard.js'), 'utf8');
const ACCT = readFileSync(join(root, 'accounting.js'), 'utf8');
const LA = readFileSync(join(root, 'location-analytics.js'), 'utf8');

let failures = 0;
function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) console.log(`       expected: ${expected}\n       actual:   ${actual}`);
}

console.log('\n1. the board marks Accounting before the link disappears');
const BULK = /async function deleteSelectedRows\(\)[\s\S]*?\n  \}/.exec(LB)[0];
const SINGLE = /async function deleteRow\(rowId\)[\s\S]*?\n  \}/.exec(LB)[0];
for (const [name, fn, key] of [['bulk', BULK, '.in("source_shift_id", dbIds)'],
                               ['single', SINGLE, '.eq("source_shift_id", row.dbId)']]) {
  check(`${name}: it sets status deleted`, /status: "deleted"/.test(fn), true);
  check(`${name}: and stamps deleted_at`, /deleted_at: new Date\(\)\.toISOString\(\)/.test(fn), true);
  check(`${name}: keyed on the shift link`, fn.includes(key), true);
  // Order is the whole point: after the shift goes, source_shift_id is null.
  check(`${name}: marks BEFORE deleting the shift`,
    fn.indexOf('status: "deleted"') < fn.indexOf(`from(SHIFTS_TABLE).delete()`), true);
}
// The money is not zeroed. Restore has to give back the real figures.
check('no figure is cleared on the way out',
  /total_revenue:\s*(0|null)|total_carrier_pay:\s*(0|null)/.test(BULK + SINGLE), false);

console.log('\n2. the sheet shows it as gone, without hiding it');
check('deleted is its own state', /const isDeleted = rec\.status === "deleted"/.test(ACCT), true);
check('faded like a released row', /if \(isDimmed \|\| isDeleted\) styleBits\.push\("opacity:0\.5;"\)/.test(ACCT), true);
check('and struck through like a cancellation',
  /if \(isCancelled \|\| isDeleted\) styleBits\.push\("text-decoration:line-through/.test(ACCT), true);
check('it says why, and that Analytics excludes it',
  /Deleted from the board — not in Analytics/.test(ACCT), true);

console.log('\n3. it can be put back from the sheet');
check('a Restore control is drawn', /data-action="acct-restore-deleted"/.test(ACCT), true);
check('and it is wired up', /restoreDeletedAccountingRecord\(restoreBtn\.dataset\.id\)/.test(ACCT), true);
const RESTORE = /async function restoreDeletedAccountingRecord[\s\S]*?\n  \}/.exec(ACCT)[0];
check('restore only acts on a deleted row', /rec\.status !== "deleted"/.test(RESTORE), true);
check('it returns the row to active and clears the stamp',
  /\{ status: "active", deleted_at: null \}/.test(RESTORE), true);
check('through the checked write path, not a bare builder',
  /await saveAccountingFields\(supabaseClient, rec\.id,/.test(RESTORE), true);
check('and it is honest that the load does not come back',
  /load itself stays deleted from the board/.test(RESTORE), true);

console.log('\n4. Analytics leaves it out until then');
check('the fetch excludes deleted rows', /\.neq\('status', 'deleted'\)/.test(LA), true);
// Filtering at the query means revenue, cost, margin, GM% and every per-unit
// ratio drop it together -- one place, not six.
const FETCH = /const accountingRows = await fetchAllRows\([\s\S]*?\n  \);/.exec(LA)[0];
check('at the query, so every derived figure agrees', /neq\('status', 'deleted'\)/.test(FETCH), true);
check('the date range is still applied',
  /gte\('shift_date', startDate\)\.lte\('shift_date', endDate\)/.test(FETCH), true);

console.log(failures ? `\n  ${failures} check(s) FAILED\n` : '\n  All checks passed.\n');
process.exit(failures ? 1 : 0);
