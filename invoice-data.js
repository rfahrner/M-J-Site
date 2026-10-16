/* ================================================================
   What goes on the weekly Kroger/BGDC invoice.

   Every rule below was derived by reproducing the approved sample
   (8/17/26 - 8/23/26, PRO 1958081, $54,348.30) out of live data and
   checking all 48 driver lines against it, not by reading code:

   - A LINE IS AN ACCOUNTING ROW, not a shift and not a trip. The money is
     loads_accounting.total_revenue, which is the customer side; total_cost
     is what D&L pays the carrier and must never reach an invoice.

   - ZERO-REVENUE ROWS ARE DROPPED. The sample's 8/22 has nine accounting
     rows and bills eight drivers: "Norman Allen-Pick Up" carries $0.00 and
     no Aljex #, and the invoice omits the line rather than printing a
     $0.00 charge and counting a ninth unit.

   - THE NAME COMES FROM THE ACCOUNTING ROW. Shift 15904 on 2026-08-17 has
     a null driver_name_text and only a driver_id, while its accounting row
     carries the "Atiba Ward" the invoice prints. Reading the shift would
     have blanked that line.

   - THE TRIP ID IS THE DRIVER'S FIRST TRIP OF THE DAY -- lowest
     trip_number on the source shift. Drivers routinely run more; the
     invoice shows the first only.

   - A TONU PRINTS THE WORD "TONU" where the Trip ID goes. Those rows carry
     real money ($250.00 in the sample) and no trips at all, so the
     substitution is driven by the shift's tonu flag rather than by the
     absence of a trip -- a shift with no route entered yet is a different
     thing and must not be mislabelled as a TONU.

   - DAYS WITH NOTHING ARE ABSENT. The sample week has no 8/19 or 8/21
     page and no 8/19 or 8/21 line.

   - THE PRO # IS THE Aljex # OF THE FIRST DETAIL LINE, which is the first
     day's alphabetically first driver. On the sample that is Atiba Ward's
     1958081, which is also the lowest Aljex # in the week.

   Sorting is by day, then driver name, and the subtotal of each day is the
   sum of its lines. `days` is what both the cover's description table and
   the per-day detail pages are built from, so the two cannot disagree.

   This module takes the Supabase client as an ARGUMENT and imports nothing
   from loadboard.js -- the same reason archive-image-urls.js is a leaf.
   ================================================================ */

export const INVOICE_LOCATIONS = {
  atlanta: {
    code: 'ATL',
    place: 'Forest Park, GA',
    customer: ['Kroger/BGDC', 'Kourtnie.Ramey@Kroger.com', '2000 Anvil Block Road, BLDG A Forest Park, GA 30297'],
    pickUp: ['BGDC', '2000 Anvil Block Road', 'Forest Park, GA'],
    consignee: ['BGDC', '2000 Anvil Block Road', 'Forest Park, GA'],
    remitTo: ['Kroger/BGDC', 'Kourtnie.Ramey@Kroger.com', '2000 Anvil Block Road, BLDG A', 'Forest Park, GA 30297'],
  },
};

const clean = (value) => String(value ?? '').trim();

/*
 * Net 30, counted in whole days off the invoice date. The sample is dated
 * 10/16/26 and due 11/15/26. Built in UTC on purpose: a Date made from a
 * plain 'YYYY-MM-DD' is UTC midnight, which is the previous evening in New
 * York, so local-time arithmetic here would date some invoices a day early.
 */
export function addDays(iso, days) {
  const [y, m, d] = String(iso).split('-').map(Number);
  const at = new Date(Date.UTC(y, m - 1, d + days));
  return at.toISOString().slice(0, 10);
}

// The Monday of the week containing `iso`. Invoices run Monday to Sunday --
// the sample's first detail page is headed "Monday 8/17/26".
export function weekStart(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  const at = new Date(Date.UTC(y, m - 1, d));
  return addDays(iso, -((at.getUTCDay() + 6) % 7));
}

// The most recent Monday-Sunday week that has fully finished.
export function lastCompletedWeek(todayIso) {
  const end = addDays(weekStart(todayIso), -1);
  return { startDate: addDays(end, -6), endDate: end };
}

