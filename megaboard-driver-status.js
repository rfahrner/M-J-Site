// Compact driver-status strip under each Megaboard location header.
// Green = currently within the 12-hour operating window.
// Orange = scheduled later today or in the next-day 00:00-04:00 handoff window.
// Red = the shift has been completed or its 12-hour operating window has elapsed.

const SUPABASE_URL = 'https://ygsapysqzwrpcimgvaqx.supabase.co';
const SUPABASE_KEY = 'sb_publishable_8b8bSIiYm5TzLTw0WG1pAw_5ZWW5ZPL';
const AUTH_STORAGE_KEY = 'dl-dispatch-auth';
const MAX_RUNNING_HOURS = 12;
const EARLY_AM_CUTOFF_MINUTES = 4 * 60;

const LOCATIONS = {
  'kroger:atlanta': { type: 'standard', location: 'atlanta', title: 'Atlanta', source: 'Kroger', href: 'index.html', timeZone: 'America/New_York' },
  'kroger:delaware': { type: 'standard', location: 'delaware', title: 'Delaware', source: 'Kroger', href: 'dalaware.html', timeZone: 'America/New_York' },
  'kroger:buildingc': { type: 'standard', location: 'buildingc', title: 'Building C', source: 'Kroger', href: 'buildingc.html', timeZone: 'America/New_York' },
  'kroger:houston': { type: 'houston', location: 'houston', title: 'Houston', source: 'Kroger', href: 'houston.html', timeZone: 'America/Chicago' },
  'mondelez:westchester': { type: 'mondelez', location: 'westchester', title: 'West Chester', source: 'Mondelez', href: 'mondelez.html?loc=westchester', timeZone: 'America/New_York' },
  'mondelez:morris': { type: 'mondelez', location: 'morris', title: 'Morris', source: 'Mondelez', href: 'mondelez.html?loc=morris', timeZone: 'America/Chicago' },
  'mondelez:addison': { type: 'mondelez', location: 'addison', title: 'Addison', source: 'Mondelez', href: 'mondelez.html?loc=addison', timeZone: 'America/Chicago' },
  'mondelez:indianapolis': { type: 'mondelez', location: 'indianapolis', title: 'Indianapolis', source: 'Mondelez', href: 'mondelez.html?loc=indianapolis', timeZone: 'America/Indiana/Indianapolis' },
  'mondelez:louisville': { type: 'mondelez', location: 'louisville', title: 'Louisville', source: 'Mondelez', href: 'mondelez.html?loc=louisville', timeZone: 'America/Kentucky/Louisville' },
  'mondelez:spokane': { type: 'mondelez', location: 'spokane', title: 'Spokane', source: 'Mondelez', href: 'mondelez.html?loc=spokane', timeZone: 'America/Los_Angeles' },
  'mondelez:lasvegas': { type: 'mondelez', location: 'lasvegas', title: 'Las Vegas', source: 'Mondelez', href: 'mondelez.html?loc=lasvegas', timeZone: 'America/Los_Angeles' },
  'mondelez:boise': { type: 'mondelez', location: 'boise', title: 'Boise', source: 'Mondelez', href: 'mondelez.html?loc=boise', timeZone: 'America/Boise' },
  'mondelez:kent': { type: 'mondelez', location: 'kent', title: 'Kent', source: 'Mondelez', href: 'mondelez.html?loc=kent', timeZone: 'America/Los_Angeles' },
  'mondelez:saltlakecity': { type: 'mondelez', location: 'saltlakecity', title: 'Salt Lake City', source: 'Mondelez', href: 'mondelez.html?loc=saltlakecity', timeZone: 'America/Denver' },
  'mondelez:newberlin': { type: 'mondelez', location: 'newberlin', title: 'New Berlin', source: 'Mondelez', href: 'mondelez.html?loc=newberlin', timeZone: 'America/Chicago' },
};

