/*
 * Regression coverage for the hard DNU recipient guard.
 *
 * This lifts the real guard from loadboard.js so the test fails if the shipped
 * code stops blocking a DNU name or a DNU phone reused as a dispatcher number.
 * Sharing only an MC must not block a driver with a different phone number.
 *
 * Run: node scripts/dnu-text-guard.test.mjs
 */

import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../loadboard.js', import.meta.url), 'utf8');
const start = source.indexOf('const NEVER_TEXT_DRIVER_NAMES');
const end = source.indexOf('let sendTextModalState', start);
if (start < 0 || end < 0) throw new Error('Could not find the DNU text guard in loadboard.js');

// The slice now also carries splitDoNotTextRecipients (the softer "do not
// text" flag, which lives beside this guard because they share textPhoneKeys
// and setsIntersect). It is exported; `export` is not valid inside a Function
// body, so it comes off here. The guard under test is unchanged.
const guardSource = source.slice(start, end).replace(/^\s*export\s+/gm, '  ');
const state = {
  drivers: [
    { name: 'Nathaniel Davis', phone: '(615) 555-0101', mc: '100', rating: 'DNU' },
    { name: 'Muarrem Lazaj', phone: '615-555-0102', mc: '200', rating: 'A' },
    { name: 'Carrier Mate', phone: '615-555-0103', dispatcherPhone: '615-555-0101', mc: '300', rating: 'A' },
    { name: 'Same Carrier', phone: '615-555-0104', mc: '100', rating: 'A' },
    { name: 'Safe Driver', phone: '615-555-0105', mc: '500', rating: 'A' },
  ],
};

const { filterNeverTextRecipients, splitDoNotTextRecipients } = new Function('state', `
  ${guardSource}
  return { filterNeverTextRecipients, splitDoNotTextRecipients };
`)(state);

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}`);
  if (!ok) {
    console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    failures += 1;
  }
}

console.log('\nDNU text recipient guard');

let result = filterNeverTextRecipients([
  state.drivers[0],
  state.drivers[1],
  state.drivers[2],
  state.drivers[3],
  state.drivers[4],
]);
check(
  'different target phones remain textable despite shared MC or a DNU dispatcher on file',
  result.allowed.map((d) => d.name),
  ['Carrier Mate', 'Same Carrier', 'Safe Driver'],
);
check(
  'the DNU names are blocked',
  result.blocked.map((d) => d.name),
  ['Nathaniel Davis', 'Muarrem Lazaj'],
);

result = filterNeverTextRecipients([
  { name: 'Another Driver (dispatch)', phone: '1 (615) 555-0101' },
  { name: 'Safe Driver (dispatch)', phone: '6155550105' },
]);
check('a DNU phone cannot re-enter as another driver dispatch number', result.allowed.map((d) => d.name), ['Safe Driver (dispatch)']);

result = filterNeverTextRecipients([
  { name: 'Nathaneil Davis (dispatch)', phone: '615-555-0199' },
]);
check('the known Nathaniel misspelling is hard-blocked by name', result.allowed.length, 0);

result = filterNeverTextRecipients([
  state.drivers[0],
  state.drivers[1],
], { allowDnu: true });
check(
  'the explicit DNU group is the only supported bypass',
  result.allowed.map((d) => d.name),
  ['Nathaniel Davis', 'Muarrem Lazaj'],
);

console.log(failures ? `\n${failures} check(s) FAILED\n` : '\nAll checks passed.\n');
process.exit(failures ? 1 : 0);
