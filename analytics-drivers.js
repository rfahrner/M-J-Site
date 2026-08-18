/* ================================================================
   Driver Analytics — a new, fully separate page/module, not woven
   into loadboard.js's own logic. Everything here is computed live
   from loads_shifts/loads_trips (plus driver_notes and the new
   called_off columns) for a selectable trailing window — nothing is
   a separately-maintained analytics table that could drift out of
   sync with the real board data.

   Scope for this first version: Atlanta, Building C, and Delaware,
   since those three share loads_shifts/loads_trips. Houston and
   Mondelez run on their own separate tables (loads_houston,
   mondelez_loads) and aren't included yet — a natural follow-up,
   not an oversight.

   "Average route pull" is defined (per Ron, in chat) as routes per
   shift specifically in Atlanta — so that one column is always
   computed from a driver's Atlanta activity only, regardless of
   which location tab is currently selected.
   ================================================================ */
import {
  state, supabaseClient, escapeHtml, $, $all, on, dateKey, addDays, todayDate,
  SHIFTS_TABLE, TRIPS_TABLE, setDriverSyncStatus, openAddDriverModal, openEditDriverModal,
  findDriver,
} from './loadboard.js';

const DA_LOCATIONS = [
  { key: 'atlanta', label: 'Atlanta' },
  { key: 'buildingc', label: 'Building C' },
  { key: 'delaware', label: 'Delaware' },
  { key: 'all', label: 'All (Atlanta + Building C + Delaware)' },
];