let client = null;
let model = new Map();
let realtime = null;
let refreshTimer = null;
let minuteTimer = null;
let domObserver = null;
let renderScheduled = false;

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
function norm(value) {
  const raw = String(value == null ? '' : value).trim();
  return raw === '—' ? '' : raw;
}
function parseClock(value) {
  const raw = norm(value);
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
  return { hour, minute };
}
function timeZoneOffsetMs(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date);
  const pick = (type) => Number(parts.find((part) => part.type === type)?.value || 0);
  const asUtc = Date.UTC(pick('year'), pick('month') - 1, pick('day'), pick('hour') % 24, pick('minute'), pick('second'));
  return asUtc - date.getTime();
}
function zonedDateTime(dateKey, clockValue, timeZone) {
  const clock = parseClock(clockValue);
  if (!clock || !/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || ''))) return null;
  const [year, month, day] = dateKey.split('-').map(Number);
  const wallUtc = Date.UTC(year, month - 1, day, clock.hour, clock.minute, 0);
  let guess = new Date(wallUtc);
  let offset = timeZoneOffsetMs(guess, timeZone);
  guess = new Date(wallUtc - offset);
  const secondOffset = timeZoneOffsetMs(guess, timeZone);
  if (secondOffset !== offset) guess = new Date(wallUtc - secondOffset);
  return guess;
}
function localDateKey(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const pick = (type) => parts.find((part) => part.type === type)?.value || '';
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}
function addDateKey(key, delta) {
  const [y, m, d] = String(key || '').split('-').map(Number);
  if (![y, m, d].every(Number.isFinite)) return '';
  const date = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}
function formatStart(date, timeZone) {
  return date.toLocaleTimeString('en-US', { timeZone, hour: 'numeric', minute: '2-digit' });
}
function isCancelledStandard(row) {
  return !!(row.tonu || row.called_off || row.load_cancelled);
}
function isCancelledFlat(row) {
  return !!row.tonu;
}
function meaningfulTrip(trip) {
  return !!String(trip?.route_id || trip?.trip_id || '').trim();
}
function groupBy(rows, fn) {
  const out = new Map();
  (rows || []).forEach((row) => {
    const key = fn(row);
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(row);
  });
  return out;
}
function currentTrip(tripsByShift, shiftId) {
  const trips = (tripsByShift.get(shiftId) || [])
    .filter(meaningfulTrip)
    .sort((a, b) => Number(a.trip_number || 0) - Number(b.trip_number || 0));
  if (!trips.length) return null;
  const open = trips.filter((trip) => !trip.complete && !trip.minimized);
  return open.length ? open[open.length - 1] : trips[trips.length - 1];
}
function profileName(profiles, driverId, fallback) {
  const profile = driverId ? profiles.get(String(driverId)) : null;
  return norm(profile?.['Driver Name']) || norm(fallback);
}
function driverKey(driverId, driverName) {
  return driverId ? `id:${driverId}` : `name:${String(driverName || '').trim().toLowerCase()}`;
}
function priority(status) {
  return status === 'running' ? 3 : status === 'upcoming' ? 2 : 1;
}

function relevantShift(meta, dateKey, start, now) {
  const today = localDateKey(now, meta.timeZone);
  const prev = addDateKey(today, -1);
  const next = addDateKey(today, 1);
  if (dateKey === today) return true;
  if (dateKey === next) {
    const clock = parseClock(start);
    return !!clock && (clock.hour * 60 + clock.minute) <= EARLY_AM_CUTOFF_MINUTES;
  }
  if (dateKey === prev) {
    const startDate = zonedDateTime(dateKey, start, meta.timeZone);
    if (!startDate) return false;
    const todayStart = zonedDateTime(today, '00:00', meta.timeZone);
    return !!todayStart && startDate.getTime() + MAX_RUNNING_HOURS * 3600000 >= todayStart.getTime();
  }
  return false;
}
function classify(startDate, complete, now) {
  if (complete) return 'ended';
  if (startDate.getTime() > now.getTime()) return 'upcoming';
  return now.getTime() - startDate.getTime() <= MAX_RUNNING_HOURS * 3600000 ? 'running' : 'ended';
}
function pushDriver(map, item) {
  if (!item.name) return;
  const key = driverKey(item.driverId, item.name);
  const existing = map.get(key);
  if (!existing || priority(item.status) > priority(existing.status) ||
      (priority(item.status) === priority(existing.status) && item.startDate.getTime() > existing.startDate.getTime())) {
    map.set(key, item);
  }
}

