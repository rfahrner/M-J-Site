/* ================================================================
   Location Analytics — its own entity, admin-only. Everything is
   computed live from loads_shifts/loads_trips/loads_accounting for a
   selected date range, rather than a separately-maintained recap
   table that could drift from the real data.

   Page starts on "Period" (current quarter) by default. Within any
   range, days are grouped into weeks with a "Weekly Recap" summary row
   after each week, and (when the range spans more than one quarter)
   a "Period Recap" row after each quarter. Metrics run across the top
   as columns, one row per day/week/period — matches the original
   workbook's own Daily Recap layout.

   Week boundary is Sunday-Saturday (WEEK_START_DAY below) — flagged
   assumption, since the one concrete example given (March 30 - April 3,
   2026) is actually a Mon-Fri span. One-line change if that's meant
   literally rather than as a partial illustration.

   Boundary-straddling weeks: the on-screen Weekly Recap row for a week
   that crosses a quarter boundary may reflect only the portion of that
   week within the currently-loaded range (e.g., viewing "Period" alone
   near a quarter's edge). Clicking "Generate Report" on that row always
   re-fetches the true, complete 7-day week fresh, independent of what's
   currently loaded — so the generated report itself is always accurate
   for the full week, even in that edge case.

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

const WEEK_START_DAY = 0; // 0 = Sunday. See header note.
const NOTES_TABLE = 'location_analytics_daily_notes';

function fmtNum(v, decimals) {
  return Number(v).toLocaleString('en-US', { minimumFractionDigits: decimals || 0, maximumFractionDigits: decimals || 0 });
}
function fmtMoney(v) { return `$${fmtNum(v, 2)}`; }

// category: 'default' fields are pre-checked in Generate Report (matches
// the reference email exactly); 'extra' fields are available to add but
// unchecked by default.
const FIELD_DEFS = [
  { key: 'drivers', label: 'Drivers', category: 'default', fmt: (v) => fmtNum(v) },
  { key: 'mileage', label: 'Mileage', category: 'default', fmt: (v) => fmtNum(v, 1) },
  { key: 'routes', label: 'Routes', category: 'default', fmt: (v) => fmtNum(v) },
  { key: 'stops', label: 'Stops', category: 'default', fmt: (v) => fmtNum(v) },
  { key: 'turn', label: 'Turn', category: 'default', fmt: (v) => fmtNum(v, 2) },
  { key: 'salvage', label: 'Salvage', category: 'default', fmt: (v) => fmtNum(v) },
  { key: 'backhauls', label: 'Backhauls', category: 'default', fmt: (v) => fmtNum(v) },
  { key: 'tonu', label: "TONU's", category: 'extra', fmt: (v) => fmtNum(v) },
  { key: 'revenue', label: 'Revenue', category: 'extra', fmt: fmtMoney },
  { key: 'cost', label: 'Cost', category: 'extra', fmt: fmtMoney },
  { key: 'margin', label: 'Margin', category: 'extra', fmt: fmtMoney },
  { key: 'gmPct', label: 'GM%', category: 'extra', fmt: (v) => `${fmtNum(v, 1)}%` },
  { key: 'revPerMile', label: 'Rev/mi', category: 'extra', fmt: fmtMoney },
  { key: 'revPerRoute', label: 'Rev/route', category: 'extra', fmt: fmtMoney },
  { key: 'revPerDriver', label: 'Rev/Driver', category: 'extra', fmt: fmtMoney },
  { key: 'avrLoh', label: 'AVR LOH', category: 'extra', fmt: (v) => fmtNum(v, 1) },
  { key: 'marginPerDriver', label: 'Margin/DR', category: 'extra', fmt: fmtMoney },
  { key: 'revPerStop', label: 'Rev/stop', category: 'extra', fmt: fmtMoney },
  { key: 'marginPerRoute', label: 'Margin/Route', category: 'extra', fmt: fmtMoney },
];

const laState = {
  activeTab: 'atlanta',
  rangeMode: 'period',
  rangeStart: '',
  rangeEnd: '',
  displayRows: [], // mixed: {rowType:'day'|'weekRecap'|'periodRecap', ...}
  recap: null,
  notesByDate: {},
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

/* ---------------- Week / quarter helpers ---------------- */

