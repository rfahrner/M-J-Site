/*
 * Regression test: the Available list keeps its driver info.
 *
 * Reported as "driver info in the available list keeps disappearing when I
 * navigate away" -- a row showing the driver's name and a dash in every other
 * column.
 *
 * It is a race. initBoardPage() renders the Available section while
 * loadDriversFromSupabase() is still in flight and unawaited, so whichever
 * query returns second decides what you see. Every column but the name is
 * read off the driver profile via findDriver(row.driverId); the name survives
 * because it falls back to row.driverName, which is stored on the Available
 * row itself. That is why it looked like the data had been lost rather than
 * simply not joined yet.
 *
 * The half that made it permanent: loadDriversFromSupabase() redrew the driver
 * list and the board table when the pool landed, and never the Available
 * section. A lost race stayed lost until something else rebuilt that tbody.
 *
 * Run: node scripts/available-list-driver-info.test.mjs
 */

import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (n) => readFileSync(new URL(n, root), 'utf8');
const BOARD = read('loadboard.js');

let failures = 0;
function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) { console.log(`       expected: ${JSON.stringify(expected)}\n       actual:   ${JSON.stringify(actual)}`); failures++; }
}

// The real row renderer, with the driver pool as a parameter so both sides of
// the race can be played.
const SRC = /function availableRowHtml\(row\)[\s\S]*?\n  \}/.exec(BOARD)[0];
function render(row, drivers) {
  const findDriver = (id) => drivers.find((d) => d.id === id) || null;
  const escapeHtml = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const availableCarrierRateLabel = (drv) => (drv && drv.rate ? `$${drv.rate}` : '—');
  const state = { activeLocation: 'atlanta' };
  return new Function('row', 'findDriver', 'escapeHtml', 'availableCarrierRateLabel', 'state',
    `${SRC}; return availableRowHtml(row);`)(row, findDriver, escapeHtml, availableCarrierRateLabel, state);
}

const DRIVER = {
  id: 41, name: 'Mike Worrell', phone: '614-596-0098', dispatcherPhone: '614-555-0100',
  email: 'mike@example.com', mc: '884512', rating: 'A1', rate: '700',
};
const row = { id: 'avail_1', driverId: 41, driverName: 'Mike Worrell', notes: '' };
const dashes = (html) => (html.match(/<span class="static-text">—<\/span>/g) || []).length;

// ---------------------------------------------------------------------------
console.log('\n1. this is what the dispatcher was seeing');
{
  // The race, lost: Available rows back, driver pool not yet.
  const html = render(row, []);
  check('the name is still there', html.includes('value="Mike Worrell"'), true);
  // Carrier rate, cell, dispatcher phone, email, MC, rating.
  check('and every other column is a dash', dashes(html), 6);
}

console.log('\n2. and what it should be');
{
  const html = render(row, [DRIVER]);
  check('no dashes left', dashes(html), 0);
  check('cell', html.includes('614-596-0098'), true);
  check('dispatcher phone', html.includes('614-555-0100'), true);
  check('email', html.includes('mike@example.com'), true);
  check('MC', html.includes('884512'), true);
  check('rating', html.includes('A1'), true);
}

console.log('\n3. the same row renders correctly once the pool arrives');
// Nothing about the row changed between these two -- only whether the driver
// pool had loaded. That is the whole bug: it is a join, not stored data, so
// re-rendering after the fetch is all that was ever needed.
check('the row itself was never the problem',
  render(row, [DRIVER]) === render({ ...row }, [DRIVER]), true);

console.log('\n4. a row typed by name rather than picked still shows its name');
// No driver_id to join on, so dashes here are correct and expected.
{
  const html = render({ id: 'avail_2', driverId: null, driverName: 'Derek Franklin-C-LONG ONLY', notes: '' }, [DRIVER]);
  check('the typed name shows', html.includes('value="Derek Franklin-C-LONG ONLY"'), true);
  check('and the profile columns are honestly empty', dashes(html), 6);
}

console.log('\n5. the pool arriving now redraws the Available list');
const LOADED = /state\.drivers = all\.map\(driverFromDbRow\);[\s\S]*?\n  \}/.exec(BOARD)[0];
check('the driver list is still redrawn', /renderDriverList\(\);/.test(LOADED), true);
check('the board table is still redrawn', /renderBoardTable\(\);/.test(LOADED), true);
check('and now the Available list too', /renderAvailableTableKeepingFocus\(\);/.test(LOADED), true);
// Through the focus-preserving path: a dispatcher may be mid-name in there,
// and rebuilding the tbody under them closes the autocomplete.
check('not the raw rebuild, which would close an open autocomplete',
  /\n    renderAvailableTable\(\);/.test(LOADED), false);
// It must be safe on pages with no Available section at all.
const RENDER = /function renderAvailableTable\(\)[\s\S]*?\n  \}/.exec(BOARD)[0];
check('and it no-ops where there is no such table', /if \(!body\) return;/.test(RENDER), true);

console.log(failures ? `\n  ${failures} check(s) FAILED\n` : '\n  All checks passed.\n');
process.exit(failures ? 1 : 0);
