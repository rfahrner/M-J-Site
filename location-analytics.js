/* ================================================================
   Location Analytics — its own entity, admin-only. Everything is
   computed live from loads_shifts/loads_trips/loads_accounting for
   whatever date range(s) are currently selected, rather than a
   separately-maintained recap table that could drift from real data.

   Range selection: Annual / Period / Month / Custom. Annual, Period,
   and Month each open a picker where you can multi-select years and
   (for Period/Month) multi-select quarters or months — e.g. Q1 2025 +
   Q3 2025 + Q1 2026 all at once. Each selected chunk is fetched and
   built independently (so week/period grouping never spans across a
   gap between two non-adjacent selections), then concatenated with a
   visual separator between non-contiguous chunks.

   Within any single selected chunk, days are grouped into weeks with a
   "Weekly Recap" row after each week, and a "Period Recap" row after
   each quarter — metrics run across the top as columns, one row per
   day/week/period, matching the original workbook's own layout.

   Week boundary is Sunday-Saturday (WEEK_START_DAY below).

   Boundary-straddling weeks: the on-screen Weekly Recap row for a week
   that crosses a quarter boundary may reflect only the portion of that
   week within the currently-loaded chunk. Clicking "Generate Report" on
   that row always re-fetches the true, complete 7-day week fresh,
   independent of what's currently loaded — so the generated report
   itself is always accurate for the full week, even in that edge case.

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
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

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
  rangeMode: 'period', // 'annual' | 'period' | 'month' | 'custom'
  selectedRanges: [], // [{start, end, label}, ...] — possibly multiple, non-contiguous
  earliestYear: null, // populated on load, from the actual earliest shift on file
  displayRows: [], // mixed: {rowType:'day'|'weekRecap'|'periodRecap'|'gap', ...}
  recap: null, // combined aggregate across every selected range
  notesByDate: {},
  includedFields: new Set(FIELD_DEFS.filter((f) => f.category === 'default').map((f) => f.key)),
  reportRange: { start: '', end: '' }, // Generate Report's own single range — separate from selectedRanges, since a report is for one coherent period, not a multi-select combination
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

/* ---------------- Week / quarter / month helpers ---------------- */

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
function monthRange(year, monthIdx) {
  const start = new Date(year, monthIdx, 1);
  const end = new Date(year, monthIdx + 1, 0); // last day of the month
  return { start, end };
}
function monthLabel(year, monthIdx) { return `${MONTH_NAMES[monthIdx]} ${year}`; }
function yearRange(year) {
  const start = new Date(year, 0, 1);
  const end = new Date(year, 11, 31);
  return { start, end };
}

async function fetchEarliestYear(location) {
  const { data, error } = await supabaseClient
    .from(SHIFTS_TABLE).select('shift_date').eq('location', location)
    .order('shift_date', { ascending: true }).limit(1);
  if (error || !data || !data.length) return todayDate().getFullYear();
  return new Date(data[0].shift_date + 'T00:00:00').getFullYear();
}

// Clamps a range's end date to today, so a selection covering the
// current, in-progress year/quarter/month doesn't reach into the future.
function clampToToday(end) {
  const today = todayDate();
  return end > today ? today : end;
}