const daState = {
  rangeDays: 30,
  activeTab: 'atlanta',
  drivers: [],          // full roster, from atlanta_drivers
  shifts: [],           // raw shifts in the current window
  tripsByShiftId: {},   // shift.id -> [trip rows]
  notesCountByDriverId: {},
  holidayDates: new Set(),
  loaded: false,
};

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function loadFullDriverRoster() {
  const PAGE_SIZE = 1000;
  let all = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabaseClient.from('atlanta_drivers').select('*').range(from, from + PAGE_SIZE - 1);
    if (error) { console.error('Failed to load driver roster:', error); setDriverSyncStatus(`Couldn't load drivers (${error.message}).`, 'error'); return []; }
    all = all.concat(data || []);
    if (!data || data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return all;
}

async function loadWindowData(rangeStart) {
  const { data: shifts, error: shiftErr } = await supabaseClient
    .from(SHIFTS_TABLE).select('id, location, shift_date, driver_id, tonu, called_off, called_off_reason, shift_complete')
    .in('location', ['atlanta', 'buildingc', 'delaware'])
    .gte('shift_date', rangeStart)
    .not('driver_id', 'is', null);
  if (shiftErr) { console.error('Failed to load shifts:', shiftErr); setDriverSyncStatus(`Couldn't load shift data (${shiftErr.message}).`, 'error'); return { shifts: [], tripsByShiftId: {} }; }

  const shiftIds = (shifts || []).map((s) => s.id);
  const tripsByShiftId = {};
  const CHUNK_SIZE = 150;
  for (const idChunk of chunk(shiftIds, CHUNK_SIZE)) {
    const { data: trips, error: tripErr } = await supabaseClient.from(TRIPS_TABLE).select('shift_id, route_id, trip_id, route_miles').in('shift_id', idChunk);
    if (tripErr) { console.error('Failed to load trips (chunk):', tripErr); continue; }
    (trips || []).forEach((t) => {
      if (!tripsByShiftId[t.shift_id]) tripsByShiftId[t.shift_id] = [];
      tripsByShiftId[t.shift_id].push(t);
    });
  }
  return { shifts: shifts || [], tripsByShiftId };
}

async function loadNotesCounts() {
  const { data, error } = await supabaseClient.from('driver_notes').select('driver_id');
  if (error) { console.error('Failed to load driver notes counts:', error); return {}; }
  const counts = {};
  (data || []).forEach((n) => { counts[n.driver_id] = (counts[n.driver_id] || 0) + 1; });
  return counts;
}

async function loadHolidayDates() {
  const { data, error } = await supabaseClient.from('company_holidays').select('holiday_date');
  if (error) { console.error('Failed to load company_holidays:', error); return new Set(); }
  return new Set((data || []).map((h) => h.holiday_date));
}

function realTripsFor(shiftId) {
  const trips = daState.tripsByShiftId[shiftId] || [];
  return trips.filter((t) => (t.route_id && String(t.route_id).trim()) || (t.trip_id && String(t.trip_id).trim()));
}

// Core aggregation — one pass over the loaded window, grouped by driver_id.
// Atlanta-only "pull" is computed separately from the location-filtered
// view, since that metric is defined specifically against Atlanta
// activity regardless of which tab is currently selected.
function computeDriverStats() {
  const inScopeShifts = daState.shifts.filter((s) => daState.activeTab === 'all' || s.location === daState.activeTab);
  const byDriver = {};

  function bucket(driverId) {
    if (!byDriver[driverId]) {
      byDriver[driverId] = {
        driverId, shiftCount: 0, routeCount: 0, totalMiles: 0, milesSamples: 0,
        tonuCount: 0, calledOffCount: 0, calledOffReasons: {}, holidayDays: new Set(),
        atlantaShiftCount: 0, atlantaRouteCount: 0,
      };
    }
    return byDriver[driverId];
  }

  daState.shifts.forEach((s) => {
    if (s.location === 'atlanta') {
      const b = bucket(s.driver_id);
      b.atlantaShiftCount += 1;
      b.atlantaRouteCount += realTripsFor(s.id).length;
    }
  });

  inScopeShifts.forEach((s) => {
    const b = bucket(s.driver_id);
    b.shiftCount += 1;
    if (s.tonu) b.tonuCount += 1;
    if (s.called_off) {
      b.calledOffCount += 1;
      const reason = s.called_off_reason || 'unspecified';
      b.calledOffReasons[reason] = (b.calledOffReasons[reason] || 0) + 1;
    }
    const hasRealActivity = s.shift_complete || realTripsFor(s.id).length > 0;
    if (hasRealActivity && daState.holidayDates.has(s.shift_date)) b.holidayDays.add(s.shift_date);
    realTripsFor(s.id).forEach((t) => {
      b.routeCount += 1;
      if (t.route_miles != null) { b.totalMiles += Number(t.route_miles) || 0; b.milesSamples += 1; }
    });
  });

  return byDriver;
}

function renderTable() {
  const table = $('#da-table');
  if (!table) return;
  const stats = computeDriverStats();
  const rows = daState.drivers.map((d) => {
    const s = stats[d.id] || { shiftCount: 0, routeCount: 0, totalMiles: 0, milesSamples: 0, tonuCount: 0, calledOffCount: 0, calledOffReasons: {}, holidayDays: new Set(), atlantaShiftCount: 0, atlantaRouteCount: 0 };
    return { driver: d, stats: s };
  }).filter((r) => r.stats.shiftCount > 0 || daState.activeTab === 'all');
  rows.sort((a, b) => b.stats.shiftCount - a.stats.shiftCount);

  const thead = `<thead><tr>
    <th></th>
    <th>Driver</th>
    <th>Shifts</th>
    <th>Routes</th>
    <th>Avg Route Miles</th>
    <th>Avg Routes/Shift (Atlanta pull)</th>
    <th>TONU</th>
    <th>Called Off</th>
    <th>Holiday Days Ran</th>
    <th>Notes</th>
  </tr></thead>`;

  const bodyRows = rows.map(({ driver, stats: s }) => {
    const avgMiles = s.milesSamples ? (s.totalMiles / s.milesSamples).toFixed(1) : '—';
    const pull = s.atlantaShiftCount ? (s.atlantaRouteCount / s.atlantaShiftCount).toFixed(2) : '—';
    const notesCount = daState.notesCountByDriverId[driver.id] || 0;
    const calledOffTitle = Object.entries(s.calledOffReasons).map(([r, c]) => `${r.replace('_', ' ')}: ${c}`).join(', ') || 'none';
    return `<tr>
      <td><button type="button" class="cell-link-btn" data-action="open-driver-profile" data-driver-id="${driver.id}" title="Open driver profile">↗</button></td>
      <td>${escapeHtml(driver.name)}</td>
      <td>${s.shiftCount}</td>
      <td>${s.routeCount}</td>
      <td>${avgMiles}</td>
      <td>${pull}</td>
      <td>${s.tonuCount || '—'}</td>
      <td title="${escapeHtml(calledOffTitle)}">${s.calledOffCount || '—'}</td>
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
  const [{ shifts, tripsByShiftId }, notesCounts, holidayDates] = await Promise.all([
    loadWindowData(rangeStart),
    loadNotesCounts(),
    loadHolidayDates(),
  ]);
  daState.shifts = shifts;
  daState.tripsByShiftId = tripsByShiftId;
  daState.notesCountByDriverId = notesCounts;
  daState.holidayDates = holidayDates;
  daState.loaded = true;
  setDriverSyncStatus('');
  renderTable();
}

export async function initDriverAnalyticsPage() {
  if (!supabaseClient) { setDriverSyncStatus("Supabase didn't load on this page.", 'error'); return; }
  daState.drivers = await loadFullDriverRoster();
  renderTabs();
  await reloadWindow();

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