/*
 * Delete Selected, and the things it must never do quietly.
 *
 * Deleting a shift is not one deletion. The foreign keys on loads_shifts mean
 * loads_trips, load_attachments and load_change_history all CASCADE, while
 * loads_accounting is ON DELETE SET NULL -- so a load that has already reached
 * Accounting leaves its billing row behind, still counted in the totals, with
 * nothing left pointing at the load it came from. That consequence is invisible
 * from the board, so the button has to say it out loud before it happens.
 *
 * CLAUDE.md's rule from the right-click incident applies here too: never ship an
 * unlabelled Delete. The confirmation names every load going.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const LB = readFileSync(join(root, 'loadboard.js'), 'utf8');
const FN = /async function deleteSelectedRows\(\)[\s\S]*?\n  \}/.exec(LB)?.[0] || '';

let failures = 0;
function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) console.log(`       expected: ${expected}\n       actual:   ${actual}`);
}

console.log('\n1. the button exists on the boards it can actually serve');
for (const page of ['index.html', 'buildingc.html', 'dalaware.html']) {
  const html = readFileSync(join(root, page), 'utf8');
  check(`${page} has it`, /id="btn-delete-selected"/.test(html), true);
  check(`${page} starts hidden`, /class="btn btn-danger hidden" id="btn-delete-selected"/.test(html), true);
  check(`${page} labels it, not a bare Delete`, /id="btn-delete-selected">Delete Selected</.test(html), true);
}
// Houston's loads live in loads_houston, a flat table with its own module.
// deleteSelectedRows reads the standard board cache and deletes from
// loads_shifts, so the button there would act on the wrong rows entirely.
check('houston.html does NOT have it',
  /id="btn-delete-selected"/.test(readFileSync(join(root, 'houston.html'), 'utf8')), false);

console.log('\n2. it is wired like the other bulk actions');
check('shown only while something is selected',
  /#btn-delete-selected"\)\.classList\.toggle\("hidden", !anySelected\)/.test(LB), true);
check('and it is bound to the handler',
  /#btn-delete-selected"\)\.addEventListener\("click", deleteSelectedRows\)/.test(LB), true);

console.log('\n3. nothing goes without being named first');
check('the handler exists', FN.length > 0, true);
check('it refuses an empty selection', /if \(!rows\.length\)/.test(FN), true);
check('every load is listed in the confirmation', /rows\.map\(\(r\) => `  • \$\{labelFor\(r\)\}`\)/.test(FN), true);
check('the route count is stated', /routeCount/.test(FN), true);
check('and that paperwork and history go too', /paperwork and change history/.test(FN), true);

console.log('\n4. a billed load gets its own warning');
check('Accounting is checked before deleting', /from\(ACCOUNTING_TABLE\)\.select\("source_shift_id"\)/.test(FN), true);
check('those loads are named separately', /billedRows\.map/.test(FN), true);
// The consequence changed once deleting started marking the row rather than
// orphaning it: it now stays visible and out of the totals, and can be undone.
check('what happens to the billing row is spelled out',
  /marked deleted/.test(FN) && /left out of the analytics totals/.test(FN), true);
check('and that it is recoverable, but the load is not',
  /can be restored from the Accounting sheet/.test(FN) && /load itself will not come back/.test(FN), true);
// If that check itself fails we must not silently assume "none are billed".
check('a failed check still asks rather than assuming',
  /Couldn't check whether any of these have reached Accounting/.test(FN), true);

console.log('\n5. the ordering that keeps the board honest');
check('debounced writes are cancelled first', /cancelPendingSaves\(row\.id/.test(FN), true);
check('the deletion is logged before the row goes', /logChange\(row\.dbId/.test(FN), true);
check('the database is asked before the board changes',
  FN.indexOf('.delete().in("id", chunk)') < FN.indexOf('sheet.splice(idx, 1)'), true);
check('only rows the server deleted leave the board', /if \(!deleted\.has\(row\.id\)\) continue;/.test(FN), true);
check('a long id list is chunked', /const CHUNK = 100;/.test(FN), true);
check('and a partial failure is reported, not swallowed', /couldn't be removed from the database/.test(FN), true);

console.log(failures ? `\n  ${failures} check(s) FAILED\n` : '\n  All checks passed.\n');
process.exit(failures ? 1 : 0);
