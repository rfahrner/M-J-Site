// Rolling operational coverage for Megaboard.
// A selected operational day includes:
//   1) open route work carried over from the prior evening/night, and
//   2) next-calendar-day starts from 00:00 through 04:00.
// These records are shown as route/load tables inside their location sections;
// there is intentionally no separate "running now / running soon" people panel.

const SUPABASE_URL = 'https://ygsapysqzwrpcimgvaqx.supabase.co';
const SUPABASE_KEY = 'sb_publishable_8b8bSIiYm5TzLTw0WG1pAw_5ZWW5ZPL';
const AUTH_STORAGE_KEY = 'dl-dispatch-auth';
const EARLY_AM_CUTOFF = 400;
const CARRYOVER_EARLIEST = 1600;

const STANDARD = {
  atlanta: { key: 'kroger:atlanta', title: 'Atlanta', source: 'Kroger', href: 'index.html' },
  delaware: { key: 'kroger:delaware', title: 'Delaware', source: 'Kroger', href: 'dalaware.html' },
  buildingc: { key: 'kroger:buildingc', title: 'Building C', source: 'Kroger', href: 'buildingc.html' },
};
const HOUSTON = { key: 'kroger:houston', title: 'Houston', source: 'Kroger', href: 'houston.html' };
const MONDELEZ = {
  westchester: 'West Chester',
  morris: 'Morris',
  addison: 'Addison',
  indianapolis: 'Indianapolis',
  louisville: 'Louisville',
  spokane: 'Spokane',
  lasvegas: 'Las Vegas',
  boise: 'Boise',
  kent: 'Kent',
  saltlakecity: 'Salt Lake City',
  newberlin: 'New Berlin',
};

let client = null;
let realtimeChannel = null;
let refreshTimer = null;
let refreshSerial = 0;
let statusObserver = null;
let chipObserver = null;

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
function pad(value) { return String(value).padStart(2, '0'); }
function localDateKey(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
function addDateKey(key, delta) {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d, 12, 0, 0, 0);
  date.setDate(date.getDate() + delta);
  return localDateKey(date);
}
function prettyDate(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}
function selectedDates() {
  return [...document.querySelectorAll('#mega-date-chips [data-mega-date].is-selected')]
    .map((button) => button.dataset.megaDate)
    .filter(Boolean)
    .sort();
}
function clockNumber(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return null;
  const ampm = /\b(am|pm)\b/i.exec(raw)?.[1]?.toLowerCase() || null;
  const colon = raw.match(/(\d{1,2})\s*:\s*(\d{2})/);
  let hour;
  let minute;
  if (colon) {
    hour = Number(colon[1]);
    minute = Number(colon[2]);
  } else {
    const digits = raw.replace(/[^0-9]/g, '');
    if (!digits) return null;
    if (digits.length <= 2) {
      hour = Number(digits);
      minute = 0;
    } else {
      hour = Number(digits.slice(0, -2));
      minute = Number(digits.slice(-2));
    }
  }
  if (ampm) {
    hour %= 12;
    if (ampm === 'pm') hour += 12;
  }
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return hour * 100 + minute;
}
function meaningfulTrip(trip) {
  return !!String(trip?.route_id || trip?.trip_id || '').trim();
}
function inactiveStandard(row) {
  return !!(row.shift_complete || row.tonu || row.called_off || row.load_cancelled);
}
function inactiveFlat(row) {
  return !!(row.shift_complete || row.tonu);
}
function groupBy(rows, fn) {
  const map = new Map();
  (rows || []).forEach((row) => {
    const key = fn(row);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  });
  return map;
}
function currentTrip(tripsByShift, shiftId) {
  const trips = (tripsByShift.get(shiftId) || [])
    .filter(meaningfulTrip)
    .sort((a, b) => Number(a.trip_number || 0) - Number(b.trip_number || 0));
  if (!trips.length) return null;
  const open = trips.filter((trip) => !trip.complete && !trip.minimized);
  return open.length ? open[open.length - 1] : trips[trips.length - 1];
}
function openCurrentTrip(tripsByShift, shiftId) {
  const trips = (tripsByShift.get(shiftId) || [])
    .filter(meaningfulTrip)
    .sort((a, b) => Number(a.trip_number || 0) - Number(b.trip_number || 0));
  const open = trips.filter((trip) => !trip.complete && !trip.minimized);
  return open.length ? open[open.length - 1] : null;
}
function profileFor(profiles, driverId) {
  return driverId ? profiles.get(String(driverId)) || null : null;
}
function profileValue(profiles, driverId, column, fallback = '') {
  const profile = profileFor(profiles, driverId);
  const value = profile?.[column];
  return value != null && String(value).trim() !== '' ? value : fallback;
}
function profileName(profiles, driverId, fallback = '') {
  return profileValue(profiles, driverId, 'Driver Name', fallback);
}
function mondelezMeta(location) {
  const title = MONDELEZ[location];
  if (!title) return null;
  return { key: `mondelez:${location}`, title, source: 'Mondelez', href: `mondelez.html?loc=${encodeURIComponent(location)}` };
}

