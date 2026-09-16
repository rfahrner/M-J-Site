import { renderStandaloneSiteNav } from './site-nav-v2.js';

const SUPABASE_URL = 'https://ygsapysqzwrpcimgvaqx.supabase.co';
const SUPABASE_KEY = 'sb_publishable_8b8bSIiYm5TzLTw0WG1pAw_5ZWW5ZPL';
const AUTH_STORAGE_KEY = 'dl-dispatch-auth';
const COLLAPSED_STORAGE_KEY = 'dl-megaboard-collapsed-v1';

const MONDELEZ_LOCATIONS = [
  ['westchester', 'West Chester'],
  ['morris', 'Morris'],
  ['addison', 'Addison'],
  ['indianapolis', 'Indianapolis'],
  ['louisville', 'Louisville'],
  ['spokane', 'Spokane'],
  ['lasvegas', 'Las Vegas'],
  ['boise', 'Boise'],
  ['kent', 'Kent'],
  ['saltlakecity', 'Salt Lake City'],
  ['newberlin', 'New Berlin'],
];
const MONDELEZ_LABEL = Object.fromEntries(MONDELEZ_LOCATIONS);

const GROUP_DEFS = [
  { key: 'kroger:atlanta', source: 'Kroger', title: 'Atlanta', type: 'standard', location: 'atlanta', href: 'index.html' },
  { key: 'kroger:delaware', source: 'Kroger', title: 'Delaware', type: 'standard', location: 'delaware', href: 'dalaware.html' },
  { key: 'kroger:buildingc', source: 'Kroger', title: 'Building C', type: 'standard', location: 'buildingc', href: 'buildingc.html' },
  { key: 'kroger:houston', source: 'Kroger', title: 'Houston', type: 'houston', location: 'houston', href: 'houston.html' },
  ...MONDELEZ_LOCATIONS.map(([location, title]) => ({
    key: `mondelez:${location}`,
    source: 'Mondelez',
    title,
    type: 'mondelez',
    location,
    href: `mondelez.html?loc=${location}`,
  })),
];

let client = null;
let userRole = null;
let selectedDates = new Set();
let dateOptions = [];
let collapsed = loadCollapsed();
let loadSerial = 0;
let realtimeChannel = null;
let reloadTimer = null;
let lastData = null;

