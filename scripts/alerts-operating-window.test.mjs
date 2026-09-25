/*
 * Regression test: yesterday's shifts stop alerting once they are over.
 *
 * Reported from the Delaware board at 12:31 on 2026-09-25, with two of the
 * four alerts in the panel belonging to loads dated 2026-09-24:
 *
 *   Shafii Issa (1994835)  16:00 start  -- "has been at the DC 3h 16m"
 *   randy lewis (1996032)  20:00 start  -- "no dispatch time entered"
 *
 * 20.4 and 16.4 hours after their shift starts. Both long finished.
 *
 * The scan window is deliberately three days wide -- yesterday, today,
 * tomorrow -- so a night dispatcher's 20:00 load keeps its alerts at 02:00
 * rather than going silent at midnight. What was missing is the other end:
 * nothing aged a previous day's shift out again, so it stayed in scope for
 * the whole of the following day.
 *
 * The pre-shift cascade had its own floor at -180 minutes and behaved. Every
 * rule after it had no lower bound at all, which is why the two that fired
 * were an at-DC wait and a missing dispatch time.
 *
 * Run: node scripts/alerts-operating-window.test.mjs
 */

import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (n) => readFileSync(new URL(n, root), 'utf8');
const ALERTS = read('alerts.js');

let failures = 0;
function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) { console.log(`       expected: ${JSON.stringify(expected)}\n       actual:   ${JSON.stringify(actual)}`); failures++; }
}

const WINDOW = Number(/OPERATING_WINDOW_MIN = (\d+) \* (\d+)/.exec(ALERTS).slice(1).reduce((a, b) => a * b));
// The guard, lifted out and run as the shipped expression.
// The WHOLE condition, null guards included -- they are what stops a shift
// with no start time being read as infinitely old (nowMin - null is nowMin).
const GUARD = /if \((shiftStartMin != null && nowMin != null && nowMin - shiftStartMin > OPERATING_WINDOW_MIN)\) continue;/.exec(ALERTS);
if (!GUARD) throw new Error('could not find the operating-window guard in scanForBoardAlerts()');
const skips = new Function('shiftStartMin', 'nowMin', 'OPERATING_WINDOW_MIN', `return !!(${GUARD[1]});`);
const stale = (startMin, nowMin) => skips(startMin, nowMin, WINDOW);

// shiftRelativeNow() counts from midnight of the SHIFT's date, so a shift
// dated yesterday sees now as 1440 + today's clock.
const YESTERDAY = (clockMin) => 1440 + clockMin;
const hhmm = (h, m = 0) => h * 60 + m;

// ---------------------------------------------------------------------------
console.log('\n1. the window is the one the board already uses');
check('twelve hours', WINDOW, 720);

console.log('\n2. the two alerts that were reported are gone');
// 12:26 on 2026-09-25, both loads dated 2026-09-24.
check('Shafii Issa, 16:00 yesterday (20.4h)', stale(hhmm(16), YESTERDAY(hhmm(12, 26))), true);
check('randy lewis, 20:00 yesterday (16.4h)', stale(hhmm(20), YESTERDAY(hhmm(12, 26))), true);

console.log('\n3. the two that were real are kept');
// Same panel, same moment, but dated today -- these are the pre-shift calls.
check('Mohammed El, 14:00 today, not started yet', stale(hhmm(14), hhmm(12, 31)), false);
check('Abdoulay, 14:00 today, not started yet', stale(hhmm(14), hhmm(12, 31)), false);

console.log('\n4. the overnight case the three-day window exists for');
// This is the whole reason yesterday is in scope; breaking it would be worse
// than the noise being fixed.
check('20:00 yesterday, now 02:00 (6h in)', stale(hhmm(20), YESTERDAY(hhmm(2))), false);
check('22:00 yesterday, now 04:00 (6h in)', stale(hhmm(22), YESTERDAY(hhmm(4))), false);
check('16:00 yesterday, now 01:00 (9h in)', stale(hhmm(16), YESTERDAY(hhmm(1))), false);

console.log('\n5. the edges');
check('exactly twelve hours in is still live', stale(hhmm(8), hhmm(20)), false);
check('one minute past is not', stale(hhmm(8), hhmm(20, 1)), true);

console.log('\n6. tomorrow, and shifts with no start time');
// A shift dated tomorrow sees now as negative, so it can never be stale.
check('a shift dated tomorrow is never aged out', stale(hhmm(6), -600), false);
// Nothing to measure against: judge it on the rules, not on a guess.
check('no shift start means no judgement', stale(null, YESTERDAY(hhmm(12))), false);
check('and an unreadable clock is the same', stale(undefined, YESTERDAY(hhmm(12))), false);

console.log('\n7. the guard sits ahead of the rules it protects');
const SCAN = /export async function scanForBoardAlerts\(\)[\s\S]*?\n  \}/.exec(ALERTS)[0];
const guardAt = SCAN.indexOf('OPERATING_WINDOW_MIN) continue;');
for (const rule of ['at_dc_waiting', 'missing_eta', 'overdue_return', 'last_stop', 'missing_paperwork']) {
  check(`${rule} is behind it`, guardAt > 0 && guardAt < SCAN.indexOf(`type: "${rule}"`), true);
}
// The three-day window itself must stay -- narrowing it back to one day would
// "fix" this by breaking the overnight carry it was added for.
check('the scan still covers yesterday and tomorrow',
  /scanDates = \[offsetDate\(todayKey, -1\), todayKey, offsetDate\(todayKey, 1\)\]/.test(ALERTS), true);
// And the settled-load skip stays in front of everything.
check('TONU and cancelled are still skipped first',
  SCAN.indexOf('s.tonu') < guardAt, true);

console.log(failures ? `\n  ${failures} check(s) FAILED\n` : '\n  All checks passed.\n');
process.exit(failures ? 1 : 0);