function buildModel(data) {
  const now = new Date();
  const output = new Map();
  const getMap = (key) => {
    if (!output.has(key)) output.set(key, new Map());
    return output.get(key);
  };

  for (const shift of data.standardShifts) {
    const locationKey = `kroger:${shift.location}`;
    const meta = LOCATIONS[locationKey];
    if (!meta || isCancelledStandard(shift)) continue;
    if (!relevantShift(meta, shift.shift_date, shift.shift_start, now)) continue;
    const startDate = zonedDateTime(shift.shift_date, shift.shift_start, meta.timeZone);
    if (!startDate) continue;
    const trip = currentTrip(data.tripsByShift, shift.id);
    const driverId = trip?.driver_id || shift.driver_id;
    const name = profileName(data.profiles, driverId, shift.driver_name_text);
    const status = classify(startDate, !!shift.shift_complete, now);
    pushDriver(getMap(locationKey), {
      status, startDate, driverId, name,
      startLabel: formatStart(startDate, meta.timeZone),
      load: norm(shift.pro_number),
      route: norm(trip?.trip_id) || norm(trip?.route_id),
    });
  }

  for (const row of data.houstonRows) {
    const locationKey = 'kroger:houston';
    const meta = LOCATIONS[locationKey];
    if (isCancelledFlat(row) || !relevantShift(meta, row.shift_date, row.time, now)) continue;
    const startDate = zonedDateTime(row.shift_date, row.time, meta.timeZone);
    if (!startDate) continue;
    const name = profileName(data.profiles, row.driver_id, row.driver_name);
    pushDriver(getMap(locationKey), {
      status: classify(startDate, !!row.shift_complete, now), startDate,
      driverId: row.driver_id, name, startLabel: formatStart(startDate, meta.timeZone),
      load: norm(row.aljex_number), route: '',
    });
  }

  for (const row of data.mondelezRows) {
    const locationKey = `mondelez:${row.location}`;
    const meta = LOCATIONS[locationKey];
    if (!meta || isCancelledFlat(row) || !relevantShift(meta, row.shift_date, row.start_time, now)) continue;
    const startDate = zonedDateTime(row.shift_date, row.start_time, meta.timeZone);
    if (!startDate) continue;
    const name = profileName(data.profiles, row.driver_id, row.driver_name);
    pushDriver(getMap(locationKey), {
      status: classify(startDate, !!row.shift_complete, now), startDate,
      driverId: row.driver_id, name, startLabel: formatStart(startDate, meta.timeZone),
      load: norm(row.aljex_number), route: norm(row.delivery_group),
    });
  }

  const final = new Map();
  output.forEach((drivers, locationKey) => {
    const list = [...drivers.values()].sort((a, b) => {
      const p = priority(b.status) - priority(a.status);
      if (p) return p;
      if (a.status === 'ended') return b.startDate - a.startDate;
      return a.startDate - b.startDate;
    });
    if (list.length) final.set(locationKey, list);
  });
  return final;
}