function $(id) { return document.getElementById(id); }
function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
function text(value, fallback = '—') {
  const raw = value == null ? '' : String(value).trim();
  return raw || fallback;
}
function cell(value, className = '') {
  return `<td${className ? ` class="${className}"` : ''}>${esc(text(value))}</td>`;
}
function money(value) {
  if (value == null || value === '') return '—';
  const n = Number(value);
  return Number.isFinite(n) ? `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : String(value);
}
function boolMark(value) { return value ? 'Yes' : '—'; }

function dateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
function addDays(date, amount) {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  next.setDate(next.getDate() + amount);
  return next;
}
function dateFromKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function prettyDate(key, long = false) {
  return dateFromKey(key).toLocaleDateString('en-US', long
    ? { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }
    : { weekday: 'short', month: 'short', day: 'numeric' });
}
function timeSortValue(value) {
  const raw = String(value || '').replace(/[^0-9]/g, '');
  if (!raw) return 99999;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 99999;
}

function loadCollapsed() {
  try { return new Set(JSON.parse(localStorage.getItem(COLLAPSED_STORAGE_KEY) || '[]')); }
  catch (_) { return new Set(); }
}
function saveCollapsed() {
  try { localStorage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify([...collapsed])); }
  catch (_) { /* storage can be blocked; collapse still works for this view */ }
}

function setStatus(message, isError = false) {
  const el = $('mega-status');
  if (!el) return;
  el.textContent = message || '';
  el.classList.toggle('is-error', !!isError);
}

function buildDateOptions() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayKey = dateKey(today);
  dateOptions = Array.from({ length: 15 }, (_, index) => {
    const offset = index - 7;
    const date = addDays(today, offset);
    return { offset, key: dateKey(date), date, isToday: offset === 0 };
  });
  selectedDates = new Set([todayKey]);
}

function renderDateChips() {
  const wrap = $('mega-date-chips');
  if (!wrap) return;
  wrap.innerHTML = dateOptions.map((item) => {
    const selected = selectedDates.has(item.key);
    return `<button type="button" class="mega-date-chip${selected ? ' is-selected' : ''}${item.isToday ? ' is-today' : ''}" data-mega-date="${item.key}" aria-pressed="${selected ? 'true' : 'false'}">
      <span class="mega-date-weekday">${item.date.toLocaleDateString('en-US', { weekday: 'short' })}</span>
      <span class="mega-date-date">${item.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
      ${item.isToday ? '<span class="mega-date-today">TODAY</span>' : ''}
    </button>`;
  }).join('');
}

function replaceSelectedDates(keys) {
  selectedDates = new Set(keys.filter((key) => dateOptions.some((item) => item.key === key)));
  if (!selectedDates.size) selectedDates.add(dateOptions.find((item) => item.isToday).key);
  renderDateChips();
  loadData();
}

async function initAuth() {
  if (!window.supabase) throw new Error('Supabase library did not load.');
  client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: AUTH_STORAGE_KEY },
  });
  const sessionResult = await Promise.race([
    client.auth.getSession(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out checking login session.')), 6000)),
  ]);
  if (!sessionResult.data.session) {
    location.href = 'login.html';
    return false;
  }
  const { data: userData } = await client.auth.getUser();
  userRole = userData?.user?.user_metadata?.role || null;
  client.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') location.href = 'login.html';
  });
  renderStandaloneSiteNav(userRole, async () => {
    await client.auth.signOut();
    location.href = 'login.html';
  });
  return true;
}

function groupBy(rows, keyFn) {
  const map = new Map();
  (rows || []).forEach((row) => {
    const key = keyFn(row);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  });
  return map;
}

function meaningfulTrip(trip) {
  return !!String(trip?.route_id || trip?.trip_id || '').trim();
}
function meaningfulStandardShift(shift, tripsByShift) {
  return !!(
    shift.driver_id || String(shift.driver_name_text || '').trim() || String(shift.pro_number || '').trim() ||
    (tripsByShift.get(shift.id) || []).some(meaningfulTrip)
  );
}
function meaningfulHouston(row) {
  return !!(row.driver_id || String(row.driver_name || '').trim() || String(row.aljex_number || '').trim());
}
function meaningfulMondelez(row) {
  return !!(
    row.driver_id || String(row.driver_name || '').trim() || String(row.aljex_number || '').trim() ||
    String(row.delivery_group || '').trim() || String(row.trailer_number || '').trim()
  );
}

async function loadData() {
  if (!client || !selectedDates.size) return;
  const serial = ++loadSerial;
  const dates = [...selectedDates].sort();
  const view = $('megaboard-view');
  if (view) view.classList.add('mega-loading');
  setStatus(`Loading ${dates.length === 1 ? prettyDate(dates[0], true) : `${dates.length} selected days`}…`);

  try {
    const [shiftResult, houstonResult, mondelezResult] = await Promise.all([
      client.from('loads_shifts').select('*').in('shift_date', dates).limit(5000),
      client.from('loads_houston').select('*').in('shift_date', dates).limit(5000),
      client.from('mondelez_loads').select('*').in('shift_date', dates).limit(5000),
    ]);
    const firstError = shiftResult.error || houstonResult.error || mondelezResult.error;
    if (firstError) throw firstError;
    if (serial !== loadSerial) return;

    const shifts = shiftResult.data || [];
    const shiftIds = shifts.map((row) => row.id);
    const tripResult = shiftIds.length
      ? await client.from('loads_trips').select('*').in('shift_id', shiftIds).limit(10000)
      : { data: [], error: null };
    if (tripResult.error) throw tripResult.error;
    if (serial !== loadSerial) return;

    const trips = tripResult.data || [];
    const tripsByShift = groupBy(trips, (trip) => trip.shift_id);
    tripsByShift.forEach((list) => list.sort((a, b) => Number(a.trip_number || 0) - Number(b.trip_number || 0)));

    const standardShifts = shifts.filter((shift) => meaningfulStandardShift(shift, tripsByShift));
    const houstonRows = (houstonResult.data || []).filter(meaningfulHouston);
    const mondelezRows = (mondelezResult.data || []).filter(meaningfulMondelez);

    const driverIds = new Set();
    standardShifts.forEach((row) => { if (row.driver_id) driverIds.add(Number(row.driver_id)); });
    trips.forEach((row) => { if (row.driver_id) driverIds.add(Number(row.driver_id)); });
    houstonRows.forEach((row) => { if (row.driver_id) driverIds.add(Number(row.driver_id)); });
    mondelezRows.forEach((row) => { if (row.driver_id) driverIds.add(Number(row.driver_id)); });

    let profiles = [];
    if (driverIds.size) {
      const profileResult = await client.from('atlanta_drivers').select('*').in('id', [...driverIds]).limit(5000);
      if (profileResult.error) throw profileResult.error;
      profiles = profileResult.data || [];
    }
    if (serial !== loadSerial) return;

    lastData = {
      dates,
      standardShifts,
      houstonRows,
      mondelezRows,
      tripsByShift,
      profiles: new Map(profiles.map((row) => [String(row.id), row])),
    };
    renderLocations();

    const totalLoads = standardShifts.length + houstonRows.length + mondelezRows.length;
    const visibleGroups = countVisibleGroups();
    setStatus(`Updated ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} · ${totalLoads} load${totalLoads === 1 ? '' : 's'} across ${visibleGroups} location${visibleGroups === 1 ? '' : 's'}. Live changes refresh automatically.`);
  } catch (error) {
    console.error('Megaboard load failed:', error);
    setStatus(`Couldn't load Megaboard (${error.message || error}).`, true);
  } finally {
    if (serial === loadSerial && view) view.classList.remove('mega-loading');
  }
}

