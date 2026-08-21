/* ================================================================
   Volume — its own entity, visible to everyone (no admin gate, unlike
   Location Analytics). Same cosmetic layout and underlying architecture
   as Location Analytics (fetch/build/render pattern, day/week/period
   recap rows, zebra striping, D&L blue recap styling) but scoped to a
   narrower purpose: seeing what volume looked like in previous weeks,
   months, or periods.

   Range selection: Period / Month / Week / Custom. Period and Month
   work exactly like Location Analytics (multi-select years + quarters
   or months). Week is new here — multi-select years + specific Sun-Sat
   weeks within those years.

   Metrics:
   - Drivers requested: distinct drivers with a shift that day, INCLUDING
     TONU'd shifts (they were still requested), EXCLUDING shifts where
     the driver called off (they never actually ran).
   - TONU's: shifts marked tonu that day.
   - Routes ran: real trips (with a route_id and/or trip_id) across the
     whole shift that day.

   No Generate Report / email flow here — wasn't asked for, and the
   stated purpose is browsing volume, not building recap emails. Easy
   to add later if wanted.
   ================================================================ */
import {
  supabaseClient, escapeHtml, $, on, dateKey, addDays, todayDate,
  SHIFTS_TABLE, TRIPS_TABLE, setDriverSyncStatus,
} from './loadboard.js';

const VOL_LOCATIONS = [
  { key: 'atlanta', label: 'Atlanta' },
  { key: 'buildingc', label: 'Building C' },
  { key: 'delaware', label: 'Delaware' },
];