function chipHtml(item) {
  const label = item.status === 'running' ? 'RUNNING' : item.status === 'upcoming' ? 'UPCOMING' : 'ENDED';
  const details = [item.load, item.route].filter(Boolean).map((value) => `<span class="mega-driver-status-id">${esc(value)}</span>`).join('');
  return `<div class="mega-driver-status-chip ${item.status}" title="${esc(`${label}: ${item.name} · ${item.startLabel} start`)}">
    <span class="mega-driver-status-label">${label}</span>
    <strong>${esc(item.name)}</strong>
    ${details}
    <span class="mega-driver-status-time">${esc(item.startLabel)} start</span>
  </div>`;
}
function sectionFor(locationKey) {
  return document.querySelector(`#mega-locations .mega-location[data-mega-location="${CSS.escape(locationKey)}"]`);
}
function ensureSection(locationKey) {
  let section = sectionFor(locationKey);
  if (section) return section;
  const meta = LOCATIONS[locationKey];
  const wrap = document.getElementById('mega-locations');
  if (!meta || !wrap) return null;
  section = document.createElement('section');
  section.className = 'mega-location';
  section.dataset.megaLocation = locationKey;
  section.dataset.megaDriverOnly = 'true';
  section.innerHTML = `<div class="mega-location-head">
    <div class="mega-location-toggle mega-driver-only-head">
      <span class="mega-location-chevron">▾</span>
      <span class="mega-location-title">${esc(meta.title)}</span>
      <span class="mega-source-badge">${esc(meta.source)}</span>
      <span class="mega-count-badge">Driver status</span>
    </div>
    <a class="mega-native-link" href="${esc(meta.href)}">Open native board ↗</a>
  </div><div class="mega-location-body"></div>`;
  wrap.appendChild(section);
  return section;
}
function observeDom() {
  const root = document.getElementById('mega-locations');
  if (!root || !domObserver) return;
  domObserver.observe(root, { childList: true, subtree: true });
}
function renderStrips() {
  if (domObserver) domObserver.disconnect();
  document.querySelectorAll('.mega-driver-status-strip').forEach((node) => node.remove());
  document.querySelectorAll('.mega-location[data-mega-driver-only="true"]').forEach((section) => {
    const key = section.dataset.megaLocation;
    if (!model.has(key)) section.remove();
  });

  model.forEach((items, locationKey) => {
    const section = ensureSection(locationKey);
    const head = section?.querySelector('.mega-location-head');
    if (!section || !head || !items.length) return;
    const strip = document.createElement('div');
    strip.className = 'mega-driver-status-strip';
    strip.innerHTML = items.map(chipHtml).join('');
    head.insertAdjacentElement('afterend', strip);
  });
  observeDom();
}
function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    renderStrips();
  });
}

