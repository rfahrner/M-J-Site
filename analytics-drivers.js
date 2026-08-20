/* ================================================================
   Driver Analytics — its own entity, not woven into loadboard.js's
   own logic. Everything here is computed live from real shift/load
   data (plus driver_notes and the called_off columns) rather than a
   separately-maintained analytics table that could drift out of sync.

   Covers Atlanta, Building C, Delaware (share loads_shifts/loads_trips),
   plus Houston (loads_houston) and Mondelez (mondelez_loads), both flat
   one-row-per-load tables with their own aggregation path merged into
   the same per-driver stats.

   Known gap, worth knowing rather than pretending otherwise: the
   called_off columns only exist on loads_shifts today, and the
   Cancellation action only lives on the board pages that share
   loadboard.js's context menu (Atlanta/Building C/Delaware). Houston
   and Mondelez have no way to mark a cancellation yet, so their
   Cancellations column always reads "—" — not broken, just not built.
   Houston also has no miles field on its table at all, so its Avg
   Route Mi is always "—" too, for the same reason.

   "Average route pull" is defined (per Ron, in chat) as routes per
   shift specifically in Atlanta — that column is always computed
   from a driver's Atlanta activity only, regardless of which
   location tab is currently selected.
   ================================================================ */
import {
  supabaseClient, escapeHtml, $, on, dateKey, addDays, todayDate,
  SHIFTS_TABLE, TRIPS_TABLE, setDriverSyncStatus, openAddDriverModal, openEditDriverModal,
  driverFromDbRow,
} from './loadboard.js';

const HOUSTON_TABLE = 'loads_houston';
const MONDELEZ_TABLE = 'mondelez_loads';

const DA_LOCATIONS = [
  { key: 'atlanta', label: 'Atlanta' },
  { key: 'buildingc', label: 'Building C' },
  { key: 'delaware', label: 'Delaware' },
  { key: 'houston', label: 'Houston' },
  { key: 'mondelez', label: 'Mondelez' },
  { key: 'all', label: 'All Locations' },
];