function profileFor(driverId) {
  if (!driverId || !lastData) return null;
  return lastData.profiles.get(String(driverId)) || null;
}
function profileName(driverId, fallback) {
  const profile = profileFor(driverId);
  return (profile && profile['Driver Name']) || fallback || '';
}
function profileValue(driverId, column, fallback) {
  const profile = profileFor(driverId);
  const value = profile && profile[column];
  return value != null && String(value).trim() !== '' ? value : fallback;
}

function standardRowsFor(def, date) {
  return lastData.standardShifts
    .filter((row) => row.location === def.location && row.shift_date === date)
    .sort((a, b) => {
      const complete = Number(!!a.shift_complete) - Number(!!b.shift_complete);
      if (complete) return complete;
      return timeSortValue(a.shift_start) - timeSortValue(b.shift_start);
    });
}
function houstonRowsFor(date) {
  return lastData.houstonRows
    .filter((row) => row.shift_date === date)
    .sort((a, b) => {
      const complete = Number(!!a.shift_complete) - Number(!!b.shift_complete);
      if (complete) return complete;
      return timeSortValue(a.time) - timeSortValue(b.time);
    });
}
function mondelezRowsFor(locationKey, date) {
  return lastData.mondelezRows
    .filter((row) => row.location === locationKey && row.shift_date === date)
    .sort((a, b) => {
      const complete = Number(!!a.shift_complete) - Number(!!b.shift_complete);
      if (complete) return complete;
      return timeSortValue(a.start_time) - timeSortValue(b.start_time);
    });
}

function rowsForDef(def, date) {
  if (def.type === 'standard') return standardRowsFor(def, date);
  if (def.type === 'houston') return houstonRowsFor(date);
  return mondelezRowsFor(def.location, date);
}
function countForDef(def) {
  return lastData.dates.reduce((sum, date) => sum + rowsForDef(def, date).length, 0);
}
function countVisibleGroups() {
  if (!lastData) return 0;
  return GROUP_DEFS.filter((def) => countForDef(def) > 0).length;
}

function statusPill(label, kind) {
  return `<span class="mega-status-pill ${esc(kind || '')}">${esc(label)}</span>`;
}
function standardStatus(shift) {
  if (shift.load_cancelled) return statusPill('Cancelled', 'tonu');
  if (shift.called_off) return statusPill('Called Off', 'tonu');
  if (shift.tonu) return statusPill('TONU', 'tonu');
  if (shift.shift_complete) return statusPill('Complete', 'complete');
  return statusPill('Open', 'open');
}
function flatStatus(row) {
  if (row.tonu) return statusPill('TONU', 'tonu');
  if (row.shift_complete) return statusPill('Complete', 'complete');
  return statusPill('Open', 'open');
}
function imageCell(path) {
  return path ? '<span class="mega-image-yes" title="Image attached">▧</span>' : '—';
}

