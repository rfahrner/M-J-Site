/*
 * Which loads land on the invoice, and what each line says.
 *
 * Every rule here was derived by reproducing the owner-approved invoice
 * (8/17/26 - 8/23/26, PRO 1958081, $54,348.30) from live data and checking
 * all 48 driver lines against it. They are pinned because each one is a
 * money decision that fails QUIETLY: a dropped line still produces an
 * invoice whose pages add up to its own total, so nothing on the document
 * says it is short.
 *
 * Run: node scripts/invoice-data-rules.test.mjs
 */
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (f) => readFileSync(new URL(f, root), 'utf8');
const strip = (f) => read(f).replace(/^import[^;]*;\s*$/gm, '').replace(/^export /gm, '');
const api = new Function(
  strip('invoice-data.js')
  + '\nreturn { buildInvoiceData, addDays, weekStart, lastCompletedWeek, invoiceFileName, INVOICE_LOCATIONS };',
)();

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) { console.log(`       expected: ${JSON.stringify(expected)}\n       actual:   ${JSON.stringify(actual)}`); failures++; }
}

/*
 * A fake of the page's paged reader. It records what was asked for, so the
 * filters can be asserted -- a missing .neq('status','deleted') would bill
 * loads somebody deleted, and nothing on the invoice would look wrong.
 */
function fetcher(rows, { fail = null } = {}) {
  const calls = [];
  const fn = async (table, columns, applyFilters) => {
    const q = { table, columns, filters: {} };
    const builder = {
      eq: (c, v) => { q.filters[`eq:${c}`] = v; return builder; },
      neq: (c, v) => { q.filters[`neq:${c}`] = v; return builder; },
      gte: (c, v) => { q.filters[`gte:${c}`] = v; return builder; },
      lte: (c, v) => { q.filters[`lte:${c}`] = v; return builder; },
      in: (c, v) => { q.filters[`in:${c}`] = v; return builder; },
    };
    if (applyFilters) applyFilters(builder);
    calls.push(q);
    if (fail === table) throw new Error(`Could not read ${table} (boom).`);
    return rows[table] || [];
  };
  fn.calls = calls;
  return fn;
}

const ARGS = { location: 'atlanta', startDate: '2026-08-17', endDate: '2026-08-23', invoiceDate: '2026-10-16' };

// One ordinary day: two paid drivers, a TONU, a zero-revenue row, and a
// driver whose shift has several routes.
const ROWS = {
  loads_accounting: [
    { shift_date: '2026-08-17', source_shift_id: 2, total_revenue: '2296.24', driver_name_text: 'James Terrell', aljex_load_number: '1958082' },
    { shift_date: '2026-08-17', source_shift_id: 1, total_revenue: '582.27', driver_name_text: 'Atiba Ward', aljex_load_number: '1958081' },
    { shift_date: '2026-08-17', source_shift_id: 3, total_revenue: '0.00', driver_name_text: 'Norman Allen-Pick Up', aljex_load_number: null },
    { shift_date: '2026-08-18', source_shift_id: 4, total_revenue: '250.00', driver_name_text: 'Marcus Smith-Mag', aljex_load_number: '1961803' },
  ],
  loads_shifts: [{ id: 1, tonu: false }, { id: 2, tonu: false }, { id: 3, tonu: false }, { id: 4, tonu: true }],
  loads_trips: [
    { shift_id: 1, trip_id: '1274441', trip_number: 1 },
    { shift_id: 2, trip_id: '1274999', trip_number: 3 },
    { shift_id: 2, trip_id: '1274895', trip_number: 1 },   // the first of the day
    { shift_id: 2, trip_id: '1274950', trip_number: 2 },
    { shift_id: 4, trip_id: 'SHOULD-NOT-SHOW', trip_number: 1 },
  ],
};

console.log('\n1. the shape of a week');
const inv = await api.buildInvoiceData(fetcher(ROWS), ARGS);
check('one entry per operating day', inv.days.map((d) => d.date), ['2026-08-17', '2026-08-18']);
check('drivers are alphabetical within a day', inv.days[0].lines.map((l) => l.driver), ['Atiba Ward', 'James Terrell']);
check('subtotals are the sum of their own lines', inv.days[0].subtotal, 2878.51);
check('the total is the sum of the subtotals', inv.total, 3128.51);

console.log('\n2. a zero-revenue load is not a line');
/*
 * The approved 8/22 has nine accounting rows and bills eight drivers:
 * "Norman Allen-Pick Up" carries $0.00. Billing it would print a $0.00
 * charge AND count a ninth unit on the cover.
 */
check('the $0.00 row is gone', inv.days[0].lines.some((l) => /Norman/.test(l.driver)), false);
check('so the day counts two units, not three', inv.days[0].lines.length, 2);

