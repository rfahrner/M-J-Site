/*
 * Regression test for the alert widget's Text button.
 *
 * Reported as: clicking Text makes the alert go away but never opens the send
 * modal. The click handler re-ran scanForBoardAlerts() -- a full database scan
 * -- purely to recover the alert object the button had just been rendered from,
 * and returned SILENTLY when that scan came back without the key. Anything
 * changing in between turned the click into a no-op with nothing on screen to
 * explain it.
 *
 * Also covers a defect in the dismissal design itself: the pre-shift alert
 * groups every driver due at one shift time under a single key, and dismissing
 * a key silences it for the rest of the day. Texting the 23:00 group therefore
 * suppressed the 23:00 alert permanently, so a driver who became due later was
 * never flagged.
 *
 * Run: npm i --no-save jsdom && node scripts/alert-text-button.test.mjs
 */

import { readFileSync } from 'node:fs';

const ALERTS = readFileSync(new URL('../alerts.js', import.meta.url), 'utf8');
const FIX = readFileSync(new URL('../alert-text-button-fix.js', import.meta.url), 'utf8');

let failures = 0;
function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) { console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); failures++; }
}
const checkTrue = (label, v) => check(label, !!v, true);

// ---------------------------------------------------------------------------
console.log('\n1. the click uses the alert already on screen');

checkTrue('alerts.js exposes the live alert', /export function getBoardAlert\(key\)/.test(ALERTS));
checkTrue('it reads the rendered list', /boardAlerts\.find\(\(a\) => a\.key === String\(key\)\)/.test(ALERTS));
checkTrue('the click asks for it first', /let alert = alertsModule\.getBoardAlert\(key\);/.test(FIX));
// The scan survives only as a fallback, no longer as the primary path.
checkTrue('a scan is only a fallback',
  /if \(!alert\) \{\s*\n\s*const alerts = await alertsModule\.scanForBoardAlerts\(\);/.test(FIX));
check('the scan is no longer unconditional',
  /const alerts = await alertsModule\.scanForBoardAlerts\(\);\s*\n\s*const alert =/.test(FIX), false);

// ---------------------------------------------------------------------------
console.log('\n2. a click that cannot proceed says so');

checkTrue('an unresolvable alert reports to the dispatcher',
  /could not resolve alert key[\s\S]{0,260}setDriverSyncStatus\(/.test(FIX));
checkTrue('a recipient-less alert reports too',
  /has no recipient[\s\S]{0,220}setDriverSyncStatus\(/.test(FIX));
check('neither path is a bare console warning any more',
  /console\.warn\('Alert Text click could not resolve alert key:', key\);\s*\n\s*return;/.test(FIX), false);

// ---------------------------------------------------------------------------
console.log('\n3. dismissing one pre-shift group does not silence the next');

// Rebuild the key exactly as alerts.js does.
const keyFor = (shiftStartMin, shiftDbIds) => {
  const groupKey = [...new Set(shiftDbIds)].sort((a, b) => a - b).join('_');
  return `preshift-${shiftStartMin}-${groupKey}`;
};

const first = keyFor(1380, [101, 102]);          // two drivers due at 23:00
const laterDriver = keyFor(1380, [101, 102, 103]); // a third becomes due
const differentGroup = keyFor(1380, [104]);        // a wholly different driver

check('the same group produces the same key', keyFor(1380, [102, 101]), first);
check('adding a driver changes the key', laterDriver === first, false);
check('a different driver is a different alert', differentGroup === first, false);
check('a different shift time is still distinct', keyFor(1260, [101, 102]) === first, false);

// The actual failure: dismissing the first group must not suppress the later one.
const dismissed = new Set([first]);
check('the original group stays dismissed', dismissed.has(first), true);
check('a later, larger group still gets through', dismissed.has(laterDriver), false);
check('an unrelated driver still gets through', dismissed.has(differentGroup), false);

checkTrue('the key is built from the shift ids in alerts.js',
  /const groupKey = \[\.\.\.new Set\(list\.map\(\(d\) => d\.shiftDbId\)\)\]\.sort\(/.test(ALERTS));
checkTrue('and used in the alert key', /key: `preshift-\$\{shiftStartMin\}-\$\{groupKey\}`/.test(ALERTS));

// ---------------------------------------------------------------------------
console.log('\n4. repeating alerts still re-fire under a new key');

// Unchanged behaviour, re-pinned because the dismissal registry depends on it.
checkTrue('idle rolls a tier into its key', /key: `idle-\$\{s\.id\}-\$\{tier\}`/.test(ALERTS));
checkTrue('overdue return rolls a tier too', /key: `return-\$\{t\.id\}-\$\{tier\}`/.test(ALERTS));
checkTrue('at-DC rolls a tier too', /key: `atdc-\$\{s\.id\}-\$\{tier\}`/.test(ALERTS));

console.log(failures ? `\n  ${failures} check(s) FAILED\n` : '\n  All checks passed.\n');
process.exit(failures ? 1 : 0);