function renderStandardTable(def, shifts) {
  const isDelaware = def.location === 'delaware';
  const isBuildingC = def.location === 'buildingc';
  const extraHeaders = isDelaware ? '' : `
    <th class="mega-trip-cell">Last Stop Depart</th>
    <th class="mega-trip-cell">Return to DC</th>
    <th class="mega-trip-cell">Return ETA to DC</th>`;
  const buildingHeaders = isBuildingC ? '<th>Route Type</th><th>Hostler Hrs</th>' : '';
  const rows = [];

  shifts.forEach((shift) => {
    const realTrips = (lastData.tripsByShift.get(shift.id) || []).filter(meaningfulTrip);
    const routeRows = realTrips.length ? realTrips : [null];
    routeRows.forEach((trip) => {
      const effectiveDriverId = trip?.driver_id || shift.driver_id;
      const driverName = profileName(effectiveDriverId, shift.driver_name_text);
      const mc = profileValue(effectiveDriverId, 'MC', shift.mc_snapshot);
      const cellPhone = profileValue(effectiveDriverId, 'Driver Cell', shift.driver_cell_snapshot);
      const rating = profileValue(effectiveDriverId, 'Driver Rating', shift.driver_rating_snapshot);
      const rowClass = `${shift.shift_complete ? ' mega-complete' : ''}${shift.tonu ? ' mega-tonu' : ''}`;
      const tripComplete = trip ? !!trip.complete : !!shift.shift_complete;
      const tripStatus = trip ? (tripComplete ? statusPill('Complete', 'complete') : statusPill('Open', 'open')) : standardStatus(shift);
      rows.push(`<tr class="${rowClass.trim()}">
        ${cell(shift.pro_number, 'mega-load-cell')}
        ${cell(mc, 'mega-load-cell')}
        ${cell(rating, 'mega-load-cell')}
        ${cell(driverName, 'mega-load-cell')}
        ${cell(cellPhone, 'mega-load-cell')}
        <td class="mega-load-cell">${esc(money(shift.carrier_rate))}</td>
        ${cell(shift.shift_start, 'mega-load-cell')}
        ${cell(shift.eta_shift_report, 'mega-load-cell')}
        ${cell(shift.next_call_time, 'mega-load-cell')}
        ${buildingHeaders ? `${cell(shift.route_type || (shift.birm ? 'BIRM' : ''), 'mega-load-cell')}${cell(shift.hostler_hours, 'mega-load-cell')}` : ''}
        <td class="mega-load-cell mega-notes-cell">${esc(text(shift.notes || shift.comments))}</td>
        ${cell(trip?.route_id, 'mega-trip-cell')}
        ${cell(trip?.trip_id, 'mega-trip-cell')}
        ${cell(trip?.trailer_out, 'mega-trip-cell')}
        ${cell(trip?.route_miles, 'mega-trip-cell')}
        ${cell(trip?.stop_count, 'mega-trip-cell')}
        ${cell(trip?.dispatch_time, 'mega-trip-cell')}
        ${isDelaware ? '' : `${cell(trip?.last_stop_depart, 'mega-trip-cell')}${cell(trip?.return_to_dc, 'mega-trip-cell')}${cell(trip?.return_eta_to_dc, 'mega-trip-cell')}`}
        <td class="mega-trip-cell">${imageCell(trip?.route_image_path)}</td>
        <td class="mega-trip-cell">${tripStatus}</td>
      </tr>`);
    });
  });

  return `<div class="mega-table-scroll"><table class="mega-table mega-standard-table">
    <thead><tr>
      <th>PRO#</th><th>MC #</th><th>Rating</th><th>Driver</th><th>Cell</th><th>Rate</th><th>Shift Start</th><th>ETA</th><th>Next Call</th>${buildingHeaders}<th>Notes</th>
      <th class="mega-trip-cell">Route ID</th><th class="mega-trip-cell">Trip ID</th><th class="mega-trip-cell">Trailer #</th><th class="mega-trip-cell">Miles</th><th class="mega-trip-cell">Stops</th><th class="mega-trip-cell">Dispatch Time</th>${extraHeaders}<th class="mega-trip-cell">Image</th><th class="mega-trip-cell">Status</th>
    </tr></thead>
    <tbody>${rows.join('')}</tbody>
  </table></div>`;
}

