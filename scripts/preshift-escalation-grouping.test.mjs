/*
 * Regression test for grouping stage-3 pre-shift escalations.
 *
 * When four drivers are all overdue on the same 09:00 shift, the alert widget
 * used to show four separate "has not confirmed their 09:00 shift today"
 * rows, each with its own Text button, each sending the identical message.
 * Stage 1 (the 60-minute check-in text) had been grouped by shift time for
 * exactly this reason; stage 3 never was.
 *
 * Three things here are easy to get wrong and are pinned below:
 *
 *  - The dismissal key has to name WHICH drivers the alert covers. Dismissing
 *    silences a key for the rest of the day, so a key of just the shift time
 *    would mean clearing the 09:00 group also suppressed the alert for a
 *    driver who only went overdue afterwards.
 *  - A single driver must come out byte-identical to before, key included, or
 *    every alert dismissed earlier today comes back.
 *  - Grouping is by location AND time. Alerts carry their own shift's
 *    location and two boards can both run an 09:00.
 *
 * The grouping block is lifted out of alerts.js and run directly, so the test
 * exercises the shipped code rather than a copy of it.
 *
 * Run: npm i --no-save jsdom && node scripts/preshift-escalation-grouping.test.mjs
 */

import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../alerts.js', import.meta.url), 'utf8');

let failures = 0;
function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}` + (ok ? '' : `\n       expected: ${expected}\n       actual:   ${actual}`));
}
const checkTrue = (l, v) => check(l, !!v, true);

// Lift the grouping block: from its own comment to where stage 1's grouping
// takes over.
const start = SRC.indexOf('    // Stage 3 escalations, grouped the same way');
const end = SRC.indexOf('    Object.entries(byShiftTime).forEach(');
if (start < 0 || end < 0 || end <= start) throw new Error('could not locate the stage-3 grouping block');
const BLOCK = SRC.slice(start, end);

const groupEscalations = new Function('preShiftEscalations', `
  const alerts = [];
  ${BLOCK}
  return alerts;
`);

const driver = (name, shiftDbId, opts = {}) => ({
  shiftStartMin: opts.shiftStartMin ?? 540,          // 09:00
  clockLabel: opts.clockLabel ?? '9:00',
  driverName: name,
  driverPhone: opts.phone === undefined ? `555000${shiftDbId}` : opts.phone,
  label: opts.label ?? `199${shiftDbId}`,
  shiftDbId,
  location: opts.location ?? 'atlanta',
});

// ---------------------------------------------------------------------------
console.log('1. several drivers on one shift time become one alert');
const many = groupEscalations([
  driver('Tramall Marshall', 11),
  driver('Pierre Paul', 12),
  driver('Kecia May', 13),
]);
check('one alert, not three', many.length, 1);
check('all three are recipients', many[0].recipients.length, 3);
check('it still says what it is', many[0].type, 'preshift_escalate');
check('message counts them', /^3 drivers have not confirmed their 9:00 shift today/.test(many[0].message), true);
checkTrue('and names them', /\(Tramall Marshall, Pierre Paul, Kecia May\)$/.test(many[0].message));
check('one message for the whole group',
  many[0].actionMessage, 'This is D&L Transportation, could we have an ETA for your 9:00 kroger shift');
check('clicking it jumps to every row', many[0].jumpShiftIds.join(','), '11,12,13');
check('no single shiftDbId on a group', many[0].shiftDbId, undefined);

// ---------------------------------------------------------------------------
console.log('\n2. the key names the drivers, so dismissing one group is not a blanket');
check('key covers exactly this set', many[0].key, 'preshift-escalate-11_12_13');
const laterDriverAppears = groupEscalations([
  driver('Tramall Marshall', 11), driver('Pierre Paul', 12), driver('Kecia May', 13),
  driver('Audrey Sampson', 14),
]);
check('a fourth driver makes it a different alert',
  laterDriverAppears[0].key !== many[0].key, true);
check('order of arrival does not change the key',
  groupEscalations([driver('C', 13), driver('A', 11), driver('B', 12)])[0].key, 'preshift-escalate-11_12_13');

// ---------------------------------------------------------------------------
console.log('\n3. a single driver is untouched');
const one = groupEscalations([driver('Tramall Marshall', 11, { label: '1991892' })]);
check('still one alert', one.length, 1);
check('message is the original wording',
  one[0].message, 'Tramall Marshall (1991892) — has not confirmed their 9:00 shift today');
// The old key was `preshift-escalate-${s.id}`. If this drifts, every alert a
// dispatcher dismissed earlier today reappears.
check('key matches the old single-driver key', one[0].key, 'preshift-escalate-11');
check('and it still carries shiftDbId for the row jump', one[0].shiftDbId, 11);

// ---------------------------------------------------------------------------
console.log('\n4. different shifts and different boards stay separate');
const twoTimes = groupEscalations([
  driver('A', 11), driver('B', 12),
  driver('C', 21, { shiftStartMin: 600, clockLabel: '10:00' }),
]);
check('two alerts', twoTimes.length, 2);
check('grouped by time', twoTimes.map((a) => a.recipients.length).sort().join(','), '1,2');

const twoBoards = groupEscalations([
  driver('A', 11, { location: 'atlanta' }),
  driver('B', 12, { location: 'delaware' }),
]);
check('same time on two boards stays split', twoBoards.length, 2);
check('each keeps its own location',
  twoBoards.map((a) => a.location).sort().join(','), 'atlanta,delaware');

// ---------------------------------------------------------------------------
console.log('\n5. a driver with no phone still gets flagged, just not texted');
const noPhone = groupEscalations([
  driver('Has phone', 11),
  driver('No phone', 12, { phone: '' }),
]);
check('both are in the alert text', /2 drivers have not confirmed/.test(noPhone[0].message), true);
check('only the reachable one is a recipient', noPhone[0].recipients.length, 1);
check('but the jump still covers both rows', noPhone[0].jumpShiftIds.join(','), '11,12');

// ---------------------------------------------------------------------------
console.log('\n6. the widget prefers jumpShiftIds when deciding where to jump');
checkTrue('renderer reads jumpShiftIds first',
  /const targetIds = a\.jumpShiftIds && a\.jumpShiftIds\.length\s*\n?\s*\?\s*a\.jumpShiftIds/.test(SRC));
checkTrue('Text button still says "these drivers" for a group',
  /recipients\.length > 1 \? "these drivers" : "this driver"/.test(SRC));

console.log(failures ? `\n  ${failures} check(s) FAILED\n` : '\n  All checks passed.\n');
process.exit(failures ? 1 : 0);
