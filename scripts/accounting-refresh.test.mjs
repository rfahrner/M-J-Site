/*
 * The Accounting sheet's Refresh button.
 *
 * It is a READ, and that is the property worth protecting. The owner chose
 * this over a version that also re-pushes from the load board: a re-push can
 * overwrite a figure an accountant typed, and a "Push to Accounting" button
 * was built and deliberately removed once already. So this test asserts the
 * absence of writes as hard as it asserts the presence of reads -- if someone
 * later "improves" Refresh into a sync, these checks are what fail.
 *
 * The rest is about staleness that is easy to miss, because the page looks
 * perfectly normal in every one of these states:
 *
 *   - accounting-columns.js and accounting-applied-and-aljex-status.js cache
 *     per id and only fetch ids they have not seen. Right for scrolling,
 *     wrong for a refresh: a Trip ID edited on the board keeps showing the
 *     value from page load. Both must be emptied.
 *   - the realtime channel can be dead after a laptop sleeps, and a second
 *     subscribe without removing the first double-handles every row.
 *   - "Load Earlier Records" moves state.minDate. Refreshing a fixed 60-day
 *     window would silently throw away the older rows the user asked for.
 *
 * Those three modules are told through a DOM event, not an import, because
 * they already import from accounting.js and the reverse edge closes a cycle
 * that has broken startup before.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (n) => readFileSync(join(root, n), 'utf8');
const ACCT = read('accounting.js');
const COLS = read('accounting-columns.js');
const ALJEX = read('accounting-applied-and-aljex-status.js');
const HTML = read('accounting.html');

let failures = 0;
function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) { console.log(`       expected: ${expected}\n       actual:   ${actual}`); failures++; }
}

function bodyOf(src, name) {
  const start = src.indexOf(`async function ${name}(`);
  if (start < 0) return '';
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  return '';
}
const refresh = bodyOf(ACCT, 'refreshAccountingSheet');

console.log('\n1. the button is on the page and wired');
check('accounting.html has it', /id="btn-acct-refresh"/.test(HTML), true);
check('it sits in the toolbar beside the FSC controls',
  HTML.indexOf('btn-acct-refresh') > HTML.indexOf('btn-save-fsc'), true);
check('there is somewhere to show when it last ran', /id="acct-refreshed-at"/.test(HTML), true);
check('the click is wired', /on\("btn-acct-refresh", "click"/.test(ACCT), true);
check('the function exists', refresh.length > 0, true);

console.log('\n2. it re-reads everything the page shows');
for (const [what, re] of [
  ['the accounting rows', /loadAccountingRecordsForRange\(/],
  ['pricing and the FSC rate', /loadPricingData\(\)/],
  ['location notes', /loadLocationNotes\(\)/],
  ['and redraws', /renderAccountingTable\(\)/],
]) check(what, re.test(refresh), true);
check('it tells the other modules to drop their caches',
  /dispatchEvent\(new CustomEvent\("accounting:refresh"\)\)/.test(refresh), true);
check('before the re-read, not after',
  refresh.indexOf('accounting:refresh') < refresh.indexOf('loadAccountingRecordsForRange('), true);

console.log('\n3. it is a read — it must never write');
for (const [what, re] of [
  ['no insert', /\.insert\(/],
  ['no update', /\.update\(/],
  ['no upsert', /\.upsert\(/],
  ['no delete', /\.delete\(/],
  ['no rpc', /\.rpc\(/],
  ['no board re-push', /push_shift_to_accounting|pushToAccounting|maybeSendToAccounting/],
  ['no recalculation of stored figures', /recalcAccountingRecord|saveAccountingFields/],
]) check(what, re.test(refresh), false);

console.log('\n4. it keeps the window the user is actually looking at');
check('it refreshes from state.minDate, not a fresh 60-day window',
  /loadAccountingRecordsForRange\(state\.minDate, state\.maxDate, true\)/.test(refresh), true);
check('it does not reassign state.minDate', /state\.minDate\s*=/.test(refresh), false);
check('it does not reload the page', /location\.reload|location\.href/.test(refresh), false);
check('someone mid-edit in the FSC box keeps what they typed',
  /document\.activeElement !== \$\("#fsc-rate-input"\)/.test(refresh), true);

console.log('\n5. it cannot be double-fired, and it always releases the button');
check('a second click while running is ignored', /if \(accountingRefreshInFlight/.test(refresh), true);
check('the button is disabled while it runs', /btn\.disabled = true/.test(refresh), true);
check('and re-enabled in a finally', /finally \{[\s\S]*btn\.disabled = false/.test(refresh), true);
check('a failure says nothing was changed', /Nothing was changed/.test(refresh), true);

console.log('\n6. the realtime channel is replaced, not stacked');
check('it resubscribes', /setupAccountingRealtimeSync\(\)/.test(refresh), true);
const sync = ACCT.slice(ACCT.indexOf('export function setupAccountingRealtimeSync'));
check('the old channel is removed first', /removeChannel\(accountingRealtimeChannel\)/.test(sync), true);
check('the removal happens before the new subscribe',
  sync.indexOf('removeChannel') < sync.indexOf('supabaseClient.channel("accounting")'), true);
check('and the handle is kept for next time', /accountingRealtimeChannel = channel/.test(sync), true);

console.log('\n7. the per-id caches in the other modules are emptied');
check('accounting-columns.js listens',
  /addEventListener\('accounting:refresh'/.test(COLS), true);
const colsHandler = /addEventListener\('accounting:refresh', \(\) => \{([\s\S]*?)\}\);/.exec(COLS)?.[1] || '';
check('it clears the Trip ID cache', /atlantaRoutesByAccountingId\.clear\(\)/.test(colsHandler), true);
check('it clears the completion-pill cache', /invalidateLiveStatus\(\)/.test(colsHandler), true);
check('and re-applies', /scheduleApply\(\)/.test(colsHandler), true);
check('the Aljex status module listens too',
  /addEventListener\('accounting:refresh', invalidateShiftStatus\)/.test(ALJEX), true);

console.log('\n8. those caches really are fetch-only-what-is-missing');
// If either of these stops being true the clears above become pointless, and
// this test should be the thing that notices.
check('accounting-columns.js skips ids it already has',
  /filter\(\(id\) => Number\.isFinite\(id\) && !atlantaRoutesByAccountingId\.has\(id\)\)/.test(COLS), true);
check('and skips shifts it already has unless forced',
  /force \? shiftIds : shiftIds\.filter\(\(id\) => !liveShiftsById\.has\(id\)\)/.test(COLS), true);
check('invalidateLiveStatus forces the next fetch',
  /fetchLiveCompletionStatus\(true\)/.test(COLS), true);

console.log('\n9. no import cycle was introduced');
check('accounting.js still does not import accounting-columns.js',
  /from '\.\/accounting-columns\.js'/.test(ACCT), false);
check('nor the Aljex status module',
  /from '\.\/accounting-applied-and-aljex-status\.js'/.test(ACCT), false);

console.log(failures ? `\n${failures} failing check(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
