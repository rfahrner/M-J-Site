/*
 * Regression test: no alerts for a load that is not going to run.
 *
 * Reported as "we have several TONU'd drivers that we are getting alerts for
 * ... if a driver is TONU'd we dont need to get alerts in the alerts popup".
 * At the time, six of the seven Atlanta loads that day were TONU and none were
 * complete, so the alert panel was almost entirely noise about loads that were
 * already settled.
 *
 * The scan only ever skipped shift_complete. Everything it produces is a
 * prompt to act on a live shift -- text the driver, call for an ETA, chase
 * paperwork, chase an overdue return -- and on a TONU there is no route to
 * track and nobody to chase. Called off and cancelled are the same case from
 * the other direction, and are skipped for the same reason; leaving them in
 * would just be the identical complaint a week later.
 *
 * What must stay true: a normal running load still raises everything it did
 * before. This is a filter on settled loads, not a quieter alert system.
 *
 * Run: node scripts/alerts-skip-settled-loads.test.mjs
 */

import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../alerts.js', import.meta.url), 'utf8');

let failures = 0;
function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) { console.log(`       expected: ${JSON.stringify(expected)}\n       actual:   ${JSON.stringify(actual)}`); failures++; }
}

// The guard, lifted out of the scan loop and run as the shipped code.
const GUARD = /for \(const s of shifts\) \{[\s\S]*?\n      if \(([^)]*)\) continue;/.exec(SRC);
if (!GUARD) throw new Error('could not find the per-shift skip in scanForBoardAlerts()');
// Coerced, because that is what `if (...)` does with it. An older row whose
// flags are null must not be read as settled, and `false || null` is null --
// falsy, so the load is scanned. Asserting the raw value instead of the
// branch it drives would fail on behaviour that is correct.
const skips = new Function('s', `return !!(${GUARD[1]});`);

const shift = (over = {}) => ({
  shift_complete: false, tonu: false, called_off: false, load_cancelled: false, ...over,
});

// ---------------------------------------------------------------------------
console.log('\n1. a settled load raises nothing');
check('a TONU is skipped', skips(shift({ tonu: true })), true);
check('a called-off driver is skipped', skips(shift({ called_off: true })), true);
check('a cancelled load is skipped', skips(shift({ load_cancelled: true })), true);
check('a completed shift is still skipped', skips(shift({ shift_complete: true })), true);

console.log('\n2. a live load is untouched');
// The whole value of the panel is that this still fires. A filter that also
// silences running loads would be worse than the noise it removed.
check('an ordinary running load is scanned', skips(shift()), false);

console.log('\n3. the flags are read, not inferred');
// A TONU that was later marked complete, or any other combination, is still
// settled -- these are independent booleans, not a state machine.
check('TONU and complete together', skips(shift({ tonu: true, shift_complete: true })), true);
check('cancelled and called off together', skips(shift({ load_cancelled: true, called_off: true })), true);
// Postgres booleans arrive as null on older rows that predate the column.
check('a null flag is not treated as set', skips({ ...shift(), tonu: null, called_off: null, load_cancelled: null }), false);

console.log('\n4. the alert rules themselves are unchanged');
// This is a filter on which shifts get scanned. If a rule disappeared, the
// panel would go quiet for the wrong reason and nobody would notice.
for (const type of [
  'call_followup', 'idle', 'missing_paperwork', 'missing_eta',
  'missing_trailer_number', 'last_stop', 'overdue_return', 'at_dc_waiting',
  'preshift_escalate', 'preshift_text',
]) {
  check(`${type} still exists`, SRC.includes(`type: "${type}"`), true);
}

console.log('\n5. the skip is the first thing in the loop');
// Anything above it does work for a load that is about to be thrown away,
// and anything that pushes an alert above it defeats the filter entirely.
const LOOP = /for \(const s of shifts\) \{([\s\S]*?)continue;/.exec(SRC)[1];
check('nothing is computed before the skip', /alerts\.push|push\(\{/.test(LOOP), false);

console.log(failures ? `\n  ${failures} check(s) FAILED\n` : '\n  All checks passed.\n');
process.exit(failures ? 1 : 0);
