/* ================================================================
   Location Analytics — its own entity, admin-only. Everything is
   computed live from loads_shifts/loads_trips/loads_accounting for a
   selected date range, rather than a separately-maintained recap
   table that could drift from the real data.

   Default field set (pre-checked in Send Recap) covers the core recap
   metrics from the reference email: Drivers, Mileage, Routes, Stops,
   Turn, Salvage, Backhauls. Everything else (TONU's, and the financial
   metrics pulled from the 2024 Miles sheet's own formulas — Revenue,
   Cost, Margin, GM%, Rev/mi, Rev/route, Rev/Driver, AVR LOH,
   Margin/Driver, Rev/stop, Margin/Route) is available to add, not
   included by default.

   Period = calendar quarter (Jan-Mar, Apr-Jun, Jul-Sep, Oct-Dec),
   1st of the current quarter through today.

   Financial figures come from loads_accounting, which today is
   populated for Atlanta. Houston/Mondelez track their own revenue on
   their own tables and aren't unified into these figures yet — a
   known, flagged gap, not an oversight.
   ================================================================ */
import {
  supabaseClient, escapeHtml, $, on, dateKey, addDays, todayDate,
  SHIFTS_TABLE, TRIPS_TABLE, ACCOUNTING_TABLE, setDriverSyncStatus, isAdminUser,
} from './loadboard.js';

const LA_LOCATIONS = [
  { key: 'atlanta', label: 'Atlanta' },
  { key: 'buildingc', label: 'Building C' },
  { key: 'delaware', label: 'Delaware' },
];

// category: 'default' fields are pre-checked in Send Recap (matches the
// reference email exactly); 'extra' fields are available to add but
// unchecked by default.
const FIELD_DEFS = [
  { key: 'drivers', label: 'Drivers', category: 'default' },
  { key: 'mileage', label: 'Mileage', category: 'default', fmt: (v) => v.toFixed(1) },
  { key: 'routes', label: 'Routes', category: 'default' },
  { key: 'stops', label: 'Stops', category: 'default' },
  { key: 'turn', label: 'Turn', category: 'default', fmt: (v) => v.toFixed(2) },
  { key: 'salvage', label: 'Salvage', category: 'default' },
  { key: 'backhauls', label: 'Backhauls', category: 'default' },
  { key: 'tonu', label: "TONU's", category: 'extra' },
  { key: 'revenue', label: 'Revenue', category: 'extra', fmt: (v) => `$${v.toFixed(2)}` },
  { key: 'cost', label: 'Cost', category: 'extra', fmt: (v) => `$${v.toFixed(2)}` },
  { key: 'margin', label: 'Margin', category: 'extra', fmt: (v) => `$${v.toFixed(2)}` },
  { key: 'gmPct', label: 'GM%', category: 'extra', fmt: (v) => `${v.toFixed(1)}%` },
  { key: 'revPerMile', label: 'Rev/mi', category: 'extra', fmt: (v) => `$${v.toFixed(2)}` },
  { key: 'revPerRoute', label: 'Rev/route', category: 'extra', fmt: (v) => `$${v.toFixed(2)}` },
  { key: 'revPerDriver', label: 'Rev/Driver', category: 'extra', fmt: (v) => `$${v.toFixed(2)}` },
  { key: 'avrLoh', label: 'AVR LOH', category: 'extra', fmt: (v) => v.toFixed(1) },
  { key: 'marginPerDriver', label: 'Margin/DR', category: 'extra', fmt: (v) => `$${v.toFixed(2)}` },
  { key: 'revPerStop', label: 'Rev/stop', category: 'extra', fmt: (v) => `$${v.toFixed(2)}` },
  { key: 'marginPerRoute', label: 'Margin/Route', category: 'extra', fmt: (v) => `$${v.toFixed(2)}` },
];

const laState = {
  activeTab: 'atlanta',
  rangeMode: 'daily',
  rangeStart: '',
  rangeEnd: '',
  recap: null,
  includedFields: new Set(FIELD_DEFS.filter((f) => f.category === 'default').map((f) => f.key)),
};

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

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

function computeRangeDates(mode) {
  const today = todayDate();
  if (mode === 'daily') return { start: dateKey(today), end: dateKey(today) };
  if (mode === 'weekly') return { start: dateKey(addDays(today, -6)), end: dateKey(today) };
  if (mode === 'period') {
    // A period is a calendar quarter: Jan-Mar, Apr-Jun, Jul-Sep, Oct-Dec.
    const quarterStartMonth = Math.floor(today.getMonth() / 3) * 3;
    const firstOfQuarter = new Date(today.getFullYear(), quarterStartMonth, 1);
    return { start: dateKey(firstOfQuarter), end: dateKey(today) };
  }
  return { start: laState.rangeStart || dateKey(today), end: laState.rangeEnd || dateKey(today) };
}