// Builds the actual [{start, end, label}, ...] chunks for whatever was
// picked in the Annual/Period/Month modal. years/subUnits are arrays of
// selected values (subUnits is quarter indices 0-3 for Period, month
// indices 0-11 for Month, unused for Annual). Sorted chronologically.
function buildSelectedRanges(mode, years, subUnits) {
  const ranges = [];
  years.forEach((year) => {
    if (mode === 'annual') {
      const { start, end } = yearRange(year);
      ranges.push({ start: dateKey(start), end: dateKey(clampToToday(end)), label: `${year}` });
    } else if (mode === 'period') {
      subUnits.forEach((qIdx) => {
        const { start, end } = quarterRange(year, qIdx);
        ranges.push({ start: dateKey(start), end: dateKey(clampToToday(end)), label: quarterLabel(year, qIdx) });
      });
    } else if (mode === 'month') {
      subUnits.forEach((mIdx) => {
        const { start, end } = monthRange(year, mIdx);
        ranges.push({ start: dateKey(start), end: dateKey(clampToToday(end)), label: monthLabel(year, mIdx) });
      });
    }
  });
  ranges.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  return ranges;
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

function filterRangeDataToSpan(rangeData, startKey, endKey) {
  const shiftsInScope = rangeData.shifts.filter((s) => s.shift_date >= startKey && s.shift_date <= endKey);
  const shiftIdsInScope = new Set(shiftsInScope.map((s) => s.id));
  const tripsInScope = rangeData.trips.filter((t) => shiftIdsInScope.has(t.shift_id));
  const accountingInScope = rangeData.accountingRows.filter((r) => r.shift_date >= startKey && r.shift_date <= endKey);
  return { shifts: shiftsInScope, trips: tripsInScope, accountingRows: accountingInScope };
}

function computeMetricsForDateRange(rangeData, startKey, endKey) {
  const scoped = filterRangeDataToSpan(rangeData, startKey, endKey);
  return computeMetricsFromRows(scoped.shifts, scoped.trips, scoped.accountingRows);
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

  // Styling has to go on each <td> directly, not the parent <tr> —
  // table.board's own existing CSS sets `background` on td elements
  // directly (both a base rule and a tr:nth-child(even) td rule for its
  // own native zebra striping), which sits on top of and completely
  // covers any background set only on the row. A per-cell inline style
  // has the specificity to actually win against that.
  const rowTd = (content, style, extraAttrs) => `<td${style ? ` style="${style}"` : ''}${extraAttrs || ''}>${content}</td>`;

  let dayIndex = 0; // for zebra striping across DAY rows only
  const bodyRows = laState.displayRows.map((row) => {
    if (row.rowType === 'gap') {
      // Visual separator between two non-contiguous selected ranges
      // (e.g. Q1 2025 selected alongside Q3 2025, with Q2 skipped).
      return `<tr><td colspan="${totalCols}" style="background:#f1f1f1; color:#888; text-align:center; font-size:11px; padding:6px 0;">— gap in selection —</td></tr>`;
    }
    if (row.rowType === 'day') {
      const zebra = dayIndex % 2 === 1;
      dayIndex += 1;
      const cellStyle = zebra ? 'background:#DAECF5;' : '';
      const dow = DAY_NAMES[new Date(row.date + 'T00:00:00').getDay()];
      const note = laState.notesByDate[row.date] || '';
      const metricCells = FIELD_DEFS.map((f) => rowTd(fmtValue(f, row[f.key]), cellStyle)).join('');
      return `<tr>
        ${rowTd(escapeHtml(row.date), cellStyle)}
        ${rowTd(escapeHtml(dow), cellStyle)}
        ${rowTd(`<input type="text" class="cell-input la-note-input" data-note-date="${row.date}" value="${escapeHtml(note)}" placeholder="Note…" style="width:100%;">`, cellStyle)}
        ${metricCells}
        ${rowTd('', cellStyle)}
      </tr>`;
    }
    // weekRecap: light background, D&L blue text — readable, on-brand.
    // periodRecap: solid D&L blue with white text — deliberately bolder
    // than weekly, so quarter boundaries stand out clearly from week
    // boundaries at a glance. Followed by two blank rows for breathing
    // room before the next section starts.
    const isPeriod = row.rowType === 'periodRecap';
    const cellStyle = isPeriod ? 'background:#006495; color:#fff; font-weight:700;' : 'background:#54b2e5; color:#000; font-weight:700;';
    const metricCells = FIELD_DEFS.map((f) => rowTd(fmtValue(f, row[f.key]), cellStyle)).join('');
    const reportBtn = `<button type="button" class="btn btn-ghost" style="padding:2px 10px; font-size:11px;" data-report-start="${row.rangeStart}" data-report-end="${row.rangeEnd}" data-report-weekly="${row.rowType === 'weekRecap' ? '1' : '0'}">Generate Report</button>`;
    const rowHtml = `<tr>
      ${rowTd(escapeHtml(row.date), cellStyle, ' colspan="3"')}
      ${metricCells}
      ${rowTd(reportBtn, cellStyle)}
    </tr>`;
    return isPeriod ? rowHtml + blankSpacerRows : rowHtml;
  }).join('');

  // Running total row — the combined aggregate across every selected
  // range. Skipped only when there's exactly ONE selected range and the
  // last row above is already a Period Recap covering it exactly (e.g.
  // "Period" mode with a single quarter picked) — that row already IS
  // the running total in that case. With multiple ranges selected, the
  // running total always shows, since it means something no single
  // period's own recap does (the combined total across the selection).
  const lastRow = laState.displayRows[laState.displayRows.length - 1];
  const onlyRange = laState.selectedRanges.length === 1 ? laState.selectedRanges[0] : null;
  const lastRowIsRedundant = onlyRange && lastRow && lastRow.rowType === 'periodRecap'
    && lastRow.rangeStart === onlyRange.start && lastRow.rangeEnd === onlyRange.end;

  let totalRow = '';
  if (!lastRowIsRedundant && laState.selectedRanges.length) {
    const totalStyle = 'background:#006495; color:#fff; font-weight:700;';
    const totalCells = FIELD_DEFS.map((f) => rowTd(fmtValue(f, laState.recap ? laState.recap[f.key] : null), totalStyle)).join('');
    const rangeLabel = laState.selectedRanges.map((r) => r.label).join(', ');
    totalRow = `<tr>
      ${rowTd(`Running Total (${escapeHtml(rangeLabel)})`, totalStyle, ' colspan="3"')}
      ${totalCells}
      ${rowTd('', totalStyle)}
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
  el.textContent = laState.selectedRanges.length
    ? `Showing ${laState.selectedRanges.map((r) => r.label).join(', ')}`
    : 'Nothing selected yet';
  document.querySelectorAll('.la-range-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.laRange === laState.rangeMode));
  const customInputs = $('#la-custom-range-inputs');
  if (customInputs) customInputs.classList.toggle('hidden', laState.rangeMode !== 'custom');
}

function renderTabs() {
  const wrap = $('#la-location-tabs');
  if (!wrap) return;
  wrap.innerHTML = LA_LOCATIONS.map((l) => `<button type="button" class="location-tab ${laState.activeTab === l.key ? 'is-active' : ''}" data-la-tab="${l.key}">${escapeHtml(l.label)}</button>`).join('');
}

/* ---------------- Multi-select range picker (Annual / Period / Month) ---------------- */

let pickerModalMode = null; // 'annual' | 'period' | 'month' — which button opened it

function renderPickerModalContent(mode) {
  const wrap = $('#rp-body');
  if (!wrap) return;
  const currentYear = todayDate().getFullYear();
  const earliestYear = laState.earliestYear != null ? laState.earliestYear : currentYear;
  const years = [];
  for (let y = currentYear; y >= earliestYear; y--) years.push(y); // most recent first

  const yearCheckboxes = years.map((y) => `<label><input type="checkbox" class="rp-year-cb" value="${y}"> ${y}</label>`).join('');

  let subUnitHtml = '';
  if (mode === 'period') {
    subUnitHtml = `<div class="field"><label>Quarter(s)</label><div class="checkbox-row" style="flex-wrap:wrap;">
      ${[0, 1, 2, 3].map((q) => `<label><input type="checkbox" class="rp-sub-cb" value="${q}"> Q${q + 1}</label>`).join('')}
    </div></div>`;
  } else if (mode === 'month') {
    subUnitHtml = `<div class="field"><label>Month(s)</label><div class="checkbox-row" style="flex-wrap:wrap;">
      ${MONTH_NAMES.map((name, idx) => `<label><input type="checkbox" class="rp-sub-cb" value="${idx}"> ${name}</label>`).join('')}
    </div></div>`;
  }

  wrap.innerHTML = `
    <div class="field"><label>Year(s)</label><div class="checkbox-row" style="flex-wrap:wrap;">${yearCheckboxes}</div></div>
    ${subUnitHtml}
    <div class="subtext" id="rp-error" style="color:#b91c1c;"></div>
  `;
}

async function openRangePickerModal(mode) {
  pickerModalMode = mode;
  if (laState.earliestYear == null) {
    laState.earliestYear = await fetchEarliestYear(laState.activeTab);
  }
  const overlay = $('#modal-range-picker');
  if (!overlay) return;
  const titleEl = $('#rp-title');
  if (titleEl) titleEl.textContent = mode === 'annual' ? 'Select Year(s)' : mode === 'period' ? 'Select Period(s)' : 'Select Month(s)';
  renderPickerModalContent(mode);
  overlay.classList.remove('hidden');
}

function closeRangePickerModal() {
  const overlay = $('#modal-range-picker');
  if (overlay) overlay.classList.add('hidden');
}

async function applyRangePickerSelection() {
  const years = Array.from(document.querySelectorAll('.rp-year-cb:checked')).map((el) => Number(el.value));
  const subUnits = Array.from(document.querySelectorAll('.rp-sub-cb:checked')).map((el) => Number(el.value));
  const errEl = $('#rp-error');
  if (!years.length) { if (errEl) errEl.textContent = 'Pick at least one year.'; return; }
  if ((pickerModalMode === 'period' || pickerModalMode === 'month') && !subUnits.length) {
    if (errEl) errEl.textContent = pickerModalMode === 'period' ? 'Pick at least one quarter.' : 'Pick at least one month.';
    return;
  }
  laState.rangeMode = pickerModalMode;
  laState.selectedRanges = buildSelectedRanges(pickerModalMode, years, subUnits);
  closeRangePickerModal();
  await reload();
  renderRangeDisplay();
}

async function reload() {
  setDriverSyncStatus('Loading location analytics…', 'loading');
  const ranges = laState.selectedRanges;
  if (!ranges.length) {
    laState.displayRows = [];
    laState.recap = null;
    laState.notesByDate = {};
    setDriverSyncStatus('');
    renderRangeDisplay();
    renderTable();
    return;
  }

  const allDisplayRows = [];
  const combinedShifts = [];
  const combinedTrips = [];
  const combinedAccounting = [];
  const combinedNotes = {};

  for (let i = 0; i < ranges.length; i++) {
    const { start, end } = ranges[i];
    // Fetch wider than what's actually displayed — padded out to the
    // full containing week at each end — so the first/last Weekly Recap
    // rows can be computed from the TRUE 7-day week even when this
    // chunk's own boundary cuts a week short.
    const fetchStart = dateKey(startOfWeek(new Date(start + 'T00:00:00')));
    const fetchEnd = dateKey(addDays(startOfWeek(new Date(end + 'T00:00:00')), 6));
    const [rangeData, notes] = await Promise.all([
      fetchRangeData(fetchStart, fetchEnd, laState.activeTab),
      loadNotesForRange(start, end, laState.activeTab),
    ]);
    Object.assign(combinedNotes, notes);

    if (i > 0) allDisplayRows.push({ rowType: 'gap' });
    allDisplayRows.push(...buildDisplayRows(rangeData, start, end));

    // Accumulate the UNPADDED (exactly this chunk's own span) raw rows
    // for the combined running total — using the padded rangeData
    // directly here would double-count borrowed days from outside each
    // chunk's own boundary.
    const scoped = filterRangeDataToSpan(rangeData, start, end);
    combinedShifts.push(...scoped.shifts);
    combinedTrips.push(...scoped.trips);
    combinedAccounting.push(...scoped.accountingRows);
  }

  laState.notesByDate = combinedNotes;
  laState.displayRows = allDisplayRows;
  laState.recap = computeMetricsFromRows(combinedShifts, combinedTrips, combinedAccounting);
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
  const { start, end } = laState.reportRange;
  const rangeLabel = start === end ? start : `${start} to ${end}`;
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
  laState.reportRange = { start: startKey, end: endKey };
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
  const { start, end } = laState.reportRange;
  if (subjectInput) subjectInput.value = `${locLabel} ${kind} — ${start === end ? start : `${start} to ${end}`}`;
  renderFieldCheckboxes();
  renderRecapPreview();
}

function closeGenerateReportModal() {
  const overlay = $('#modal-send-recap');
  if (overlay) overlay.classList.add('hidden');
}

async function applyReportTimeframe(mode) {
  if (mode === 'weekly') {
    const pickInput = $('#sr-week-pick');
    const picked = (pickInput && pickInput.value) || dateKey(todayDate());
    const weekStart = startOfWeek(new Date(picked + 'T00:00:00'));
    laState.reportRange = { start: dateKey(weekStart), end: dateKey(addDays(weekStart, 6)) };
  } else if (mode === 'period') {
    const now = todayDate();
    const { start, end } = quarterRange(now.getFullYear(), quarterIndex(now));
    laState.reportRange = { start: dateKey(start), end: dateKey(clampToToday(end)) };
  } else {
    const startInput = $('#sr-custom-start');
    const endInput = $('#sr-custom-end');
    if (startInput && startInput.value) laState.reportRange.start = startInput.value;
    if (endInput && endInput.value) laState.reportRange.end = endInput.value;
  }
  const rangeData = await fetchRangeData(laState.reportRange.start, laState.reportRange.end, laState.activeTab);
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

  // Default view on page load: current quarter, same starting point as
  // before this became a multi-select picker.
  const now = todayDate();
  laState.rangeMode = 'period';
  laState.selectedRanges = buildSelectedRanges('period', [now.getFullYear()], [quarterIndex(now)]);
  await reload();
  renderRangeDisplay();

  const tabsWrap = $('#la-location-tabs');
  if (tabsWrap) tabsWrap.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-la-tab]');
    if (!btn) return;
    laState.activeTab = btn.dataset.laTab;
    laState.earliestYear = null; // different location, may have a different earliest date on file
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
      const mode = btn.dataset.laRange;
      if (mode === 'custom') {
        laState.rangeMode = 'custom';
        renderRangeDisplay();
      } else {
        openRangePickerModal(mode);
      }
    });
  });
  on('la-custom-apply', 'click', () => {
    const start = $('#la-custom-start').value;
    const end = $('#la-custom-end').value;
    if (!start || !end) return;
    laState.selectedRanges = [{ start, end, label: start === end ? start : `${start} to ${end}` }];
    reload();
  });
  on('rp-close', 'click', closeRangePickerModal);
  on('rp-cancel', 'click', closeRangePickerModal);
  on('rp-apply', 'click', applyRangePickerSelection);

  on('btn-send-recap', 'click', async () => {
    const now = todayDate();
    const { start, end } = quarterRange(now.getFullYear(), quarterIndex(now));
    const rangeData = await fetchRangeData(dateKey(start), dateKey(clampToToday(end)), laState.activeTab);
    laState.recap = computeAggregate(rangeData);
    laState.reportRange = { start: dateKey(start), end: dateKey(clampToToday(end)) };
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