console.log('\n3. the Trip ID is the driver\'s FIRST trip of the day');
// James Terrell ran trip_numbers 1, 2 and 3; the invoice shows the first.
check('lowest trip_number wins', inv.days[0].lines[1].tripId, '1274895');

console.log('\n4. a TONU prints the word, not a Trip ID');
/*
 * Driven by the SHIFT's tonu flag, not by the absence of a trip. Shift 4 is
 * a TONU that happens to have a route row; a shift with no route entered yet
 * is a different thing and must not be labelled TONU.
 */
check('TONU replaces the trip id', inv.days[1].lines[0].tripId, 'TONU');
check('and it keeps its real money', inv.days[1].lines[0].amount, 250);

console.log('\n5. the PRO # comes from Accounting');
// The Aljex # of the first detail line -- first day, first driver.
check('first line\'s Aljex #', inv.proNumber, '1958081');

console.log('\n6. the query cannot quietly include deleted or other locations');
const f = fetcher(ROWS);
await api.buildInvoiceData(f, ARGS);
const acct = f.calls.find((c) => c.table === 'loads_accounting');
check('accounting is filtered to the location', acct.filters['eq:location'], 'atlanta');
check('to the week', [acct.filters['gte:shift_date'], acct.filters['lte:shift_date']], ['2026-08-17', '2026-08-23']);
check('and excludes deleted records', acct.filters['neq:status'], 'deleted');
check('it never reads total_cost', /total_cost/.test(acct.columns), false);
check('it bills total_revenue', /total_revenue/.test(acct.columns), true);

console.log('\n7. a failed read stops the invoice, it does not shorten it');
/*
 * The page's own fetchAllRows() swallows a failed page and returns what it
 * had, which is right for a dashboard and catastrophic for a bill: the
 * invoice would be short by a day's drivers and every total on it would
 * still agree with itself.
 */
let thrown = '';
try { await api.buildInvoiceData(fetcher(ROWS, { fail: 'loads_trips' }), ARGS); } catch (e) { thrown = e.message; }
check('a trips failure throws', /loads_trips/.test(thrown), true);
let emptyWeek = '';
try { await api.buildInvoiceData(fetcher({ loads_accounting: [] }), ARGS); } catch (e) { emptyWeek = e.message; }
check('a week with nothing billable throws', /No billable loads/.test(emptyWeek), true);

console.log('\n8. dates');
check('Net 30', inv.dueDate, '2026-11-15');
check('invoice date is passed through', inv.invoiceDate, '2026-10-16');
// Mondays, because the approved detail page is headed "Monday 8/17/26".
check('a Monday is its own week start', api.weekStart('2026-08-17'), '2026-08-17');
check('a Sunday belongs to the week before it', api.weekStart('2026-08-23'), '2026-08-17');
check('a Wednesday snaps back', api.weekStart('2026-08-19'), '2026-08-17');
check('the last completed week, asked on a Tuesday',
  api.lastCompletedWeek('2026-08-25'), { startDate: '2026-08-17', endDate: '2026-08-23' });
check('month boundaries do not slip', api.addDays('2026-12-31', 1), '2027-01-01');
check('nor do leap days', api.addDays('2028-02-28', 1), '2028-02-29');

console.log('\n9. the customer block is the approved one');
const atl = api.INVOICE_LOCATIONS.atlanta;
check('code', atl.code, 'ATL');
check('place', atl.place, 'Forest Park, GA');
check('customer', atl.customer, ['Kroger/BGDC', 'Kourtnie.Ramey@Kroger.com', '2000 Anvil Block Road, BLDG A Forest Park, GA 30297']);
check('pick up and consignee are both BGDC', [atl.pickUp[0], atl.consignee[0]], ['BGDC', 'BGDC']);
check('no other board has an invoice format', Object.keys(api.INVOICE_LOCATIONS), ['atlanta']);
let wrongBoard = '';
try { await api.buildInvoiceData(fetcher(ROWS), { ...ARGS, location: 'delaware' }); } catch (e) { wrongBoard = e.message; }
check('asking for one is refused', /no invoice format for delaware/.test(wrongBoard), true);

console.log('\n10. money is summed in cents');
// 0.1 + 0.2 is 0.30000000000000004; three of those is how an invoice ends up
// a cent away from the sum of its own pages.
const pennies = await api.buildInvoiceData(fetcher({
  loads_accounting: [
    { shift_date: '2026-08-17', source_shift_id: 1, total_revenue: '0.10', driver_name_text: 'A', aljex_load_number: '1' },
    { shift_date: '2026-08-17', source_shift_id: 1, total_revenue: '0.20', driver_name_text: 'B', aljex_load_number: '2' },
  ],
  loads_shifts: [{ id: 1, tonu: false }],
  loads_trips: [],
}), ARGS);
check('subtotal', pennies.days[0].subtotal, 0.3);
check('total', pennies.total, 0.3);

console.log(failures ? `\n${failures} failing check(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