function renderHoustonTable(rows) {
  const body = rows.map((row) => {
    const name = profileName(row.driver_id, row.driver_name);
    const phone = profileValue(row.driver_id, 'Driver Cell', row.driver_phone);
    const dispatcher = profileValue(row.driver_id, 'Dispatcher phone number', row.dispatcher_phone);
    const carrier = profileValue(row.driver_id, 'Carrier', row.carrier);
    const mc = profileValue(row.driver_id, 'MC', row.mc);
    const rating = profileValue(row.driver_id, 'Driver Rating', row.rating);
    return `<tr class="${row.shift_complete ? 'mega-complete ' : ''}${row.tonu ? 'mega-tonu' : ''}">
      <td>${esc(money(row.normal_rate))}</td>
      ${cell(row.aljex_number)}${cell(name)}${cell(phone)}${cell(dispatcher)}${cell(carrier)}${cell(mc)}${cell(rating)}${cell(row.time)}${cell(row.ttc)}${cell(row.ttt)}
      <td class="mega-notes-cell">${esc(text(row.comments))}</td>
      <td class="mega-notes-cell">${esc(text(row.time_out_remarks))}</td>
      <td>${imageCell(row.route_image_path)}</td>
      <td>${flatStatus(row)}</td>
    </tr>`;
  }).join('');
  return `<div class="mega-table-scroll"><table class="mega-table">
    <thead><tr><th>Rate</th><th>Aljex #</th><th>Driver</th><th>Phone</th><th>Dispatcher Phone</th><th>Carrier</th><th>MC #</th><th>Rating</th><th>Time</th><th>TTC</th><th>TTT</th><th>Comments</th><th>Time Out / Remarks</th><th>Image</th><th>Status</th></tr></thead>
    <tbody>${body}</tbody>
  </table></div>`;
}

function renderMondelezTable(rows) {
  const body = rows.map((row) => {
    const name = profileName(row.driver_id, row.driver_name);
    const phone = profileValue(row.driver_id, 'Driver Cell', '');
    return `<tr class="${row.shift_complete ? 'mega-complete ' : ''}${row.tonu ? 'mega-tonu' : ''}">
      ${cell(row.aljex_number)}${cell(name)}${cell(phone)}${cell(row.start_time)}${cell(row.delivery_group)}${cell(row.driver_app_id)}${cell(row.trailer_number)}${cell(row.return_trailer_number)}${cell(row.miles)}${cell(row.stop_count)}
      <td>${esc(money(row.fsc))}</td><td>${esc(money(row.revenue_total))}</td><td>${esc(money(row.carrier_pay))}</td>
      <td class="mega-notes-cell">${esc(text(row.notes))}</td>
      <td>${imageCell(row.route_image_path)}</td><td>${flatStatus(row)}</td>
    </tr>`;
  }).join('');
  return `<div class="mega-table-scroll"><table class="mega-table">
    <thead><tr><th>Aljex #</th><th>Driver</th><th>Cell</th><th>Start</th><th>DG#</th><th>Driver App ID</th><th>Trailer #</th><th>Return Trailer #</th><th>Miles</th><th>Stops</th><th>FSC</th><th>Revenue</th><th>Carrier Pay</th><th>Status / Notes</th><th>Route Image</th><th>Status</th></tr></thead>
    <tbody>${body}</tbody>
  </table></div>`;
}

function renderDay(def, date, rows) {
  const table = def.type === 'standard'
    ? renderStandardTable(def, rows)
    : def.type === 'houston'
      ? renderHoustonTable(rows)
      : renderMondelezTable(rows);
  return `<div class="mega-day-block">
    <div class="mega-day-head"><span>${esc(prettyDate(date, true))}</span><span class="mega-day-count">${rows.length} load${rows.length === 1 ? '' : 's'}</span></div>
    ${table}
  </div>`;
}