/*
 * Reads one week and returns the object invoice-pdf.js draws, or throws with
 * something a dispatcher can act on. `fetchRows(table, columns, applyFilters)`
 * is the page's own paged reader, so this inherits its 1,000-row paging and
 * its error reporting rather than keeping a second copy of them.
 */
export async function buildInvoiceData(fetchRows, { location, startDate, endDate, invoiceDate }) {
  const place = INVOICE_LOCATIONS[location];
  if (!place) throw new Error(`There is no invoice format for ${location}.`);

  const accounting = await fetchRows(
    'loads_accounting',
    'shift_date, source_shift_id, total_revenue, driver_name_text, aljex_load_number',
    // status is NOT NULL with a default, which is the only reason a plain neq
    // is safe here; on a nullable column it would drop every null row too.
    (q) => q.eq('location', location).gte('shift_date', startDate).lte('shift_date', endDate)
            .neq('status', 'deleted'),
  );

  const billable = accounting.filter((row) => Number(row.total_revenue) !== 0);
  if (!billable.length) throw new Error(`No billable loads between ${startDate} and ${endDate}.`);

  const shiftIds = [...new Set(billable.map((r) => r.source_shift_id).filter((id) => id != null))];
  const shifts = shiftIds.length
    ? await fetchRows('loads_shifts', 'id, tonu', (q) => q.in('id', shiftIds))
    : [];
  const tonuById = new Map(shifts.map((s) => [String(s.id), !!s.tonu]));

  const trips = shiftIds.length
    ? await fetchRows('loads_trips', 'shift_id, trip_id, trip_number', (q) => q.in('shift_id', shiftIds))
    : [];
  // Lowest trip_number wins. Archived rows have no trip_number (see the
  // migration), so they sort last rather than ahead of a real first trip.
  const firstTrip = new Map();
  for (const trip of trips) {
    if (!clean(trip.trip_id)) continue;
    const key = String(trip.shift_id);
    const held = firstTrip.get(key);
    const order = trip.trip_number == null ? Number.MAX_SAFE_INTEGER : Number(trip.trip_number);
    if (!held || order < held.order) firstTrip.set(key, { order, tripId: clean(trip.trip_id) });
  }

  const byDay = new Map();
  for (const row of billable) {
    const day = row.shift_date;
    if (!byDay.has(day)) byDay.set(day, []);
    const shiftKey = String(row.source_shift_id);
    byDay.get(day).push({
      driver: clean(row.driver_name_text) || 'Driver',
      tripId: tonuById.get(shiftKey) ? 'TONU' : (firstTrip.get(shiftKey)?.tripId || ''),
      amount: Number(row.total_revenue) || 0,
      aljex: clean(row.aljex_load_number),
    });
  }

  const days = [...byDay.keys()].sort().map((date) => {
    const lines = byDay.get(date).sort((a, b) => a.driver.localeCompare(b.driver, 'en'));
    return { date, lines, subtotal: round2(lines.reduce((sum, l) => sum + l.amount, 0)) };
  });

  // The PRO is the Aljex # of the very first detail line -- first day, first
  // driver -- which on the approved sample is Atiba Ward's 1958081.
  const proNumber = days[0].lines.find((l) => l.aljex)?.aljex || '';

  return {
    proNumber,
    startDate,
    endDate,
    invoiceDate,
    dueDate: addDays(invoiceDate, 30),
    locationCode: place.code,
    locationPlace: place.place,
    customer: place.customer,
    pickUp: place.pickUp,
    consignee: place.consignee,
    remitTo: place.remitTo,
    days,
    total: round2(days.reduce((sum, d) => sum + d.subtotal, 0)),
  };
}

// Money is summed in cents. Adding 48 floats and formatting the result is how
// an invoice ends up a cent away from the sum of its own pages.
function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

// 8-17-26_to_8-23-26_Kroger_Invoice.pdf -- the name on the approved sample.
export function invoiceFileName(startDate, endDate) {
  const part = (iso) => {
    const [y, m, d] = String(iso).split('-').map(Number);
    return `${m}-${d}-${String(y).slice(2)}`;
  };
  return `${part(startDate)}_to_${part(endDate)}_Kroger_Invoice.pdf`;
}