async function computeRecap(startDate, endDate, location) {
  const shifts = await fetchAllRows(
    SHIFTS_TABLE, 'id, shift_date, driver_id, tonu',
    (q) => q.eq('location', location).gte('shift_date', startDate).lte('shift_date', endDate)
  );
  const shiftIds = shifts.map((s) => s.id);

  let trips = [];
  for (const idChunk of chunk(shiftIds, 150)) {
    const { data, error } = await supabaseClient.from(TRIPS_TABLE).select('shift_id, route_id, trip_id, route_miles, stop_count, salvage, backhaul').in('shift_id', idChunk);
    if (error) { console.error('Failed to load trips (chunk):', error); continue; }
    trips = trips.concat(data || []);
  }
  const realTrips = trips.filter((t) => (t.route_id && String(t.route_id).trim()) || (t.trip_id && String(t.trip_id).trim()));

  const accountingRows = await fetchAllRows(
    ACCOUNTING_TABLE, 'total_cost, total_revenue',
    (q) => q.eq('location', location).gte('shift_date', startDate).lte('shift_date', endDate)
  );

  const distinctDrivers = new Set(shifts.filter((s) => s.driver_id != null).map((s) => s.driver_id)).size;
  const mileage = realTrips.reduce((sum, t) => sum + (Number(t.route_miles) || 0), 0);
  const routes = realTrips.length;
  const stops = realTrips.reduce((sum, t) => sum + (Number(t.stop_count) || 0), 0);
  const salvage = realTrips.filter((t) => t.salvage).length;
  const backhauls = realTrips.filter((t) => t.backhaul).length;
  const tonu = shifts.filter((s) => s.tonu).length;
  const revenue = accountingRows.reduce((sum, r) => sum + (Number(r.total_revenue) || 0), 0);
  const cost = accountingRows.reduce((sum, r) => sum + (Number(r.total_cost) || 0), 0);
  const margin = revenue - cost;

  return {
    drivers: distinctDrivers,
    mileage,
    routes,
    stops,
    turn: distinctDrivers ? routes / distinctDrivers : 0,
    salvage,
    backhauls,
    tonu,
    revenue,
    cost,
    margin,
    gmPct: revenue ? (margin / revenue) * 100 : 0,
    revPerMile: mileage ? revenue / mileage : 0,
    revPerRoute: routes ? revenue / routes : 0,
    revPerDriver: distinctDrivers ? revenue / distinctDrivers : 0,
    avrLoh: routes ? mileage / routes : 0,
    marginPerDriver: distinctDrivers ? margin / distinctDrivers : 0,
    revPerStop: stops ? revenue / stops : 0,
    marginPerRoute: routes ? margin / routes : 0,
  };
}

function fmtValue(def, value) {
  if (value == null) return '—';
  return def.fmt ? def.fmt(value) : String(value);
}

function renderTable() {
  const table = $('#la-table');
  if (!table || !laState.recap) return;
  const rows = FIELD_DEFS.map((def) => `<tr><td>${escapeHtml(def.label)}</td><td>${fmtValue(def, laState.recap[def.key])}</td></tr>`).join('');
  table.innerHTML = `<thead><tr><th>Metric</th><th>Value</th></tr></thead><tbody>${rows}</tbody>`;
  const emptyState = $('#la-empty-state');
  if (emptyState) emptyState.classList.toggle('hidden', laState.recap.routes > 0 || laState.recap.drivers > 0);
}