function renderLocations() {
  const wrap = $('mega-locations');
  if (!wrap || !lastData) return;
  const sections = [];

  GROUP_DEFS.forEach((def) => {
    const dayEntries = lastData.dates
      .map((date) => ({ date, rows: rowsForDef(def, date) }))
      .filter((entry) => entry.rows.length);
    if (!dayEntries.length) return;

    const count = dayEntries.reduce((sum, entry) => sum + entry.rows.length, 0);
    const isCollapsed = collapsed.has(def.key);
    sections.push(`<section class="mega-location${isCollapsed ? ' is-collapsed' : ''}" data-mega-location="${esc(def.key)}">
      <div class="mega-location-head">
        <button type="button" class="mega-location-toggle" data-mega-toggle="${esc(def.key)}" aria-expanded="${isCollapsed ? 'false' : 'true'}">
          <span class="mega-location-chevron">▾</span>
          <span class="mega-location-title">${esc(def.title)}</span>
          <span class="mega-source-badge">${esc(def.source)}</span>
          <span class="mega-count-badge">${count} load${count === 1 ? '' : 's'}</span>
        </button>
        <a class="mega-native-link" href="${esc(def.href)}">Open native board ↗</a>
      </div>
      <div class="mega-location-body">${dayEntries.map((entry) => renderDay(def, entry.date, entry.rows)).join('')}</div>
    </section>`);
  });

  wrap.innerHTML = sections.length
    ? sections.join('')
    : '<div class="mega-empty">No scheduled loads were found on any live load board for the selected day(s).</div>';
}

function toggleLocation(key) {
  if (collapsed.has(key)) collapsed.delete(key); else collapsed.add(key);
  saveCollapsed();
  const section = document.querySelector(`[data-mega-location="${CSS.escape(key)}"]`);
  if (!section) return;
  const isCollapsed = collapsed.has(key);
  section.classList.toggle('is-collapsed', isCollapsed);
  const button = section.querySelector('[data-mega-toggle]');
  if (button) button.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
}

function wireControls() {
  $('mega-date-chips').addEventListener('click', (event) => {
    const button = event.target.closest('[data-mega-date]');
    if (!button) return;
    const key = button.dataset.megaDate;
    if (selectedDates.has(key)) {
      if (selectedDates.size === 1) {
        setStatus('Keep at least one day selected.');
        return;
      }
      selectedDates.delete(key);
    } else {
      selectedDates.add(key);
    }
    renderDateChips();
    loadData();
  });

  $('mega-today-only').addEventListener('click', () => {
    replaceSelectedDates([dateOptions.find((item) => item.isToday).key]);
  });
  $('mega-today-tomorrow').addEventListener('click', () => {
    const today = dateOptions.find((item) => item.isToday);
    const tomorrow = dateOptions.find((item) => item.offset === 1);
    replaceSelectedDates([today.key, tomorrow.key]);
  });
  $('mega-all-days').addEventListener('click', () => replaceSelectedDates(dateOptions.map((item) => item.key)));
  $('mega-refresh').addEventListener('click', loadData);

  $('mega-locations').addEventListener('click', (event) => {
    const toggle = event.target.closest('[data-mega-toggle]');
    if (toggle) toggleLocation(toggle.dataset.megaToggle);
  });

  $('mega-expand-all').addEventListener('click', () => {
    document.querySelectorAll('[data-mega-location]').forEach((section) => collapsed.delete(section.dataset.megaLocation));
    saveCollapsed();
    renderLocations();
  });
  $('mega-collapse-all').addEventListener('click', () => {
    document.querySelectorAll('[data-mega-location]').forEach((section) => collapsed.add(section.dataset.megaLocation));
    saveCollapsed();
    renderLocations();
  });
}

function scheduleRealtimeReload() {
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(loadData, 350);
}

function startRealtime() {
  if (!client || realtimeChannel) return;
  realtimeChannel = client.channel('megaboard-live-v1')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'loads_shifts' }, scheduleRealtimeReload)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'loads_trips' }, scheduleRealtimeReload)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'loads_houston' }, scheduleRealtimeReload)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'mondelez_loads' }, scheduleRealtimeReload)
    .subscribe();
}

async function init() {
  try {
    buildDateOptions();
    renderDateChips();
    wireControls();
    const authenticated = await initAuth();
    if (!authenticated) return;
    await loadData();
    startRealtime();
  } catch (error) {
    console.error('Megaboard initialization failed:', error);
    setStatus(`Megaboard couldn't start (${error.message || error}).`, true);
  }
}

window.addEventListener('beforeunload', () => {
  if (client && realtimeChannel) client.removeChannel(realtimeChannel);
});

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