const WEEK_START_DAY = 0; // 0 = Sunday
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function fmtNum(v) {
  return Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

const FIELD_DEFS = [
  { key: 'driversRequested', label: 'Drivers Requested', fmt: fmtNum },
  { key: 'tonu', label: "TONU's", fmt: fmtNum },
  { key: 'routesRan', label: 'Routes Ran', fmt: fmtNum },
];

const volState = {
  activeTab: 'atlanta',
  rangeMode: 'period', // 'period' | 'month' | 'week' | 'custom'
  selectedRanges: [], // [{start, end, label}, ...] — possibly multiple, non-contiguous
  earliestYear: null,
  displayRows: [], // mixed: {rowType:'day'|'weekRecap'|'periodRecap'|'gap', ...}
  recap: null,
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
  const end = new Date(year, qIdx * 3 + 3, 0);
  return { start, end };
}
function quarterLabel(year, qIdx) { return `Q${qIdx + 1} ${year}`; }
function monthRange(year, monthIdx) {
  const start = new Date(year, monthIdx, 1);
  const end = new Date(year, monthIdx + 1, 0);
  return { start, end };
}
function monthLabel(year, monthIdx) { return `${MONTH_NAMES[monthIdx]} ${year}`; }

function clampToToday(end) {
  const today = todayDate();
  return end > today ? today : end;
}

// Every Sun-Sat week whose Sunday falls within the given year.
function weeksInYear(year) {
  const weeks = [];
  let cursor = startOfWeek(new Date(year, 0, 1));
  if (cursor.getFullYear() < year) cursor = addDays(cursor, 7); // first full week starting in this year
  while (cursor.getFullYear() === year) {
    weeks.push({ start: new Date(cursor), end: addDays(cursor, 6) });
    cursor = addDays(cursor, 7);
  }
  return weeks;
}
function weekLabel(start) { return `Week of ${dateKey(start)}`; }

async function fetchEarliestYear(location) {
  const { data, error } = await supabaseClient
    .from(SHIFTS_TABLE).select('shift_date').eq('location', location)
    .order('shift_date', { ascending: true }).limit(1);
  if (error || !data || !data.length) return todayDate().getFullYear();
  return new Date(data[0].shift_date + 'T00:00:00').getFullYear();
}

// Builds [{start, end, label}, ...] from what was picked in the
// Period/Month/Week modal. years/subUnits are arrays of selected
// values — quarter indices (0-3) for Period, month indices (0-11) for
// Month, week-start date-keys for Week.
function buildSelectedRanges(mode, years, subUnits) {
  const ranges = [];
  if (mode === 'week') {
    // subUnits are date-keys of week-start (Sunday) dates directly,
    // not paired with years — each one fully identifies its own week.
    subUnits.forEach((weekStartKey) => {
      const start = new Date(weekStartKey + 'T00:00:00');
      const end = addDays(start, 6);
      ranges.push({ start: dateKey(start), end: dateKey(clampToToday(end)), label: weekLabel(start) });
    });
  } else {
    years.forEach((year) => {
      if (mode === 'period') {
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
  }
  ranges.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  return ranges;
}

/* ---------------- Fetch + compute ---------------- */

async function fetchRangeData(startDate, endDate, location) {
  const shifts = await fetchAllRows(
    SHIFTS_TABLE, 'id, shift_date, driver_id, tonu, called_off',
    (q) => q.eq('location', location).gte('shift_date', startDate).lte('shift_date', endDate)
  );
  const shiftIds = shifts.map((s) => s.id);

  let trips = [];
  for (const idChunk of chunk(shiftIds, 150)) {
    const { data, error } = await supabaseClient.from(TRIPS_TABLE).select('shift_id, route_id, trip_id').in('shift_id', idChunk);
    if (error) { console.error('Failed to load trips (chunk):', error); continue; }
    trips = trips.concat(data || []);
  }
  return { shifts, trips };
}

function computeMetricsFromRows(shiftsInScope, tripsInScope) {
  const realTrips = tripsInScope.filter((t) => (t.route_id && String(t.route_id).trim()) || (t.trip_id && String(t.trip_id).trim()));
  // Drivers requested: distinct drivers with a shift, including TONU'd
  // shifts (still requested), excluding called-off shifts (never ran).
  const requestedShifts = shiftsInScope.filter((s) => !s.called_off);
  const driversRequested = new Set(requestedShifts.filter((s) => s.driver_id != null).map((s) => s.driver_id)).size;
  const tonu = shiftsInScope.filter((s) => s.tonu).length;
  const routesRan = realTrips.length;
  return { driversRequested, tonu, routesRan };
}

function filterRangeDataToSpan(rangeData, startKey, endKey) {
  const shiftsInScope = rangeData.shifts.filter((s) => s.shift_date >= startKey && s.shift_date <= endKey);
  const shiftIdsInScope = new Set(shiftsInScope.map((s) => s.id));
  const tripsInScope = rangeData.trips.filter((t) => shiftIdsInScope.has(t.shift_id));
  return { shifts: shiftsInScope, trips: tripsInScope };
}

function computeMetricsForDateRange(rangeData, startKey, endKey) {
  const scoped = filterRangeDataToSpan(rangeData, startKey, endKey);
  return computeMetricsFromRows(scoped.shifts, scoped.trips);
}

// Builds the mixed day/weekRecap/periodRecap row sequence for one
// contiguous chunk. Period Recap always fires at the end too, even for
// a single quarter.
function buildDisplayRows(rangeData, startDate, endDate) {
  const rows = [];
  let weekDays = [];
  let periodDays = [];
  let currentQLabel = null;

  const flushWeek = () => {
    if (!weekDays.length) return;
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
    if (currentQLabel !== null && qLabel !== currentQLabel) { flushWeek(); flushPeriod(); }
    currentQLabel = qLabel;
    if (weekDays.length && cursor.getDay() === WEEK_START_DAY) flushWeek();
    rows.push({ rowType: 'day', date: dayKey, ...computeMetricsForDateRange(rangeData, dayKey, dayKey) });
    weekDays.push(dayKey);
    periodDays.push(dayKey);
    cursor = addDays(cursor, 1);
  }
  flushWeek();
  flushPeriod();
  return rows;
}

function fmtValue(def, value) {
  if (value == null) return '—';
  return def.fmt ? def.fmt(value) : String(value);
}

/* ---------------- Rendering ---------------- */

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function renderTable() {
  const table = $('#vol-table');
  if (!table) return;
  const totalCols = FIELD_DEFS.length + 2; // Date, Day, ...metrics
  const headerCells = ['Date', 'Day', ...FIELD_DEFS.map((f) => f.label)].map((h) => `<th>${escapeHtml(h)}</th>`).join('');
  const blankSpacerRows = `<tr><td colspan="${totalCols}" style="background:#fff; height:14px; border:none;"></td></tr>`.repeat(2);
  const rowTd = (content, style, extraAttrs) => `<td${style ? ` style="${style}"` : ''}${extraAttrs || ''}>${content}</td>`;

  let dayIndex = 0;
  const bodyRows = volState.displayRows.map((row) => {
    if (row.rowType === 'gap') {
      return `<tr><td colspan="${totalCols}" style="background:#f1f1f1; color:#888; text-align:center; font-size:11px; padding:6px 0;">— gap in selection —</td></tr>`;
    }
    if (row.rowType === 'day') {
      const zebra = dayIndex % 2 === 1;
      dayIndex += 1;
      const cellStyle = zebra ? 'background:#DAECF5;' : '';
      const dow = DAY_NAMES[new Date(row.date + 'T00:00:00').getDay()];
      const metricCells = FIELD_DEFS.map((f) => rowTd(fmtValue(f, row[f.key]), cellStyle)).join('');
      return `<tr>${rowTd(escapeHtml(row.date), cellStyle)}${rowTd(escapeHtml(dow), cellStyle)}${metricCells}</tr>`;
    }
    const isPeriod = row.rowType === 'periodRecap';
    const cellStyle = isPeriod ? 'background:#006495; color:#fff; font-weight:700;' : 'background:#54b2e5; color:#000; font-weight:700;';
    const metricCells = FIELD_DEFS.map((f) => rowTd(fmtValue(f, row[f.key]), cellStyle)).join('');
    const rowHtml = `<tr>${rowTd(escapeHtml(row.date), cellStyle, ' colspan="2"')}${metricCells}</tr>`;
    return isPeriod ? rowHtml + blankSpacerRows : rowHtml;
  }).join('');

  const lastRow = volState.displayRows[volState.displayRows.length - 1];
  const onlyRange = volState.selectedRanges.length === 1 ? volState.selectedRanges[0] : null;
  const lastRowIsRedundant = onlyRange && lastRow && lastRow.rowType === 'periodRecap'
    && lastRow.rangeStart === onlyRange.start && lastRow.rangeEnd === onlyRange.end;

  let totalRow = '';
  if (!lastRowIsRedundant && volState.selectedRanges.length) {
    const totalStyle = 'background:#006495; color:#fff; font-weight:700;';
    const totalCells = FIELD_DEFS.map((f) => rowTd(fmtValue(f, volState.recap ? volState.recap[f.key] : null), totalStyle)).join('');
    const rangeLabel = volState.selectedRanges.map((r) => r.label).join(', ');
    totalRow = `<tr>${rowTd(`Running Total (${escapeHtml(rangeLabel)})`, totalStyle, ' colspan="2"')}${totalCells}</tr>`;
  }

  table.innerHTML = `<thead><tr>${headerCells}</tr></thead><tbody>${bodyRows}${totalRow}</tbody>`;
  const emptyState = $('#vol-empty-state');
  const hasAnyData = volState.displayRows.some((r) => r.rowType === 'day' && (r.routesRan > 0 || r.driversRequested > 0));
  if (emptyState) emptyState.classList.toggle('hidden', hasAnyData);
}

function renderRangeDisplay() {
  const el = $('#vol-range-display');
  if (!el) return;
  el.textContent = volState.selectedRanges.length
    ? `Showing ${volState.selectedRanges.map((r) => r.label).join(', ')}`
    : 'Nothing selected yet';
  document.querySelectorAll('.vol-range-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.volRange === volState.rangeMode));
  const customInputs = $('#vol-custom-range-inputs');
  if (customInputs) customInputs.classList.toggle('hidden', volState.rangeMode !== 'custom');
}

function renderTabs() {
  const wrap = $('#vol-location-tabs');
  if (!wrap) return;
  wrap.innerHTML = VOL_LOCATIONS.map((l) => `<button type="button" class="location-tab ${volState.activeTab === l.key ? 'is-active' : ''}" data-vol-tab="${l.key}">${escapeHtml(l.label)}</button>`).join('');
}

/* ---------------- Multi-select range picker (Period / Month / Week) ---------------- */

let pickerModalMode = null;

function renderPickerModalContent(mode) {
  const wrap = $('#vrp-body');
  if (!wrap) return;
  const currentYear = todayDate().getFullYear();
  const earliestYear = volState.earliestYear != null ? volState.earliestYear : currentYear;

  if (mode === 'week') {
    // Years first, to narrow down which weeks to list (52-53 per year
    // is too many to show all years' worth at once).
    const years = [];
    for (let y = currentYear; y >= earliestYear; y--) years.push(y);
    wrap.innerHTML = `
      <div class="field"><label>Year</label><div class="checkbox-row" style="flex-wrap:wrap;">
        ${years.map((y, idx) => `<label><input type="radio" name="vrp-week-year" value="${y}" ${idx === 0 ? 'checked' : ''}> ${y}</label>`).join('')}
      </div></div>
      <div class="field"><label>Week(s)</label>
        <div id="vrp-week-list" style="max-height:220px; overflow:auto; border:1px solid var(--line); border-radius:6px; padding:6px;"></div>
      </div>
      <div class="subtext" id="vrp-error" style="color:#b91c1c;"></div>
    `;
    const renderWeeksForYear = (year) => {
      const listEl = $('#vrp-week-list');
      if (!listEl) return;
      const weeks = weeksInYear(year);
      listEl.innerHTML = weeks.map((w) => `<label style="display:block; padding:2px 0;"><input type="checkbox" class="vrp-week-cb" value="${dateKey(w.start)}"> ${weekLabel(w.start)}</label>`).join('');
    };
    renderWeeksForYear(currentYear >= earliestYear ? currentYear : earliestYear);
    document.querySelectorAll('input[name="vrp-week-year"]').forEach((radio) => {
      radio.addEventListener('change', (e) => renderWeeksForYear(Number(e.target.value)));
    });
    return;
  }

  const years = [];
  for (let y = currentYear; y >= earliestYear; y--) years.push(y);
  const yearCheckboxes = years.map((y) => `<label><input type="checkbox" class="vrp-year-cb" value="${y}"> ${y}</label>`).join('');
  let subUnitHtml = '';
  if (mode === 'period') {
    subUnitHtml = `<div class="field"><label>Quarter(s)</label><div class="checkbox-row" style="flex-wrap:wrap;">
      ${[0, 1, 2, 3].map((q) => `<label><input type="checkbox" class="vrp-sub-cb" value="${q}"> Q${q + 1}</label>`).join('')}
    </div></div>`;
  } else if (mode === 'month') {
    subUnitHtml = `<div class="field"><label>Month(s)</label><div class="checkbox-row" style="flex-wrap:wrap;">
      ${MONTH_NAMES.map((name, idx) => `<label><input type="checkbox" class="vrp-sub-cb" value="${idx}"> ${name}</label>`).join('')}
    </div></div>`;
  }
  wrap.innerHTML = `
    <div class="field"><label>Year(s)</label><div class="checkbox-row" style="flex-wrap:wrap;">${yearCheckboxes}</div></div>
    ${subUnitHtml}
    <div class="subtext" id="vrp-error" style="color:#b91c1c;"></div>
  `;
}

async function openRangePickerModal(mode) {
  pickerModalMode = mode;
  if (volState.earliestYear == null) volState.earliestYear = await fetchEarliestYear(volState.activeTab);
  const overlay = $('#modal-vol-range-picker');
  if (!overlay) return;
  const titleEl = $('#vrp-title');
  if (titleEl) titleEl.textContent = mode === 'period' ? 'Select Period(s)' : mode === 'month' ? 'Select Month(s)' : 'Select Week(s)';
  renderPickerModalContent(mode);
  overlay.classList.remove('hidden');
}
function closeRangePickerModal() {
  const overlay = $('#modal-vol-range-picker');
  if (overlay) overlay.classList.add('hidden');
}
async function applyRangePickerSelection() {
  const errEl = $('#vrp-error');
  let years = [], subUnits = [];
  if (pickerModalMode === 'week') {
    subUnits = Array.from(document.querySelectorAll('.vrp-week-cb:checked')).map((el) => el.value);
    if (!subUnits.length) { if (errEl) errEl.textContent = 'Pick at least one week.'; return; }
  } else {
    years = Array.from(document.querySelectorAll('.vrp-year-cb:checked')).map((el) => Number(el.value));
    subUnits = Array.from(document.querySelectorAll('.vrp-sub-cb:checked')).map((el) => Number(el.value));
    if (!years.length) { if (errEl) errEl.textContent = 'Pick at least one year.'; return; }
    if (!subUnits.length) { if (errEl) errEl.textContent = pickerModalMode === 'period' ? 'Pick at least one quarter.' : 'Pick at least one month.'; return; }
  }
  volState.rangeMode = pickerModalMode;
  volState.selectedRanges = buildSelectedRanges(pickerModalMode, years, subUnits);
  closeRangePickerModal();
  await reload();
  renderRangeDisplay();
}

async function reload() {
  setDriverSyncStatus('Loading volume…', 'loading');
  const ranges = volState.selectedRanges;
  if (!ranges.length) {
    volState.displayRows = [];
    volState.recap = null;
    setDriverSyncStatus('');
    renderRangeDisplay();
    renderTable();
    return;
  }

  const allDisplayRows = [];
  const combinedShifts = [];
  const combinedTrips = [];

  for (let i = 0; i < ranges.length; i++) {
    const { start, end } = ranges[i];
    const fetchStart = dateKey(startOfWeek(new Date(start + 'T00:00:00')));
    const fetchEnd = dateKey(addDays(startOfWeek(new Date(end + 'T00:00:00')), 6));
    const rangeData = await fetchRangeData(fetchStart, fetchEnd, volState.activeTab);

    if (i > 0) allDisplayRows.push({ rowType: 'gap' });
    allDisplayRows.push(...buildDisplayRows(rangeData, start, end));

    const scoped = filterRangeDataToSpan(rangeData, start, end);
    combinedShifts.push(...scoped.shifts);
    combinedTrips.push(...scoped.trips);
  }

  volState.displayRows = allDisplayRows;
  volState.recap = computeMetricsFromRows(combinedShifts, combinedTrips);
  setDriverSyncStatus('');
  renderRangeDisplay();
  renderTable();
}

export async function initVolumePage() {
  if (!supabaseClient) { setDriverSyncStatus("Supabase didn't load on this page.", 'error'); return; }

  renderTabs();
  const today = dateKey(todayDate());
  const startInput = $('#vol-custom-start');
  const endInput = $('#vol-custom-end');
  if (startInput) startInput.value = today;
  if (endInput) endInput.value = today;

  const now = todayDate();
  volState.rangeMode = 'period';
  volState.selectedRanges = buildSelectedRanges('period', [now.getFullYear()], [quarterIndex(now)]);
  await reload();

  const tabsWrap = $('#vol-location-tabs');
  if (tabsWrap) tabsWrap.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-vol-tab]');
    if (!btn) return;
    volState.activeTab = btn.dataset.volTab;
    volState.earliestYear = null;
    renderTabs();
    reload();
  });

  document.querySelectorAll('.vol-range-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.volRange;
      if (mode === 'custom') { volState.rangeMode = 'custom'; renderRangeDisplay(); }
      else openRangePickerModal(mode);
    });
  });
  on('vol-custom-apply', 'click', () => {
    const start = $('#vol-custom-start').value;
    const end = $('#vol-custom-end').value;
    if (!start || !end) return;
    volState.selectedRanges = [{ start, end, label: start === end ? start : `${start} to ${end}` }];
    reload();
  });
  on('vrp-close', 'click', closeRangePickerModal);
  on('vrp-cancel', 'click', closeRangePickerModal);
  on('vrp-apply', 'click', applyRangePickerSelection);
}