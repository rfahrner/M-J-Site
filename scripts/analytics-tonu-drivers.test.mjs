/*
 * Drivers means drivers who ran. A TONU did not run.
 *
 * Location Analytics' Drivers column used to include TONU'd shifts, on the
 * reading that a TONU is attendance. The owner's definition is the opposite: a
 * driver who was requested, turned away and paid a TONU is not a driver that
 * day. The accounting workbook agrees in shape -- its recap keeps "Drivers" and
 * "TONU's" as two separate columns rather than folding one into the other.
 *
 * This matters beyond the one column. Turn, Rev/Driver and Margin/DR all divide
 * by this number, so counting TONUs made a TONU-heavy day read worse per driver
 * than it actually was. On 2026-08-13 Atlanta that was 29 drivers against 13
 * TONUs; the honest figure is 19.
 *
 * Volume's "Drivers Requested" is deliberately NOT changed. That column answers
 * who was asked for, which is a different question, and a TONU belongs in it.
 * The two pages disagreeing here is the point, not an oversight.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const LA = readFileSync(join(root, 'location-analytics.js'), 'utf8');
const VOL = readFileSync(join(root, 'analytics-volume.js'), 'utf8');

let failures = 0;
function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) console.log(`       expected: ${expected}\n       actual:   ${actual}`);
}

// Rebuild each page's countDrivers from its own source, so this tests the
// shipped logic rather than a copy of it that can drift.
function buildCountDrivers(src) {
  const body = /function countDrivers\(shiftsInScope\) \{[\s\S]*?\n\}/.exec(src)[0];
  return new Function(`${body}; return countDrivers;`)();
}

const laCount = buildCountDrivers(LA);
const volCount = buildCountDrivers(VOL);

const day = '2026-08-13';
const rows = [
  { shift_date: day, driver_id: 1, tonu: false },
  { shift_date: day, driver_id: 2, tonu: false },
  { shift_date: day, driver_id: 3, tonu: true },            // paid, did not run
  { shift_date: day, driver_id: 4, tonu: true },
  { shift_date: day, driver_id: 5, tonu: false, called_off: true },
  { shift_date: day, driver_id: 6, tonu: false, load_cancelled: true },
];

console.log('\n1. Location Analytics counts drivers who ran');
check('TONUs are left out', laCount(rows), 2);
check('a cancelled shift is still left out',
  laCount([{ shift_date: day, driver_id: 9, tonu: false, load_cancelled: true }]), 0);
check('a called-off shift is still left out',
  laCount([{ shift_date: day, driver_id: 9, tonu: false, called_off: true }]), 0);

console.log('\n2. the same person on one day is still one driver');
check('two loads, one driver', laCount([
  { shift_date: day, driver_id: 7, tonu: false },
  { shift_date: day, driver_id: 7, tonu: false },
]), 1);
check('but the next day is a second driver-day', laCount([
  { shift_date: day, driver_id: 7, tonu: false },
  { shift_date: '2026-08-14', driver_id: 7, tonu: false },
]), 2);
check('a typed name still counts when there is no profile', laCount([
  { shift_date: day, driver_id: null, driver_name_text: '  Cliff   Carmichael ', tonu: false },
  { shift_date: day, driver_id: null, driver_name_text: 'cliff carmichael', tonu: false },
]), 1);

console.log('\n3. Volume still counts who was requested');
// Same six rows: Volume keeps the two TONUs, because being turned away does not
// undo having been asked for.
check('TONUs are kept there', volCount(rows), 4);
check('and the two pages genuinely differ', volCount(rows) === laCount(rows), false);

console.log(failures ? `\n  ${failures} check(s) FAILED\n` : '\n  All checks passed.\n');
process.exit(failures ? 1 : 0);