function standardEntry(shift, trip, profiles, kind, operationalDate) {
  const meta = STANDARD[shift.location];
  if (!meta) return null;
  const driverId = trip?.driver_id || shift.driver_id;
  return {
    type: 'standard', kind, operationalDate, meta,
    id: `standard:${shift.id}`,
    shift, trip,
    driverId,
    driverName: profileName(profiles, driverId, shift.driver_name_text),
    mc: profileValue(profiles, driverId, 'MC', shift.mc_snapshot),
    cellPhone: profileValue(profiles, driverId, 'Driver Cell', shift.driver_cell_snapshot),
  };
}
function houstonEntry(row, profiles, kind, operationalDate) {
  return {
    type: 'houston', kind, operationalDate, meta: HOUSTON,
    id: `houston:${row.id}`, row,
    driverName: profileName(profiles, row.driver_id, row.driver_name),
    phone: profileValue(profiles, row.driver_id, 'Driver Cell', row.driver_phone),
    carrier: profileValue(profiles, row.driver_id, 'Carrier', row.carrier),
    mc: profileValue(profiles, row.driver_id, 'MC', row.mc),
  };
}
function mondelezEntry(row, profiles, kind, operationalDate) {
  const meta = mondelezMeta(row.location);
  if (!meta) return null;
  return {
    type: 'mondelez', kind, operationalDate, meta,
    id: `mondelez:${row.id}`, row,
    driverName: profileName(profiles, row.driver_id, row.driver_name),
    phone: profileValue(profiles, row.driver_id, 'Driver Cell', ''),
  };
}