const daState = {
  rangeDays: 30,
  activeTab: 'atlanta',
  drivers: [],            // full roster, mapped through the same driverFromDbRow() every other page uses
  shifts: [],              // loads_shifts rows in the current window (atlanta/buildingc/delaware)
  tripsByShiftId: {},      // shift.id -> [trip rows]
  houstonRows: [],         // loads_houston rows in the current window
  mondelezRows: [],        // mondelez_loads rows in the current window
  notesCountByDriverId: {},
  holidayDates: new Set(),
  allTimeByDriverId: {},   // { shiftsWorked, routesPulled } -- unbounded, all locations, all time
};

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Every query in this file needs this — Supabase silently caps an
// unbounded .select() at a default row limit. A windowed query might
// stay under that cap by luck while an all-time query quietly doesn't,
// which is exactly the bug that produced an all-time total lower than
// a 60-day windowed count. Paginating everything through here removes
// that risk instead of hoping each individual query happens to stay small.
async function fetchAllRows(table, columns, applyFilters) {
  const PAGE_SIZE = 1000;
  let all = [];
  let from = 0;
  while (true) {
    let q = supabaseClient.from(table).select(columns).range(from, from + PAGE_SIZE - 1);
    if (applyFilters) q = applyFilters(q);
    const { data, error } = await q;
    if (error) { console.error(`Failed to load ${table}:`, error); return all; }
    all = all.concat(data || []);
    if (!data || data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return all;
}

async function loadFullDriverRoster() {
  const rows = await fetchAllRows('atlanta_drivers', '*');
  return rows.map(driverFromDbRow); // same mapping every other page relies on -- raw rows use "Driver Name" etc, not .name
}

async function loadWindowData(rangeStart) {
  const shifts = await fetchAllRows(
    SHIFTS_TABLE,
    'id, location, shift_date, driver_id, tonu, called_off, called_off_reason, shift_complete',
    (q) => q.in('location', ['atlanta', 'buildingc', 'delaware']).gte('shift_date', rangeStart).not('driver_id', 'is', null)
  );

  const shiftIds = shifts.map((s) => s.id);
  const tripsByShiftId = {};
  for (const idChunk of chunk(shiftIds, 150)) {
    const { data: trips, error: tripErr } = await supabaseClient.from(TRIPS_TABLE).select('shift_id, route_id, trip_id, route_miles').in('shift_id', idChunk);
    if (tripErr) { console.error('Failed to load trips (chunk):', tripErr); continue; }
    (trips || []).forEach((t) => {
      if (!tripsByShiftId[t.shift_id]) tripsByShiftId[t.shift_id] = [];
      tripsByShiftId[t.shift_id].push(t);
    });
  }
  return { shifts, tripsByShiftId };
}

async function loadHoustonWindow(rangeStart) {
  return fetchAllRows(
    HOUSTON_TABLE, 'id, shift_date, driver_id, aljex_number, tonu, shift_complete',
    (q) => q.gte('shift_date', rangeStart).not('driver_id', 'is', null)
  );
}

async function loadMondelezWindow(rangeStart) {
  return fetchAllRows(
    MONDELEZ_TABLE, 'id, shift_date, driver_id, aljex_number, miles, tonu, shift_complete',
    (q) => q.gte('shift_date', rangeStart).not('driver_id', 'is', null)
  );
}

async function loadNotesCounts() {
  const rows = await fetchAllRows('driver_notes', 'driver_id');
  const counts = {};
  rows.forEach((n) => { counts[n.driver_id] = (counts[n.driver_id] || 0) + 1; });
  return counts;
}

async function loadHolidayDates() {
  const { data, error } = await supabaseClient.from('company_holidays').select('holiday_date');
  if (error) { console.error('Failed to load company_holidays:', error); return new Set(); }
  return new Set((data || []).map((h) => h.holiday_date));
}

// All-time totals ("Total Routes Pulled" / "Total Shifts Worked") --
// deliberately unbounded by the date-range selector, since these are
// meant to be career totals, not scoped to the analytics window. Kept
// lightweight (2-3 skinny columns, no full row fetch) so this stays
// workable regardless of how much history accumulates, same reasoning
// as every other unbounded-query fix this session.
async function loadAllTimeTotals() {
  const totals = {};
  const bump = (driverId, shifts, routes, cancellations) => {
    if (driverId == null) return;
    if (!totals[driverId]) totals[driverId] = { shiftsWorked: 0, routesPulled: 0, cancellations: 0 };
    totals[driverId].shiftsWorked += shifts;
    totals[driverId].routesPulled += routes;
    totals[driverId].cancellations += (cancellations || 0);
  };

  const allShifts = await fetchAllRows(SHIFTS_TABLE, 'id, driver_id, called_off', (q) => q.not('driver_id', 'is', null));
  const shiftIds = allShifts.map((s) => s.id);
  const routeCountByShiftId = {};
  for (const idChunk of chunk(shiftIds, 150)) {
    const { data: trips, error: tripErr } = await supabaseClient.from(TRIPS_TABLE).select('shift_id, route_id, trip_id').in('shift_id', idChunk);
    if (tripErr) { console.error('Failed to load all-time trips (chunk):', tripErr); continue; }
    (trips || []).forEach((t) => {
      const isReal = (t.route_id && String(t.route_id).trim()) || (t.trip_id && String(t.trip_id).trim());
      if (!isReal) return;
      routeCountByShiftId[t.shift_id] = (routeCountByShiftId[t.shift_id] || 0) + 1;
    });
  }
  allShifts.forEach((s) => bump(s.driver_id, 1, routeCountByShiftId[s.id] || 0, s.called_off ? 1 : 0));

  // Houston/Mondelez don't have a called_off column at all yet, so they
  // always contribute 0 cancellations — same known gap as the windowed view.
  const houstonAll = await fetchAllRows(HOUSTON_TABLE, 'driver_id, aljex_number', (q) => q.not('driver_id', 'is', null));
  houstonAll.forEach((r) => { const real = r.aljex_number && String(r.aljex_number).trim(); bump(r.driver_id, 1, real ? 1 : 0, 0); });

  const mdzAll = await fetchAllRows(MONDELEZ_TABLE, 'driver_id, aljex_number', (q) => q.not('driver_id', 'is', null));
  mdzAll.forEach((r) => { const real = r.aljex_number && String(r.aljex_number).trim(); bump(r.driver_id, 1, real ? 1 : 0, 0); });

  return totals;
}

function realTripsFor(shiftId) {
  const trips = daState.tripsByShiftId[shiftId] || [];
  return trips.filter((t) => (t.route_id && String(t.route_id).trim()) || (t.trip_id && String(t.trip_id).trim()));
}

// Core aggregation for the currently-selected window/tab. Atlanta-only
// "pull" is always computed from Atlanta activity specifically,
// independent of whichever tab is currently selected.
function computeDriverStats() {
  const byDriver = {};
  function bucket(driverId) {
    if (!byDriver[driverId]) {
      byDriver[driverId] = {
        shiftCount: 0, routeCount: 0, totalMiles: 0, milesSamples: 0,
        tonuCount: 0, cancellationCount: 0, cancellationReasons: [],
        holidayDays: new Set(), atlantaShiftCount: 0, atlantaRouteCount: 0,
      };
    }
    return byDriver[driverId];
  }

  // Atlanta-only pull, independent of the active tab.
  daState.shifts.forEach((s) => {
    if (s.location === 'atlanta') {
      const b = bucket(s.driver_id);
      b.atlantaShiftCount += 1;
      b.atlantaRouteCount += realTripsFor(s.id).length;
    }
  });

  const wantAll = daState.activeTab === 'all';
  const inScopeShifts = daState.shifts.filter((s) => wantAll || s.location === daState.activeTab);
  inScopeShifts.forEach((s) => {
    const b = bucket(s.driver_id);
    b.shiftCount += 1;
    if (s.tonu) b.tonuCount += 1;
    if (s.called_off) { b.cancellationCount += 1; if (s.called_off_reason) b.cancellationReasons.push(s.called_off_reason); }
    const hasRealActivity = s.shift_complete || realTripsFor(s.id).length > 0;
    if (hasRealActivity && daState.holidayDates.has(s.shift_date)) b.holidayDays.add(s.shift_date);
    realTripsFor(s.id).forEach((t) => {
      b.routeCount += 1;
      if (t.route_miles != null) { b.totalMiles += Number(t.route_miles) || 0; b.milesSamples += 1; }
    });
  });

  if (wantAll || daState.activeTab === 'houston') {
    daState.houstonRows.forEach((r) => {
      const b = bucket(r.driver_id);
      b.shiftCount += 1;
      if (r.tonu) b.tonuCount += 1;
      const isReal = r.aljex_number && String(r.aljex_number).trim();
      if (isReal) b.routeCount += 1; // Houston is flat -- one row is one shift AND one route together
      // No miles field exists on loads_houston at all -- Avg Route Mi
      // stays "—" for these rows on purpose, not a bug.
      if ((r.shift_complete || isReal) && daState.holidayDates.has(r.shift_date)) b.holidayDays.add(r.shift_date);
    });
  }

  if (wantAll || daState.activeTab === 'mondelez') {
    daState.mondelezRows.forEach((r) => {
      const b = bucket(r.driver_id);
      b.shiftCount += 1;
      if (r.tonu) b.tonuCount += 1;
      const isReal = r.aljex_number && String(r.aljex_number).trim();
      if (isReal) b.routeCount += 1;
      if (r.miles != null) { b.totalMiles += Number(r.miles) || 0; b.milesSamples += 1; }
      if ((r.shift_complete || isReal) && daState.holidayDates.has(r.shift_date)) b.holidayDays.add(r.shift_date);
    });
  }

  return byDriver;
}

function renderTable() {
  const table = $('#da-table');
  if (!table) return;
  const stats = computeDriverStats();
  const noCancellationTracking = daState.activeTab === 'houston' || daState.activeTab === 'mondelez';
  const rows = daState.drivers.map((d) => ({
    driver: d,
    stats: stats[d.id] || { shiftCount: 0, routeCount: 0, totalMiles: 0, milesSamples: 0, tonuCount: 0, cancellationCount: 0, cancellationReasons: [], holidayDays: new Set(), atlantaShiftCount: 0, atlantaRouteCount: 0 },
    allTime: daState.allTimeByDriverId[d.id] || { shiftsWorked: 0, routesPulled: 0, cancellations: 0 },
  })).filter((r) => r.stats.shiftCount > 0);
  rows.sort((a, b) => b.stats.shiftCount - a.stats.shiftCount);

  const thead = `<thead><tr>
    <th></th>
    <th>Driver</th>
    <th>Shifts (window)</th>
    <th>Cancellations (window)</th>
    <th>Total Cancellations</th>
    <th>Routes (window)</th>
    <th>Total Shifts Worked</th>
    <th>Total Routes Pulled</th>
    <th>Avg Route Mi</th>
    <th>Avg Routes/Shift (Atlanta pull)</th>
    <th>TONU</th>
    <th>Holiday Days Ran</th>
    <th>Notes</th>
  </tr></thead>`;

  const bodyRows = rows.map(({ driver, stats: s, allTime }) => {
    const avgMiles = s.milesSamples ? (s.totalMiles / s.milesSamples).toFixed(1) : '—';
    const pull = s.atlantaShiftCount ? (s.atlantaRouteCount / s.atlantaShiftCount).toFixed(2) : '—';
    const notesCount = daState.notesCountByDriverId[driver.id] || 0;
    const cancellationTitle = s.cancellationReasons.length ? s.cancellationReasons.join(' | ') : 'none';
    return `<tr>
      <td><button type="button" class="cell-link-btn" data-action="open-driver-profile" data-driver-id="${driver.id}" title="Open driver profile">↗</button></td>
      <td>${escapeHtml(driver.name)}</td>
      <td>${s.shiftCount}</td>
      <td title="${escapeHtml(cancellationTitle)}">${noCancellationTracking ? '—' : (s.cancellationCount || '—')}</td>
      <td>${allTime.cancellations || '—'}</td>
      <td>${s.routeCount}</td>
      <td>${allTime.shiftsWorked || '—'}</td>
      <td>${allTime.routesPulled || '—'}</td>
      <td>${avgMiles}</td>
      <td>${pull}</td>
      <td>${s.tonuCount || '—'}</td>
      <td>${s.holidayDays.size || '—'}</td>
      <td>${notesCount || '—'}</td>
    </tr>`;
  }).join('');

  table.innerHTML = thead + `<tbody>${bodyRows}</tbody>`;
  const emptyState = $('#da-empty-state');
  if (emptyState) emptyState.classList.toggle('hidden', rows.length > 0);
}

function renderTabs() {
  const wrap = $('#da-location-tabs');
  if (!wrap) return;
  wrap.innerHTML = DA_LOCATIONS.map((l) => `<button type="button" class="location-tab ${daState.activeTab === l.key ? 'is-active' : ''}" data-da-tab="${l.key}">${escapeHtml(l.label)}</button>`).join('');
}

async function reloadWindow() {
  setDriverSyncStatus('Loading driver analytics…', 'loading');
  const rangeStart = dateKey(addDays(todayDate(), -daState.rangeDays));
  const [{ shifts, tripsByShiftId }, houstonRows, mondelezRows, notesCounts, holidayDates] = await Promise.all([
    loadWindowData(rangeStart),
    loadHoustonWindow(rangeStart),
    loadMondelezWindow(rangeStart),
    loadNotesCounts(),
    loadHolidayDates(),
  ]);
  daState.shifts = shifts;
  daState.tripsByShiftId = tripsByShiftId;
  daState.houstonRows = houstonRows;
  daState.mondelezRows = mondelezRows;
  daState.notesCountByDriverId = notesCounts;
  daState.holidayDates = holidayDates;
  setDriverSyncStatus('');
  renderTable();
}

export async function initDriverAnalyticsPage() {
  if (!supabaseClient) { setDriverSyncStatus("Supabase didn't load on this page.", 'error'); return; }
  daState.drivers = await loadFullDriverRoster();
  renderTabs();
  await reloadWindow();
  // All-time totals are independent of the window/tab selection, so this
  // loads once and doesn't need to re-run on every filter change.
  daState.allTimeByDriverId = await loadAllTimeTotals();
  renderTable();

  on('da-range-select', 'change', (e) => {
    daState.rangeDays = Number(e.target.value) || 30;
    reloadWindow();
  });

  const tabsWrap = $('#da-location-tabs');
  if (tabsWrap) tabsWrap.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-da-tab]');
    if (!btn) return;
    daState.activeTab = btn.dataset.daTab;
    renderTabs();
    renderTable();
  });

  const table = $('#da-table');
  if (table) table.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action="open-driver-profile"]');
    if (btn) openEditDriverModal(btn.dataset.driverId);
  });

  if ($('#btn-add-driver')) $('#btn-add-driver').addEventListener('click', () => openAddDriverModal(false));
}