function quarterIndex(d) { return Math.floor(d.getMonth() / 3); }
function startOfWeek(d) {
  const out = new Date(d);
  const day = out.getDay();
  const diff = (day - WEEK_START_DAY + 7) % 7;
  out.setDate(out.getDate() - diff);
  return out;
}
function quarterRange(year, qIdx) {
  const start = new Date(year, qIdx * 3, 1);
  const end = new Date(year, qIdx * 3 + 3, 0); // last day of the quarter
  return { start, end };
}
function quarterLabel(year, qIdx) { return `Q${qIdx + 1} ${year}`; }
function shiftQuarter(year, qIdx, delta) {
  let y = year, q = qIdx + delta;
  while (q < 0) { q += 4; y -= 1; }
  while (q > 3) { q -= 4; y += 1; }
  return { year: y, qIdx: q };
}

async function fetchEarliestDate(location) {
  const { data, error } = await supabaseClient
    .from(SHIFTS_TABLE).select('shift_date').eq('location', location)
    .order('shift_date', { ascending: true }).limit(1);
  if (error || !data || !data.length) return dateKey(addDays(todayDate(), -365));
  return data[0].shift_date;
}

async function computeRangeDates(mode) {
  const today = todayDate();
  if (mode === 'period') {
    const { start } = quarterRange(today.getFullYear(), quarterIndex(today));
    return { start: dateKey(start), end: dateKey(today) };
  }
  if (mode === 'past5quarters') {
    const { year, qIdx } = shiftQuarter(today.getFullYear(), quarterIndex(today), -4);
    const { start } = quarterRange(year, qIdx);
    return { start: dateKey(start), end: dateKey(today) };
  }
  if (mode === 'alltime') {
    const earliest = await fetchEarliestDate(laState.activeTab);
    return { start: earliest, end: dateKey(today) };
  }
  return { start: laState.rangeStart || dateKey(today), end: laState.rangeEnd || dateKey(today) };
}

/* ---------------- Fetch + compute ---------------- */

async function fetchRangeData(startDate, endDate, location) {
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

  const accountingRows = await fetchAllRows(
    ACCOUNTING_TABLE, 'shift_date, total_cost, total_revenue',
    (q) => q.eq('location', location).gte('shift_date', startDate).lte('shift_date', endDate)
  );

  return { shifts, trips, accountingRows };
}

