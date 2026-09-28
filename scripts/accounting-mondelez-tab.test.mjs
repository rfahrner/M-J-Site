/*
 * Regression test: the Mondelez tab on the Accounting page.
 *
 * Mondelez had never reached Accounting at all -- loads_accounting carried
 * source_shift_id and source_houston_id and nothing else -- so 1,381 loads back
 * to 2024-10-09 lived only on their own board. The pipeline is in the migration;
 * this pins what the page does with the records once they arrive.
 *
 * The tab carries the board's fields minus the ones that do not belong in
 * Accounting: no text or email buttons, no Driver App ID, no trailer or return
 * trailer, no status/notes, no route image. What is left is laid out the way
 * every other tab is -- Date first, Day Type / Sent / Released / Highlight last.
 *
 * Three of its columns are not on the accounting record and cannot be: the
 * Mondelez site, the shift start and the delivery group live on the board row,
 * and the driver's cell lives on the profile. Both are read live rather than
 * copied, so there is one copy of each fact.
 *
 * Run: node scripts/accounting-mondelez-tab.test.mjs
 */

import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const SRC = readFileSync(new URL('accounting.js', root), 'utf8');
const HTML = readFileSync(new URL('accounting.html', root), 'utf8');

let failures = 0;
function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) { console.log(`       expected: ${JSON.stringify(expected)}\n       actual:   ${JSON.stringify(actual)}`); failures++; }
}
const listOf = (name) =>
  JSON.parse(new RegExp(`const ${name} = (\\[[^\\]]*\\])`).exec(SRC)[1].replace(/'/g, '"'));
const extract = (name) =>
  new RegExp(`(?:export )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?\\n  \\}`).exec(SRC)[0].replace('export ', '');

const HEADER = extract('acctTableHeaderHtml');
function headersFor(loc) {
  const html = new Function(
    'state', 'accountingDriverSort', 'accountingDriverHeaderHtml',
    'LOCATIONS_WITH_LEVELS', 'LOCATIONS_WITH_ROUTES_INSTEAD_OF_COST',
    'LOCATIONS_WITHOUT_FSC', 'LOCATIONS_WITHOUT_MILES_STOPS',
    'LOCATIONS_WITH_CARRIER_EMAIL', 'LOCATIONS_WITH_MONDELEZ_COLS',
    `${HEADER}; return acctTableHeaderHtml();`
  )({ acctLocationTab: loc }, 0, () => 'Driver',
    listOf('LOCATIONS_WITH_LEVELS'), listOf('LOCATIONS_WITH_ROUTES_INSTEAD_OF_COST'),
    listOf('LOCATIONS_WITHOUT_FSC'), listOf('LOCATIONS_WITHOUT_MILES_STOPS'),
    listOf('LOCATIONS_WITH_CARRIER_EMAIL'), listOf('LOCATIONS_WITH_MONDELEZ_COLS'));
  return [...html.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => m[1].replace(/<[^>]*>/g, '').trim());
}

// ---------------------------------------------------------------------------
console.log('\n1. the tab exists');
check('a Mondelez button on the page', /data-location="mondelez"/.test(HTML), true);
// It goes after the four that were already there.
check('after Houston', HTML.indexOf('data-location="mondelez"') > HTML.indexOf('data-location="houston"'), true);

console.log('\n2. the columns Ron kept, in accounting order');
const mdz = headersFor('mondelez');
check('the whole header',
  mdz.join(' | '),
  'Date | Location | Aljex # | Driver | MC | Cell | Start | DG# | Total Miles | Total Stops | Carrier Rate | Customer Rate | FSC Payment | Day Type | Sent | Released | Highlight');
// FSC is the column every non-Atlanta tab already has, not a second one of its
// own -- it reads the same fsc_payment field through the same formatter.

console.log('\n3. and the ones he dropped are absent');
// No text or email buttons, and none of these five board columns.
for (const col of ['Driver App ID', 'Trailer #', 'Return Trailer #', 'Status / Notes', 'Route Image']) {
  check(`no ${col}`, mdz.includes(col), false);
}
// The email column is Houston's; Mondelez was not asked for it.
check('no MC Email either', mdz.includes('MC Email'), false);

console.log('\n4. it ends the way every other tab ends');
check('Sent and Released are there', mdz.includes('Sent') && mdz.includes('Released'), true);
check('and in the usual final order',
  mdz.slice(-4).join(' | '), 'Day Type | Sent | Released | Highlight');

console.log('\n5. no other tab moved');
check('Atlanta',
  headersFor('atlanta').join(' | '),
  'Date | Aljex # | Driver | MC | Cost Level | Revenue Rate | Routes | Total Miles | Total Stops | Carrier Rate | Customer Rate | Day Type | Sent | Released | Highlight');
check('Houston',
  headersFor('houston').join(' | '),
  'Date | Aljex # | Driver | MC Email | MC | Carrier Rate | Customer Rate | Day Type | Sent | Released | Highlight');
check('Delaware',
  headersFor('delaware').join(' | '),
  'Date | Aljex # | Driver | MC | Routes | Total Miles | Total Stops | Carrier Rate | Day Type | Sent | Released | Highlight');
check('Building C',
  headersFor('buildingc').join(' | '),
  'Date | Aljex # | Driver | MC | Total Miles | Total Stops | Carrier Rate | Customer Rate | FSC Payment | Day Type | Sent | Released | Highlight');
for (const loc of ['atlanta', 'houston', 'delaware', 'buildingc']) {
  check(`${loc} has no Location column`, headersFor(loc).includes('Location'), false);
}

console.log('\n6. the header and the row agree on order');
// A cell in a different place from its heading shifts every column after it,
// and the page would still render perfectly happily.
const ROW = extract('accountingRowHtml');
const order = ['rec.shift_date', 'mondelezSiteLabel', 'rec.aljex_load_number', 'rec.driver_name_text', 'rec.mc_dot', 'acctDriverCell'];
for (let i = 1; i < order.length; i++) {
  check(`${order[i]} comes after ${order[i - 1]}`, ROW.indexOf(order[i]) > ROW.indexOf(order[i - 1]), true);
}

console.log('\n7. the site names read as names');
const mondelezSiteLabel = new Function('MONDELEZ_SITE_LABELS',
  `${extract('mondelezSiteLabel')}; return mondelezSiteLabel;`
)(JSON.parse(/const MONDELEZ_SITE_LABELS = \{([\s\S]*?)\};/.exec(SRC)[1]
  .replace(/(\w+):/g, '"$1":').replace(/,\s*$/, '').replace(/^/, '{').replace(/$/, '}')));
check('westchester', mondelezSiteLabel('westchester'), 'West Chester');
check('saltlakecity', mondelezSiteLabel('saltlakecity'), 'Salt Lake City');
// A site nobody has labelled yet should appear as itself, not disappear.
check('an unlisted site shows its key', mondelezSiteLabel('tucson'), 'tucson');
check('and a blank one is a dash', mondelezSiteLabel(''), '—');
check('as is a missing board row', mondelezSiteLabel(undefined), '—');

console.log('\n8. negative carrier pay is called out, not absorbed');
const warn = new Function(`${extract('acctCarrierPayWarningHtml')}; return acctCarrierPayWarningHtml;`)();
check('a negative figure is flagged', /Check this figure/.test(warn({ total_carrier_pay: -5600 })), true);
check('a normal figure is not', warn({ total_carrier_pay: 850 }), '');
check('nor is zero', warn({ total_carrier_pay: 0 }), '');
check('nor a blank', warn({ total_carrier_pay: null }), '');
check('it is shown on the carrier rate cell', /\$\{acctCarrierPayWarningHtml\(rec\)\}/.test(ROW), true);

console.log('\n9. the three board columns are read live, and chunked');
check('the board row is fetched by source_mondelez_id',
  /from\(MONDELEZ_TABLE\)\s*\n?\s*\.select\("id, location, start_time, delivery_group"\)/.test(SRC), true);
check('chunked like every other lookup', /for \(const idChunk of chunk\(mondelezIds, CHUNK_SIZE\)\)/.test(SRC), true);
check("the driver's cell comes off the profile", /acctDriverInfoById\[rec\.driver_id\]\?\.cell/.test(SRC), true);
check('fetched with the email in one query', /select\('id, "E mail", "Driver Cell"'\)/.test(SRC), true);
// A new import edge between two page modules would join a cycle that has
// broken startup before, so the table name is declared locally instead.
check('mondelez.js is not imported here', /from '\.\/mondelez\.js'/.test(SRC), false);

console.log(failures ? `\n  ${failures} check(s) FAILED\n` : '\n  All checks passed.\n');
process.exit(failures ? 1 : 0);
