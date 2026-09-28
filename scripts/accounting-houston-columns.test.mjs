/*
 * Regression test: the Houston tab's columns, and the carrier email.
 *
 * Houston's accounting records carry neither total_miles nor total_stops --
 * both are null on all 161 of them -- and no FSC is paid on that lane, so three
 * columns were a dash on every row of every day. They are hidden for Houston
 * only; every other tab keeps what it had.
 *
 * Customer Rate was reading $0.00 because auto_send_houston_to_accounting()
 * inserted total_revenue as a literal 0. That is fixed in the database, not
 * here -- the rate lives in pricing_settings as houston_customer_rate and the
 * column is the same editable cell it always was. Nothing in this file needs to
 * know the figure, which is the point: a rate hard-coded in the page would be
 * one more place to change it.
 *
 * The carrier's email now sits between the driver and the MC. It is read live
 * off the driver profile rather than copied onto the accounting record, so it
 * is the address the carrier uses now; where a profile has none, or a load was
 * typed in by name with no profile behind it, the cell is a dash.
 *
 * Run: node scripts/accounting-houston-columns.test.mjs
 */

import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const SRC = readFileSync(new URL('accounting.js', root), 'utf8');

let failures = 0;
function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) { console.log(`       expected: ${JSON.stringify(expected)}\n       actual:   ${JSON.stringify(actual)}`); failures++; }
}
const listOf = (name) =>
  JSON.parse(new RegExp(`const ${name} = (\\[[^\\]]*\\])`).exec(SRC)[1].replace(/'/g, '"'));

// The real header builder, run per location.
const HEADER = /export function acctTableHeaderHtml\(\)[\s\S]*?\n  \}/.exec(SRC)[0].replace('export ', '');
function headersFor(loc) {
  const html = new Function(
    'state', 'accountingDriverSort', 'accountingDriverHeaderHtml',
    'LOCATIONS_WITH_LEVELS', 'LOCATIONS_WITH_ROUTES_INSTEAD_OF_COST',
    'LOCATIONS_WITHOUT_FSC', 'LOCATIONS_WITHOUT_MILES_STOPS', 'LOCATIONS_WITH_CARRIER_EMAIL',
    'LOCATIONS_WITH_MONDELEZ_COLS',
    `${HEADER}; return acctTableHeaderHtml();`
  )({ acctLocationTab: loc }, 0, () => 'Driver',
    listOf('LOCATIONS_WITH_LEVELS'), listOf('LOCATIONS_WITH_ROUTES_INSTEAD_OF_COST'),
    listOf('LOCATIONS_WITHOUT_FSC'), listOf('LOCATIONS_WITHOUT_MILES_STOPS'),
    listOf('LOCATIONS_WITH_CARRIER_EMAIL'), listOf('LOCATIONS_WITH_MONDELEZ_COLS'));
  return [...html.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => m[1].replace(/<[^>]*>/g, '').trim());
}

// ---------------------------------------------------------------------------
console.log('\n1. Houston loses the three empty columns');
const houston = headersFor('houston');
for (const col of ['Total Miles', 'Total Stops', 'FSC Payment']) {
  check(`no ${col}`, houston.includes(col), false);
}

console.log('\n2. and keeps the ones that carry a figure');
check('Carrier Rate stays', houston.includes('Carrier Rate'), true);
// This is the cell that now reads $995 instead of $0.00. It is the same
// editable input it always was -- the figure comes from the record.
check('Customer Rate stays', houston.includes('Customer Rate'), true);
check('no rate is hard-coded in the page', /995/.test(SRC), false);

console.log('\n3. the carrier email sits between the driver and the MC');
check('there is an MC Email column', houston.includes('MC Email'), true);
check('immediately right of Driver', houston[houston.indexOf('MC Email') - 1], 'Driver');
check('and immediately left of MC', houston[houston.indexOf('MC Email') + 1], 'MC');

console.log('\n4. Houston in full, in order');
check('the whole header',
  houston.join(' | '),
  'Date | Aljex # | Driver | MC Email | MC | Carrier Rate | Customer Rate | Day Type | Sent | Released | Highlight');

console.log('\n5. no other tab changed');
// Atlanta prices by level and already had no FSC column of its own.
check('Atlanta',
  headersFor('atlanta').join(' | '),
  'Date | Aljex # | Driver | MC | Cost Level | Revenue Rate | Routes | Total Miles | Total Stops | Carrier Rate | Customer Rate | Day Type | Sent | Released | Highlight');
// Delaware is flat-rate: Routes instead of Cost/Revenue/FSC.
check('Delaware',
  headersFor('delaware').join(' | '),
  'Date | Aljex # | Driver | MC | Routes | Total Miles | Total Stops | Carrier Rate | Day Type | Sent | Released | Highlight');
check('Building C',
  headersFor('buildingc').join(' | '),
  'Date | Aljex # | Driver | MC | Total Miles | Total Stops | Carrier Rate | Customer Rate | FSC Payment | Day Type | Sent | Released | Highlight');
for (const loc of ['atlanta', 'delaware', 'buildingc']) {
  check(`${loc} has no email column`, headersFor(loc).includes('MC Email'), false);
}

console.log('\n6. the empty-state row spans the header it was built from');
// It used to be a hand-maintained ternary per location, so hiding a column for
// one tab silently left that row the wrong width.
check('counted off the header', /const colspan = \(headerHtml\.match\(\/<th\\b\/g\) \|\| \[\]\)\.length/.test(SRC), true);

console.log('\n7. the email cell');
const CELL = /export function acctCarrierEmailHtml\(rec\)[\s\S]*?\n  \}/.exec(SRC)[0];
// The map now carries the cell alongside the email, so the tab that wants both
// gets them from one lookup.
const acctCarrierEmailHtml = new Function('acctDriverInfoById', 'escapeHtml',
  `${CELL.replace('export ', '')}; return acctCarrierEmailHtml;`
)({ 7: { email: 'dispatch@carrier.com', cell: '555-0100' }, 9: { email: '', cell: '' } },
  (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'));
check('a profile with an email gets a mailto',
  acctCarrierEmailHtml({ driver_id: 7 }),
  '<a href="mailto:dispatch@carrier.com" title="dispatch@carrier.com">dispatch@carrier.com</a>');
// Percent-encoding the @ is not what a mail client expects to be handed.
check('the @ is left alone', acctCarrierEmailHtml({ driver_id: 7 }).includes('%40'), false);
check('a profile with no email is a dash', acctCarrierEmailHtml({ driver_id: 9 }), '—');
check('a driver not on file is a dash', acctCarrierEmailHtml({ driver_id: 404 }), '—');
// A load typed in by name has no profile to read at all.
check('no driver_id is a dash', acctCarrierEmailHtml({ driver_id: null }), '—');

console.log('\n8. the email is read live, and read safely');
check('fetched from the drivers table', /from\(DRIVERS_TABLE\)\.select\('id, "E mail", "Driver Cell"'\)/.test(SRC), true);
// A long .in() truncates without erroring -- the same failure this page hit
// once with the drivers table, which is why every other lookup here is chunked.
check('chunked like every other lookup here', /for \(const idChunk of chunk\(driverIds, CHUNK_SIZE\)\)/.test(SRC), true);
check('and not copied onto the accounting record', /acctDriverInfoById\[d\.id\]/.test(SRC), true);

console.log(failures ? `\n  ${failures} check(s) FAILED\n` : '\n  All checks passed.\n');
process.exit(failures ? 1 : 0);