function renderRangeDisplay() {
  const el = $('#la-range-display');
  if (!el) return;
  el.textContent = laState.rangeStart === laState.rangeEnd
    ? `Showing ${laState.rangeStart}`
    : `Showing ${laState.rangeStart} through ${laState.rangeEnd}`;
  document.querySelectorAll('.la-range-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.laRange === laState.rangeMode));
  const customInputs = $('#la-custom-range-inputs');
  if (customInputs) customInputs.classList.toggle('hidden', laState.rangeMode !== 'custom');
}

function renderTabs() {
  const wrap = $('#la-location-tabs');
  if (!wrap) return;
  wrap.innerHTML = LA_LOCATIONS.map((l) => `<button type="button" class="location-tab ${laState.activeTab === l.key ? 'is-active' : ''}" data-la-tab="${l.key}">${escapeHtml(l.label)}</button>`).join('');
}

async function reload() {
  setDriverSyncStatus('Loading location analytics…', 'loading');
  const { start, end } = computeRangeDates(laState.rangeMode);
  laState.rangeStart = start;
  laState.rangeEnd = end;
  laState.recap = await computeRecap(start, end, laState.activeTab);
  setDriverSyncStatus('');
  renderRangeDisplay();
  renderTable();
}

/* ---------------- Send Recap modal ---------------- */

function renderFieldCheckboxes() {
  const wrap = $('#sr-field-checkboxes');
  if (!wrap) return;
  wrap.innerHTML = FIELD_DEFS.map((def) => `
    <label><input type="checkbox" class="sr-field-cb" value="${def.key}" ${laState.includedFields.has(def.key) ? 'checked' : ''}> ${escapeHtml(def.label)}</label>
  `).join('');
}

function buildRecapText() {
  const locLabel = (LA_LOCATIONS.find((l) => l.key === laState.activeTab) || {}).label || laState.activeTab;
  const rangeLabel = laState.rangeStart === laState.rangeEnd ? laState.rangeStart : `${laState.rangeStart} to ${laState.rangeEnd}`;
  const lines = [`${locLabel} Recap — ${rangeLabel}`, ''];
  FIELD_DEFS.filter((d) => laState.includedFields.has(d.key)).forEach((def) => {
    lines.push(`${def.label}: ${fmtValue(def, laState.recap ? laState.recap[def.key] : null)}`);
  });
  return lines.join('\n');
}

function renderRecapPreview() {
  const el = $('#sr-preview');
  if (!el) return;
  el.innerHTML = `<pre style="white-space:pre-wrap; margin:0; font-family:inherit;">${escapeHtml(buildRecapText())}</pre>`;
}

async function openSendRecapModal() {
  const overlay = $('#modal-send-recap');
  if (!overlay) return;
  overlay.classList.remove('hidden');
  const subjectInput = $('#sr-subject');
  const locLabel = (LA_LOCATIONS.find((l) => l.key === laState.activeTab) || {}).label || laState.activeTab;
  if (subjectInput) subjectInput.value = `${locLabel} Recap — ${laState.rangeStart === laState.rangeEnd ? laState.rangeStart : `${laState.rangeStart} to ${laState.rangeEnd}`}`;
  renderFieldCheckboxes();
  renderRecapPreview();
}

function closeSendRecapModal() {
  const overlay = $('#modal-send-recap');
  if (overlay) overlay.classList.add('hidden');
}

async function applySendRecapTimeframe(mode) {
  laState.rangeMode = mode;
  if (mode !== 'custom') {
    const { start, end } = computeRangeDates(mode);
    laState.rangeStart = start;
    laState.rangeEnd = end;
    laState.recap = await computeRecap(start, end, laState.activeTab);
  } else {
    const startInput = $('#sr-custom-start');
    const endInput = $('#sr-custom-end');
    if (startInput && startInput.value) laState.rangeStart = startInput.value;
    if (endInput && endInput.value) laState.rangeEnd = endInput.value;
    laState.recap = await computeRecap(laState.rangeStart, laState.rangeEnd, laState.activeTab);
  }
  renderRecapPreview();
}

function openRecapInEmail() {
  const to = ($('#sr-to').value || '').trim();
  const subject = ($('#sr-subject').value || '').trim();
  const body = buildRecapText();
  const mailto = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  window.location.href = mailto;
}

export async function initLocationAnalyticsPage() {
  if (!supabaseClient) { setDriverSyncStatus("Supabase didn't load on this page.", 'error'); return; }
  if (!isAdminUser()) return; // page-level redirect in loadboard.js's init() already handles this — this is just a second guard

  renderTabs();
  const today = dateKey(todayDate());
  const startInput = $('#la-custom-start');
  const endInput = $('#la-custom-end');
  if (startInput) startInput.value = today;
  if (endInput) endInput.value = today;
  const srStartInput = $('#sr-custom-start');
  const srEndInput = $('#sr-custom-end');
  if (srStartInput) srStartInput.value = today;
  if (srEndInput) srEndInput.value = today;

  await reload();

  const tabsWrap = $('#la-location-tabs');
  if (tabsWrap) tabsWrap.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-la-tab]');
    if (!btn) return;
    laState.activeTab = btn.dataset.laTab;
    renderTabs();
    reload();
  });

  document.querySelectorAll('.la-range-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      laState.rangeMode = btn.dataset.laRange;
      if (laState.rangeMode !== 'custom') reload();
      else renderRangeDisplay();
    });
  });
  on('la-custom-apply', 'click', () => {
    laState.rangeStart = $('#la-custom-start').value || laState.rangeStart;
    laState.rangeEnd = $('#la-custom-end').value || laState.rangeEnd;
    reload();
  });

  on('btn-send-recap', 'click', openSendRecapModal);
  on('sr-close', 'click', closeSendRecapModal);
  on('sr-cancel', 'click', closeSendRecapModal);
  on('sr-open-email', 'click', openRecapInEmail);

  document.querySelectorAll('input[name="sr-timeframe"]').forEach((radio) => {
    radio.addEventListener('change', (e) => {
      const customField = $('#sr-custom-range-field');
      if (customField) customField.classList.toggle('hidden', e.target.value !== 'custom');
      if (e.target.value !== 'custom') applySendRecapTimeframe(e.target.value);
    });
  });
  on('sr-custom-start', 'change', () => applySendRecapTimeframe('custom'));
  on('sr-custom-end', 'change', () => applySendRecapTimeframe('custom'));

  const fieldWrap = $('#sr-field-checkboxes');
  if (fieldWrap) fieldWrap.addEventListener('change', (e) => {
    const cb = e.target.closest('.sr-field-cb');
    if (!cb) return;
    if (cb.checked) laState.includedFields.add(cb.value);
    else laState.includedFields.delete(cb.value);
    renderRecapPreview();
  });
}