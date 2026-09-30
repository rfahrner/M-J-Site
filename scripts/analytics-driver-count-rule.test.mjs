/*
 * The owner's ruling on what counts as a driver, pinned on both pages.
 *
 *   Cancelled or called off -> does NOT count.
 *   TONU                    -> DOES count, even if a cancel flag is also set.
 *
 * This has now flipped twice. It was briefly reversed on Location Analytics
 * (PR #176, "A TONU is not a driver who ran") on the theory that a driver who
 * was turned away and paid a TONU did not run, and reverted when the official
 * rule came back the other way. Do not change it again without the owner
 * saying so -- it is a business definition, not an implementation detail.
 *
 * It is not cosmetic. Turn, Rev/Driver and Margin/DR all divide by this
 * number, so the rule moves every per-driver figure on the page.
 *
 * Both pages must agree. Location Analytics' "Drivers" and Volume's "Drivers
 * Requested" were allowed to diverge once; this test builds each page's
 * countDrivers from its own source so they cannot drift apart again.
 *
 * Related: a person on the same day twice counts once (Cliff Carmichael,
 * 09/15). The per-day dedupe key covers that and is checked here too.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGES = {
  'Location Analytics': readFileSync(join(root, 'location-analytics.js'), 'utf8'),
  Volume: readFileSync(join(root, 'analytics-volume.js'), 'utf8'),
};

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
  const match = /function countDrivers\(shiftsInScope\) \{[\s\S]*?\n\}/.exec(src);
  if (!match) throw new Error('countDrivers not found -- the page was renamed or restructured');
  return new Function(`${match[0]}; return countDrivers;`)();
}

const day = '2026-08-13';
const next = '2026-08-14';

for (const [page, src] of Object.entries(PAGES)) {
  const count = buildCountDrivers(src);
  console.log(`\n${page}`);

  check('a driver who ran counts',
    count([{ shift_date: day, driver_id: 1 }]), 1);
  check('a TONU counts',
    count([{ shift_date: day, driver_id: 1, tonu: true }]), 1);
  check('a TONU with a cancel flag still counts',
    count([{ shift_date: day, driver_id: 1, tonu: true, load_cancelled: true }]), 1);
  check('a TONU with a call-off flag still counts',
    count([{ shift_date: day, driver_id: 1, tonu: true, called_off: true }]), 1);
  check('a cancelled shift does not count',
    count([{ shift_date: day, driver_id: 1, load_cancelled: true }]), 0);
  check('a called-off shift does not count',
    count([{ shift_date: day, driver_id: 1, called_off: true }]), 0);

  check('a mixed day counts the runners and the TONUs, not the cancellations',
    count([
      { shift_date: day, driver_id: 1 },
      { shift_date: day, driver_id: 2 },
      { shift_date: day, driver_id: 3, tonu: true },
      { shift_date: day, driver_id: 4, tonu: true },
      { shift_date: day, driver_id: 5, called_off: true },
      { shift_date: day, driver_id: 6, load_cancelled: true },
    ]), 4);

  check('the same driver twice in one day counts once',
    count([
      { shift_date: day, driver_id: 7 },
      { shift_date: day, driver_id: 7 },
    ]), 1);
  check('the same driver on two days counts twice',
    count([
      { shift_date: day, driver_id: 7 },
      { shift_date: next, driver_id: 7 },
    ]), 2);
  check('a typed name counts, and dedupes on spacing and case',
    count([
      { shift_date: day, driver_name_text: 'Cliff  Carmichael' },
      { shift_date: day, driver_name_text: 'cliff carmichael' },
    ]), 1);
}

console.log(failures ? `\n${failures} failing check(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