// Computes every metric from whatever subset of rows it's given — reused
// for a single day, a week, a quarter, or the overall aggregate, just
// called with different scopes.
function computeMetricsFromRows(shiftsInScope, tripsInScope, accountingInScope) {
  const realTrips = tripsInScope.filter((t) => (t.route_id && String(t.route_id).trim()) || (t.trip_id && String(t.trip_id).trim()));
  const distinctDrivers = new Set(shiftsInScope.filter((s) => s.driver_id != null).map((s) => s.driver_id)).size;
  const mileage = realTrips.reduce((sum, t) => sum + (Number(t.route_miles) || 0), 0);
  const routes = realTrips.length;
  const stops = realTrips.reduce((sum, t) => sum + (Number(t.stop_count) || 0), 0);
  const salvage = realTrips.filter((t) => t.salvage).length;
  const backhauls = realTrips.filter((t) => t.backhaul).length;
  const tonu = shiftsInScope.filter((s) => s.tonu).length;
  const revenue = accountingInScope.reduce((sum, r) => sum + (Number(r.total_revenue) || 0), 0);
  const cost = accountingInScope.reduce((sum, r) => sum + (Number(r.total_cost) || 0), 0);
  const margin = revenue - cost;

  return {
    drivers: distinctDrivers, mileage, routes, stops,
    turn: distinctDrivers ? routes / distinctDrivers : 0,
    salvage, backhauls, tonu, revenue, cost, margin,
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

function computeMetricsForDateRange(rangeData, startKey, endKey) {
  const shiftsInScope = rangeData.shifts.filter((s) => s.shift_date >= startKey && s.shift_date <= endKey);
  const shiftIdsInScope = new Set(shiftsInScope.map((s) => s.id));
  const tripsInScope = rangeData.trips.filter((t) => shiftIdsInScope.has(t.shift_id));
  const accountingInScope = rangeData.accountingRows.filter((r) => r.shift_date >= startKey && r.shift_date <= endKey);
  return computeMetricsFromRows(shiftsInScope, tripsInScope, accountingInScope);
}

function computeAggregate(rangeData) {
  return computeMetricsFromRows(rangeData.shifts, rangeData.trips, rangeData.accountingRows);
}

// Builds the mixed day/weekRecap/periodRecap row sequence for the
// currently-loaded range. Period Recap rows only appear when the range
// actually spans more than one quarter (Past 5 Quarters / All Time /
// a wide Custom range) — a single-quarter Period view ends with just
// the final Weekly Recap, since there's only one period to summarize.
function buildDisplayRows(rangeData, startDate, endDate) {
  const rows = [];
  let weekDays = [];
  let periodDays = [];
  let currentQLabel = null;

  const flushWeek = () => {
    if (!weekDays.length) return;
    // Always the TRUE Sun-Sat week, even if the currently-displayed
    // range only contains a partial slice of it (e.g. viewing "Period"
    // right at a quarter's start/end, where the week's earlier days
    // belong to the previous quarter). The period boundary changes
    // which days render as their own rows — it never changes what a
    // week itself is. rangeData is fetched padded out to full weeks at
    // each end specifically so this has real data to compute from.
    const anyDayInWeek = new Date(weekDays[0] + 'T00:00:00');
    const trueWeekStart = startOfWeek(anyDayInWeek);
    const trueWeekEnd = addDays(trueWeekStart, 6);
    const wStart = dateKey(trueWeekStart);
    const wEnd = dateKey(trueWeekEnd);
    rows.push({ rowType: 'weekRecap', date: `Weekly Recap (${wStart} to ${wEnd})`, rangeStart: wStart, rangeEnd: wEnd, ...computeMetricsForDateRange(rangeData, wStart, wEnd) });
    weekDays = [];
  };
  const flushPeriod = () => {
    if (!periodDays.length) return;
    const pStart = periodDays[0], pEnd = periodDays[periodDays.length - 1];
    rows.push({ rowType: 'periodRecap', date: `${currentQLabel} Recap`, rangeStart: pStart, rangeEnd: pEnd, ...computeMetricsForDateRange(rangeData, pStart, pEnd) });
    periodDays = [];
  };

  let cursor = new Date(startDate + 'T00:00:00');
  const endCursor = new Date(endDate + 'T00:00:00');
  while (cursor <= endCursor) {
    const dayKey = dateKey(cursor);
    const qLabel = quarterLabel(cursor.getFullYear(), quarterIndex(cursor));

    if (currentQLabel !== null && qLabel !== currentQLabel) {
      flushWeek();
      flushPeriod();
    }
    currentQLabel = qLabel;

    if (weekDays.length && cursor.getDay() === WEEK_START_DAY) flushWeek();

    rows.push({ rowType: 'day', date: dayKey, ...computeMetricsForDateRange(rangeData, dayKey, dayKey) });
    weekDays.push(dayKey);
    periodDays.push(dayKey);
    cursor = addDays(cursor, 1);
  }
  flushWeek();
  flushPeriod(); // always, even for a single-quarter "Period" view — that quarter still gets its own recap row
  return rows;
}

function fmtValue(def, value) {
  if (value == null) return '—';
  return def.fmt ? def.fmt(value) : String(value);
}

/* ---------------- Per-day notes ---------------- */

async function loadNotesForRange(startDate, endDate, location) {
  const { data, error } = await supabaseClient
    .from(NOTES_TABLE).select('note_date, note')
    .eq('location', location).gte('note_date', startDate).lte('note_date', endDate);
  if (error) { console.error('Failed to load daily notes:', error); return {}; }
  const map = {};
  (data || []).forEach((r) => { map[r.note_date] = r.note || ''; });
  return map;
}

async function saveNote(dateKeyVal, text) {
  try {
    const { error } = await supabaseClient.from(NOTES_TABLE)
      .upsert({ location: laState.activeTab, note_date: dateKeyVal, note: text }, { onConflict: 'location,note_date' });
    if (error) throw error;
    laState.notesByDate[dateKeyVal] = text;
  } catch (e) {
    console.error('Failed to save note:', e);
    setDriverSyncStatus(`Couldn't save that note (${e.message || e}).`, 'error');
  }
}

/* ---------------- Rendering ---------------- */

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function renderTable() {
  const table = $('#la-table');
  if (!table) return;
  const totalCols = FIELD_DEFS.length + 4; // Date, Day, Notes, ...metrics, action
  const headerCells = ['Date', 'Day', 'Notes', ...FIELD_DEFS.map((f) => f.label), ''].map((h) => `<th>${escapeHtml(h)}</th>`).join('');
  const blankSpacerRows = `<tr><td colspan="${totalCols}" style="background:#fff; height:14px; border:none;"></td></tr>`.repeat(2);

  let dayIndex = 0; // for zebra striping across DAY rows only
  const bodyRows = laState.displayRows.map((row) => {
    if (row.rowType === 'day') {
      const zebra = dayIndex % 2 === 1;
      dayIndex += 1;
      const dow = DAY_NAMES[new Date(row.date + 'T00:00:00').getDay()];
      const note = laState.notesByDate[row.date] || '';
      const metricCells = FIELD_DEFS.map((f) => `<td>${fmtValue(f, row[f.key])}</td>`).join('');
      return `<tr${zebra ? ' style="background:#3271a1; color:#fff;"' : ''}>
        <td>${escapeHtml(row.date)}</td>
        <td>${escapeHtml(dow)}</td>
        <td><input type="text" class="cell-input la-note-input" data-note-date="${row.date}" value="${escapeHtml(note)}" placeholder="Note…" style="width:100%;"></td>
        ${metricCells}
        <td></td>
      </tr>`;
    }
    // weekRecap: light background, D&L blue text — readable, on-brand.
    // periodRecap: solid D&L blue with white text — deliberately bolder
    // than weekly, so quarter boundaries stand out clearly from week
    // boundaries at a glance. Followed by two blank rows for breathing
    // room before the next section starts.
    const isPeriod = row.rowType === 'periodRecap';
    const rowStyle = isPeriod ? 'background:#006495; color:#fff; font-weight:700;' : 'background:#e6f0f6; color:#006495; font-weight:700;';
    const metricCells = FIELD_DEFS.map((f) => `<td>${fmtValue(f, row[f.key])}</td>`).join('');
    const rowHtml = `<tr style="${rowStyle}">
      <td colspan="3">${escapeHtml(row.date)}</td>
      ${metricCells}
      <td><button type="button" class="btn btn-ghost" style="padding:2px 10px; font-size:11px;" data-report-start="${row.rangeStart}" data-report-end="${row.rangeEnd}" data-report-weekly="${row.rowType === 'weekRecap' ? '1' : '0'}">Generate Report</button></td>
    </tr>`;
    return isPeriod ? rowHtml + blankSpacerRows : rowHtml;
  }).join('');

  // Running total row — the full displayed range's own aggregate.
  // Skipped when the last row above is already a Period Recap covering
  // this exact same range (e.g. viewing "Period" mode, a single
  // quarter) — that row already IS the running total in that case, so
  // showing both would just repeat the same numbers twice.
  const lastRow = laState.displayRows[laState.displayRows.length - 1];
  const lastRowIsRedundant = lastRow && lastRow.rowType === 'periodRecap'
    && lastRow.rangeStart === laState.rangeStart && lastRow.rangeEnd === laState.rangeEnd;

  let totalRow = '';
  if (!lastRowIsRedundant) {
    const totalCells = FIELD_DEFS.map((f) => `<td>${fmtValue(f, laState.recap ? laState.recap[f.key] : null)}</td>`).join('');
    totalRow = `<tr style="background:#006495; color:#fff; font-weight:700;">
      <td colspan="3">Running Total (${escapeHtml(laState.rangeStart)} to ${escapeHtml(laState.rangeEnd)})</td>
      ${totalCells}
      <td></td>
    </tr>`;
  }

  table.innerHTML = `<thead><tr>${headerCells}</tr></thead><tbody>${bodyRows}${totalRow}</tbody>`;
  const emptyState = $('#la-empty-state');
  const hasAnyData = laState.displayRows.some((r) => r.rowType === 'day' && (r.routes > 0 || r.drivers > 0));
  if (emptyState) emptyState.classList.toggle('hidden', hasAnyData);
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
  const { start, end } = await computeRangeDates(laState.rangeMode);
  laState.rangeStart = start;
  laState.rangeEnd = end;
  // Fetch wider than what's actually displayed — padded out to the full
  // containing week at each end — so the first/last Weekly Recap rows
  // can be computed from the TRUE 7-day week even when the displayed
  // period boundary cuts a week short (e.g. "Period" starting mid-week).
  // The padding days themselves are never rendered as their own day rows.
  const fetchStart = dateKey(startOfWeek(new Date(start + 'T00:00:00')));
  const fetchEnd = dateKey(addDays(startOfWeek(new Date(end + 'T00:00:00')), 6));
  const [rangeData, notes] = await Promise.all([
    fetchRangeData(fetchStart, fetchEnd, laState.activeTab),
    loadNotesForRange(start, end, laState.activeTab),
  ]);
  laState.notesByDate = notes;
  laState.displayRows = buildDisplayRows(rangeData, start, end);
  // Running total stays scoped to exactly the displayed range, not the
  // padded fetch — otherwise borrowed days from the adjacent period
  // would silently inflate it.
  laState.recap = computeMetricsForDateRange(rangeData, start, end);
  setDriverSyncStatus('');
  renderRangeDisplay();
  renderTable();
}

/* ---------------- Generate Report modal ---------------- */

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
  const lines = [`${locLabel} Report — ${rangeLabel}`, ''];
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

// Generic — works for any date range (a week or a period), not just a
// single day. Always re-fetches fresh for the EXACT given range, so a
// week that straddles a quarter boundary still generates a complete,
// accurate report regardless of what's currently loaded on screen.
async function openReportForRange(startKey, endKey, isWeekly) {
  laState.rangeMode = 'custom';
  laState.rangeStart = startKey;
  laState.rangeEnd = endKey;
  const rangeData = await fetchRangeData(startKey, endKey, laState.activeTab);
  laState.recap = computeAggregate(rangeData);
  await openGenerateReportModal(isWeekly ? 'Weekly Report' : 'Period Report');
  const customRadio = document.querySelector('input[name="sr-timeframe"][value="custom"]');
  if (customRadio) customRadio.checked = true;
  const customField = $('#sr-custom-range-field');
  if (customField) customField.classList.remove('hidden');
  const srStart = $('#sr-custom-start');
  const srEnd = $('#sr-custom-end');
  if (srStart) srStart.value = startKey;
  if (srEnd) srEnd.value = endKey;
}

async function openGenerateReportModal(labelOverride) {
  const overlay = $('#modal-send-recap');
  if (!overlay) return;
  overlay.classList.remove('hidden');
  const subjectInput = $('#sr-subject');
  const locLabel = (LA_LOCATIONS.find((l) => l.key === laState.activeTab) || {}).label || laState.activeTab;
  const kind = labelOverride || 'Report';
  if (subjectInput) subjectInput.value = `${locLabel} ${kind} — ${laState.rangeStart === laState.rangeEnd ? laState.rangeStart : `${laState.rangeStart} to ${laState.rangeEnd}`}`;
  renderFieldCheckboxes();
  renderRecapPreview();
}

function closeGenerateReportModal() {
  const overlay = $('#modal-send-recap');
  if (overlay) overlay.classList.add('hidden');
}

async function applyReportTimeframe(mode) {
  laState.rangeMode = mode;
  if (mode === 'weekly') {
    const pickInput = $('#sr-week-pick');
    const picked = (pickInput && pickInput.value) || dateKey(todayDate());
    const weekStart = startOfWeek(new Date(picked + 'T00:00:00'));
    laState.rangeStart = dateKey(weekStart);
    laState.rangeEnd = dateKey(addDays(weekStart, 6));
  } else if (mode !== 'custom') {
    const { start, end } = await computeRangeDates(mode);
    laState.rangeStart = start;
    laState.rangeEnd = end;
  } else {
    const startInput = $('#sr-custom-start');
    const endInput = $('#sr-custom-end');
    if (startInput && startInput.value) laState.rangeStart = startInput.value;
    if (endInput && endInput.value) laState.rangeEnd = endInput.value;
  }
  const rangeData = await fetchRangeData(laState.rangeStart, laState.rangeEnd, laState.activeTab);
  laState.recap = computeAggregate(rangeData);
  renderRecapPreview();
}

function openReportInEmail() {
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
  const srWeekInput = $('#sr-week-pick');
  if (srWeekInput) srWeekInput.value = today;

  await reload();

  const tabsWrap = $('#la-location-tabs');
  if (tabsWrap) tabsWrap.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-la-tab]');
    if (!btn) return;
    laState.activeTab = btn.dataset.laTab;
    renderTabs();
    reload();
  });

  const table = $('#la-table');
  if (table) {
    table.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-report-start]');
      if (btn) openReportForRange(btn.dataset.reportStart, btn.dataset.reportEnd, btn.dataset.reportWeekly === '1');
    });
    table.addEventListener('blur', (e) => {
      const input = e.target.closest('.la-note-input');
      if (input) saveNote(input.dataset.noteDate, input.value.trim());
    }, true);
  }

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

  on('btn-send-recap', 'click', async () => {
    laState.rangeMode = 'period';
    const { start, end } = await computeRangeDates('period');
    laState.rangeStart = start;
    laState.rangeEnd = end;
    const rangeData = await fetchRangeData(start, end, laState.activeTab);
    laState.recap = computeAggregate(rangeData);
    await openGenerateReportModal();
    const periodRadio = document.querySelector('input[name="sr-timeframe"][value="period"]');
    if (periodRadio) periodRadio.checked = true;
    const customField = $('#sr-custom-range-field');
    if (customField) customField.classList.add('hidden');
    const weekField = $('#sr-week-field');
    if (weekField) weekField.classList.add('hidden');
  });
  on('sr-close', 'click', closeGenerateReportModal);
  on('sr-cancel', 'click', closeGenerateReportModal);
  on('sr-open-email', 'click', openReportInEmail);

  document.querySelectorAll('input[name="sr-timeframe"]').forEach((radio) => {
    radio.addEventListener('change', (e) => {
      const customField = $('#sr-custom-range-field');
      if (customField) customField.classList.toggle('hidden', e.target.value !== 'custom');
      const weekField = $('#sr-week-field');
      if (weekField) weekField.classList.toggle('hidden', e.target.value !== 'weekly');
      if (e.target.value !== 'custom' && e.target.value !== 'weekly') applyReportTimeframe(e.target.value);
      if (e.target.value === 'weekly') applyReportTimeframe('weekly');
    });
  });
  on('sr-custom-start', 'change', () => applyReportTimeframe('custom'));
  on('sr-custom-end', 'change', () => applyReportTimeframe('custom'));
  on('sr-week-pick', 'change', () => applyReportTimeframe('weekly'));

  const fieldWrap = $('#sr-field-checkboxes');
  if (fieldWrap) fieldWrap.addEventListener('change', (e) => {
    const cb = e.target.closest('.sr-field-cb');
    if (!cb) return;
    if (cb.checked) laState.includedFields.add(cb.value);
    else laState.includedFields.delete(cb.value);
    renderRecapPreview();
  });
}