async function refreshData() {
  if (!client) return;
  const browserToday = new Date();
  const dateKeys = [];
  for (let i = -2; i <= 2; i += 1) {
    const d = new Date(browserToday.getFullYear(), browserToday.getMonth(), browserToday.getDate() + i, 12, 0, 0);
    dateKeys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  }
  const [shiftResult, houstonResult, mondelezResult] = await Promise.all([
    client.from('loads_shifts').select('*').in('shift_date', dateKeys).limit(7000),
    client.from('loads_houston').select('*').in('shift_date', dateKeys).limit(7000),
    client.from('mondelez_loads').select('*').in('shift_date', dateKeys).limit(7000),
  ]);
  const firstError = shiftResult.error || houstonResult.error || mondelezResult.error;
  if (firstError) throw firstError;

  const standardShifts = shiftResult.data || [];
  const shiftIds = standardShifts.map((row) => row.id);
  const tripResult = shiftIds.length
    ? await client.from('loads_trips').select('*').in('shift_id', shiftIds).limit(12000)
    : { data: [], error: null };
  if (tripResult.error) throw tripResult.error;
  const trips = tripResult.data || [];
  const tripsByShift = groupBy(trips, (trip) => trip.shift_id);

  const driverIds = new Set();
  standardShifts.forEach((row) => { if (row.driver_id) driverIds.add(Number(row.driver_id)); });
  trips.forEach((row) => { if (row.driver_id) driverIds.add(Number(row.driver_id)); });
  (houstonResult.data || []).forEach((row) => { if (row.driver_id) driverIds.add(Number(row.driver_id)); });
  (mondelezResult.data || []).forEach((row) => { if (row.driver_id) driverIds.add(Number(row.driver_id)); });

  let profiles = [];
  if (driverIds.size) {
    const profileResult = await client.from('atlanta_drivers').select('id,"Driver Name"').in('id', [...driverIds]).limit(5000);
    if (!profileResult.error) profiles = profileResult.data || [];
  }

  model = buildModel({
    standardShifts,
    houstonRows: houstonResult.data || [],
    mondelezRows: mondelezResult.data || [],
    tripsByShift,
    profiles: new Map(profiles.map((row) => [String(row.id), row])),
  });
  renderStrips();
}
function scheduleRefresh(delay = 180) {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshData().catch((error) => console.error('Megaboard driver status refresh failed:', error));
  }, delay);
}
function installStyles() {
  if (document.getElementById('mega-driver-status-style')) return;
  const style = document.createElement('style');
  style.id = 'mega-driver-status-style';
  style.textContent = `
    .mega-driver-status-strip { display:flex; align-items:center; gap:7px; overflow-x:auto; padding:6px 10px; background:#fff; border-bottom:1px solid #d8dee8; scrollbar-width:thin; }
    .mega-driver-status-chip { display:inline-flex; align-items:center; gap:7px; flex:0 0 auto; min-height:30px; padding:4px 9px; border:1px solid #d0d7e2; border-left-width:4px; border-radius:6px; background:#fff; color:#172542; font-size:11px; white-space:nowrap; }
    .mega-driver-status-chip.running { border-left-color:#16a34a; background:#f7fdf8; }
    .mega-driver-status-chip.upcoming { border-left-color:#f59e0b; background:#fffbeb; }
    .mega-driver-status-chip.ended { border-left-color:#dc2626; background:#fff7f7; }
    .mega-driver-status-label { padding:2px 5px; border-radius:999px; font-size:9px; font-weight:900; letter-spacing:.05em; }
    .mega-driver-status-chip.running .mega-driver-status-label { background:#dcfce7; color:#15803d; }
    .mega-driver-status-chip.upcoming .mega-driver-status-label { background:#ffedd5; color:#c2410c; }
    .mega-driver-status-chip.ended .mega-driver-status-label { background:#fee2e2; color:#b91c1c; }
    .mega-driver-status-id, .mega-driver-status-time { color:#52647c; }
    .mega-driver-status-time { margin-left:1px; }
    .mega-driver-only-head { cursor:default; }
    .mega-location.is-collapsed > .mega-driver-status-strip { display:flex; }
  `;
  document.head.appendChild(style);
}

async function init() {
  installStyles();
  const root = document.getElementById('mega-locations');
  if (root) {
    domObserver = new MutationObserver(scheduleRender);
    observeDom();
  }
  if (!window.supabase) return;
  client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: AUTH_STORAGE_KEY },
  });
  const { data } = await client.auth.getSession();
  if (!data?.session) return;
  await refreshData();
  realtime = client.channel('megaboard-driver-status-v1')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'loads_shifts' }, () => scheduleRefresh(200))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'loads_trips' }, () => scheduleRefresh(200))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'loads_houston' }, () => scheduleRefresh(200))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'mondelez_loads' }, () => scheduleRefresh(200))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'atlanta_drivers' }, () => scheduleRefresh(250))
    .subscribe();
  minuteTimer = setInterval(() => scheduleRefresh(0), 60000);
}

window.addEventListener('beforeunload', () => {
  if (domObserver) domObserver.disconnect();
  if (minuteTimer) clearInterval(minuteTimer);
  if (client && realtime) client.removeChannel(realtime);
});

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();