function buildOperationalEntries(data, dates) {
  const selected = new Set(dates);
  const entries = [];

  for (const operationalDate of dates) {
    const prev = addDateKey(operationalDate, -1);
    const next = addDateKey(operationalDate, 1);

    // Prior-day carryover: show route work that is still genuinely open. For
    // standard boards the open route itself is the proof that it is still live.
    if (!selected.has(prev)) {
      for (const shift of data.standardShifts) {
        if (shift.shift_date !== prev || inactiveStandard(shift)) continue;
        const trip = openCurrentTrip(data.tripsByShift, shift.id);
        if (!trip) continue;
        const start = clockNumber(shift.shift_start);
        const hasDispatch = !!String(trip.dispatch_time || '').trim();
        if (!hasDispatch && start != null && start < CARRYOVER_EARLIEST) continue;
        const entry = standardEntry(shift, trip, data.profiles, 'carryover', operationalDate);
        if (entry) entries.push(entry);
      }
      for (const row of data.houstonRows) {
        const start = clockNumber(row.time);
        if (row.shift_date !== prev || inactiveFlat(row) || start == null || start < CARRYOVER_EARLIEST) continue;
        entries.push(houstonEntry(row, data.profiles, 'carryover', operationalDate));
      }
      for (const row of data.mondelezRows) {
        const start = clockNumber(row.start_time);
        if (row.shift_date !== prev || inactiveFlat(row) || start == null || start < CARRYOVER_EARLIEST) continue;
        const entry = mondelezEntry(row, data.profiles, 'carryover', operationalDate);
        if (entry) entries.push(entry);
      }
    }

    // Next-day handoff: the night shift needs the 00:00–04:00 work on the
    // selected day's board even though its calendar date is technically next day.
    if (!selected.has(next)) {
      for (const shift of data.standardShifts) {
        const start = clockNumber(shift.shift_start);
        if (shift.shift_date !== next || inactiveStandard(shift) || start == null || start > EARLY_AM_CUTOFF) continue;
        const entry = standardEntry(shift, currentTrip(data.tripsByShift, shift.id), data.profiles, 'early', operationalDate);
        if (entry) entries.push(entry);
      }
      for (const row of data.houstonRows) {
        const start = clockNumber(row.time);
        if (row.shift_date !== next || inactiveFlat(row) || start == null || start > EARLY_AM_CUTOFF) continue;
        entries.push(houstonEntry(row, data.profiles, 'early', operationalDate));
      }
      for (const row of data.mondelezRows) {
        const start = clockNumber(row.start_time);
        if (row.shift_date !== next || inactiveFlat(row) || start == null || start > EARLY_AM_CUTOFF) continue;
        const entry = mondelezEntry(row, data.profiles, 'early', operationalDate);
        if (entry) entries.push(entry);
      }
    }
  }

  const seen = new Set();
  return entries.filter((entry) => {
    const key = `${entry.operationalDate}|${entry.id}|${entry.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function imageCell(path) {
  return path ? '<span class="mega-image-yes" title="Image attached">▧</span>' : '—';
}
function statusPill(label, kind) {
  return `<span class="mega-status-pill ${esc(kind || '')}">${esc(label)}</span>`;
}
function sourceBadge(entry) {
  return entry.kind === 'carryover'
    ? '<span class="mega-operational-badge carryover">OVERNIGHT</span>'
    : '<span class="mega-operational-badge early">EARLY AM</span>';
}
function standardTable(entries) {
  const hasNonDelaware = entries.some((entry) => entry.shift.location !== 'delaware');
  const body = entries.map((entry) => {
    const { shift, trip } = entry;
    const building = shift.location === 'buildingc';
    const nonDelaware = shift.location !== 'delaware';
    return `<tr>
      <td>${sourceBadge(entry)}</td>
      ${cell(trip?.route_id, 'mega-trip-cell')}
      ${cell(trip?.trip_id, 'mega-trip-cell')}
      ${cell(trip?.trailer_out, 'mega-trip-cell')}
      ${cell(trip?.route_miles, 'mega-trip-cell')}
      ${cell(trip?.stop_count, 'mega-trip-cell')}
      ${cell(trip?.dispatch_time, 'mega-trip-cell')}
      ${hasNonDelaware ? cell(nonDelaware ? trip?.last_stop_depart : '', 'mega-trip-cell') : ''}
      ${hasNonDelaware ? cell(nonDelaware ? trip?.return_to_dc : '', 'mega-trip-cell') : ''}
      ${hasNonDelaware ? cell(nonDelaware ? trip?.return_eta_to_dc : '', 'mega-trip-cell') : ''}
      <td class="mega-trip-cell">${imageCell(trip?.route_image_path)}</td>
      ${cell(shift.pro_number, 'mega-load-cell')}
      ${cell(entry.driverName, 'mega-load-cell')}
      ${cell(entry.mc, 'mega-load-cell')}
      ${cell(entry.cellPhone, 'mega-load-cell')}
      ${cell(shift.shift_start, 'mega-load-cell')}
      ${building ? cell(shift.route_type || (shift.birm ? 'BIRM' : ''), 'mega-load-cell') : ''}
      <td class="mega-load-cell mega-notes-cell">${esc(text(shift.notes || shift.comments))}</td>
      <td>${statusPill(entry.kind === 'carryover' ? 'Open' : 'Scheduled', entry.kind === 'carryover' ? 'open' : '')}</td>
    </tr>`;
  }).join('');

  const buildingHeader = entries.some((entry) => entry.shift.location === 'buildingc') ? '<th>Route Type</th>' : '';
  return `<div class="mega-table-scroll"><table class="mega-table mega-operational-table">
    <thead><tr>
      <th>Window</th><th>Route ID</th><th>Trip ID</th><th>Trailer #</th><th>Miles</th><th>Stops</th><th>Dispatch Time</th>
      ${hasNonDelaware ? '<th>Last Stop Depart</th><th>Return to DC</th><th>Return ETA</th>' : ''}
      <th>Image</th><th>PRO#</th><th>Driver</th><th>MC #</th><th>Cell</th><th>Shift Start</th>${buildingHeader}<th>Notes</th><th>Status</th>
    </tr></thead><tbody>${body}</tbody>
  </table></div>`;
}
function houstonTable(entries) {
  const body = entries.map((entry) => {
    const row = entry.row;
    return `<tr>
      <td>${sourceBadge(entry)}</td>
      ${cell(row.aljex_number)}${cell(row.time)}${cell(row.ttc)}${cell(row.ttt)}
      ${cell(entry.carrier)}${cell(entry.mc)}${cell(entry.driverName)}${cell(entry.phone)}
      <td class="mega-notes-cell">${esc(text(row.comments))}</td>
      <td class="mega-notes-cell">${esc(text(row.time_out_remarks))}</td>
      <td>${imageCell(row.route_image_path)}</td><td>${statusPill(entry.kind === 'carryover' ? 'Open' : 'Scheduled', entry.kind === 'carryover' ? 'open' : '')}</td>
    </tr>`;
  }).join('');
  return `<div class="mega-table-scroll"><table class="mega-table mega-operational-table">
    <thead><tr><th>Window</th><th>Aljex #</th><th>Time</th><th>TTC</th><th>TTT</th><th>Carrier</th><th>MC #</th><th>Driver</th><th>Phone</th><th>Comments</th><th>Time Out / Remarks</th><th>Image</th><th>Status</th></tr></thead>
    <tbody>${body}</tbody></table></div>`;
}
function mondelezTable(entries) {
  const body = entries.map((entry) => {
    const row = entry.row;
    return `<tr>
      <td>${sourceBadge(entry)}</td>
      ${cell(row.delivery_group)}${cell(row.aljex_number)}${cell(row.trailer_number)}${cell(row.return_trailer_number)}${cell(row.miles)}${cell(row.stop_count)}${cell(row.start_time)}
      ${cell(entry.driverName)}${cell(entry.phone)}
      <td class="mega-notes-cell">${esc(text(row.notes))}</td>
      <td>${imageCell(row.route_image_path)}</td><td>${statusPill(entry.kind === 'carryover' ? 'Open' : 'Scheduled', entry.kind === 'carryover' ? 'open' : '')}</td>
    </tr>`;
  }).join('');
  return `<div class="mega-table-scroll"><table class="mega-table mega-operational-table">
    <thead><tr><th>Window</th><th>DG# / Route</th><th>Aljex #</th><th>Trailer #</th><th>Return Trailer #</th><th>Miles</th><th>Stops</th><th>Start</th><th>Driver</th><th>Cell</th><th>Notes</th><th>Route Image</th><th>Status</th></tr></thead>
    <tbody>${body}</tbody></table></div>`;
}
function renderOperationalBlock(entries, operationalDate) {
  const carry = entries.filter((entry) => entry.kind === 'carryover').length;
  const early = entries.filter((entry) => entry.kind === 'early').length;
  const table = entries[0]?.type === 'standard'
    ? standardTable(entries)
    : entries[0]?.type === 'houston'
      ? houstonTable(entries)
      : mondelezTable(entries);
  const summary = [
    carry ? `${carry} overnight route${carry === 1 ? '' : 's'}` : '',
    early ? `${early} early-AM route${early === 1 ? '' : 's'}` : '',
  ].filter(Boolean).join(' · ');
  return `<div class="mega-day-block mega-operational-extra" data-mega-operational-date="${esc(operationalDate)}">
    <div class="mega-day-head"><span>Operational coverage for ${esc(prettyDate(operationalDate))}</span><span class="mega-day-count">${esc(summary)}</span></div>
    ${table}
  </div>`;
}

function removeInjected() {
  document.querySelectorAll('.mega-operational-extra').forEach((node) => node.remove());
  document.querySelectorAll('.mega-location[data-mega-rolling-only="true"]').forEach((node) => node.remove());
  document.getElementById('mega-live-timeline')?.remove();
}
function locationSection(meta) {
  return document.querySelector(`#mega-locations [data-mega-location="${CSS.escape(meta.key)}"]`);
}
function ensureSection(entry) {
  let section = locationSection(entry.meta);
  if (section) return section;
  const wrap = document.getElementById('mega-locations');
  if (!wrap) return null;
  section = document.createElement('section');
  section.className = 'mega-location';
  section.dataset.megaLocation = entry.meta.key;
  section.dataset.megaRollingOnly = 'true';
  section.innerHTML = `<div class="mega-location-head">
    <div class="mega-location-toggle mega-operational-static-head">
      <span class="mega-location-chevron">▾</span>
      <span class="mega-location-title">${esc(entry.meta.title)}</span>
      <span class="mega-source-badge">${esc(entry.meta.source)}</span>
      <span class="mega-count-badge">Operational coverage</span>
    </div>
    <a class="mega-native-link" href="${esc(entry.meta.href)}">Open native board ↗</a>
  </div><div class="mega-location-body"></div>`;
  wrap.appendChild(section);
  return section;
}
function injectOperationalRoutes(entries) {
  removeInjected();
  if (!entries.length) return;
  const grouped = groupBy(entries, (entry) => `${entry.meta.key}|${entry.operationalDate}`);
  for (const [, group] of grouped) {
    const section = ensureSection(group[0]);
    const body = section?.querySelector('.mega-location-body');
    if (!body) continue;
    const holder = document.createElement('div');
    holder.innerHTML = renderOperationalBlock(group, group[0].operationalDate);
    body.insertBefore(holder.firstElementChild, body.firstChild);
  }
}

async function fetchOperationalData(dates) {
  const queryDates = new Set();
  dates.forEach((key) => {
    queryDates.add(addDateKey(key, -1));
    queryDates.add(key);
    queryDates.add(addDateKey(key, 1));
  });
  const wanted = [...queryDates].sort();
  const [shiftResult, houstonResult, mondelezResult] = await Promise.all([
    client.from('loads_shifts').select('*').in('shift_date', wanted).limit(7000),
    client.from('loads_houston').select('*').in('shift_date', wanted).limit(7000),
    client.from('mondelez_loads').select('*').in('shift_date', wanted).limit(7000),
  ]);
  const firstError = shiftResult.error || houstonResult.error || mondelezResult.error;
  if (firstError) throw firstError;

  const standardShifts = (shiftResult.data || []).filter((row) => STANDARD[row.location]);
  const shiftIds = standardShifts.map((row) => row.id);
  const tripResult = shiftIds.length
    ? await client.from('loads_trips').select('*').in('shift_id', shiftIds).limit(12000)
    : { data: [], error: null };
  if (tripResult.error) throw tripResult.error;
  const trips = tripResult.data || [];
  const tripsByShift = groupBy(trips, (row) => row.shift_id);

  const driverIds = new Set();
  standardShifts.forEach((row) => { if (row.driver_id) driverIds.add(Number(row.driver_id)); });
  trips.forEach((row) => { if (row.driver_id) driverIds.add(Number(row.driver_id)); });
  (houstonResult.data || []).forEach((row) => { if (row.driver_id) driverIds.add(Number(row.driver_id)); });
  (mondelezResult.data || []).forEach((row) => { if (row.driver_id) driverIds.add(Number(row.driver_id)); });

  let profiles = [];
  if (driverIds.size) {
    const profileResult = await client.from('atlanta_drivers')
      .select('id,"Driver Name","Driver Cell","MC","Carrier"')
      .in('id', [...driverIds]).limit(5000);
    if (!profileResult.error) profiles = profileResult.data || [];
  }

  return {
    standardShifts,
    houstonRows: houstonResult.data || [],
    mondelezRows: mondelezResult.data || [],
    tripsByShift,
    profiles: new Map(profiles.map((row) => [String(row.id), row])),
  };
}

async function refreshOperationalWindow() {
  if (!client) return;
  const dates = selectedDates();
  if (!dates.length) return;
  const serial = ++refreshSerial;
  try {
    const data = await fetchOperationalData(dates);
    if (serial !== refreshSerial) return;
    injectOperationalRoutes(buildOperationalEntries(data, dates));
  } catch (error) {
    console.error('Megaboard operational window failed:', error);
  }
}
function scheduleRefresh(delay = 180) {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshOperationalWindow, delay);
}
function wireObservers() {
  const status = document.getElementById('mega-status');
  if (status) {
    statusObserver = new MutationObserver(() => scheduleRefresh(120));
    statusObserver.observe(status, { childList: true, characterData: true, subtree: true });
  }
  const chips = document.getElementById('mega-date-chips');
  if (chips) {
    chipObserver = new MutationObserver(() => scheduleRefresh(100));
    chipObserver.observe(chips, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'aria-pressed'] });
  }
}
function startRealtime() {
  if (!client || realtimeChannel) return;
  realtimeChannel = client.channel('megaboard-operational-window-v2')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'loads_shifts' }, () => scheduleRefresh(250))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'loads_trips' }, () => scheduleRefresh(250))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'loads_houston' }, () => scheduleRefresh(250))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'mondelez_loads' }, () => scheduleRefresh(250))
    .subscribe();
}

async function init() {
  try {
    document.getElementById('mega-live-timeline')?.remove();
    if (!window.supabase) return;
    client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, storageKey: AUTH_STORAGE_KEY },
    });
    const { data } = await client.auth.getSession();
    if (!data?.session) return;
    wireObservers();
    startRealtime();
    scheduleRefresh(250);
  } catch (error) {
    console.error('Megaboard operational window init failed:', error);
  }
}

window.addEventListener('beforeunload', () => {
  if (statusObserver) statusObserver.disconnect();
  if (chipObserver) chipObserver.disconnect();
  if (client && realtimeChannel) client.removeChannel(realtimeChannel);
});

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
