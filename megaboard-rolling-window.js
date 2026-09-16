// Rolling operational window for Megaboard.
// The normal date view remains intact, but the selected day also surfaces:
//   1) active carryover work from the prior evening/night, and
//   2) next-calendar-day starts from 00:00 through 04:00.
// It also adds a compact live timeline for Today: active loads + what starts next.

const SUPABASE_URL = 'https://ygsapysqzwrpcimgvaqx.supabase.co';
const SUPABASE_KEY = 'sb_publishable_8b8bSIiYm5TzLTw0WG1pAw_5ZWW5ZPL';
const AUTH_STORAGE_KEY = 'dl-dispatch-auth';
const EARLY_AM_CUTOFF = 400;
const CARRYOVER_EARLIEST = 1600;

const STANDARD = {
  atlanta: { key: 'kroger:atlanta', title: 'Atlanta', source: 'Kroger', href: 'index.html', timeZone: 'America/New_York' },
  delaware: { key: 'kroger:delaware', title: 'Delaware', source: 'Kroger', href: 'dalaware.html', timeZone: 'America/New_York' },
  buildingc: { key: 'kroger:buildingc', title: 'Building C', source: 'Kroger', href: 'buildingc.html', timeZone: 'America/New_York' },
};
const HOUSTON = { key: 'kroger:houston', title: 'Houston', source: 'Kroger', href: 'houston.html', timeZone: 'America/Chicago' };
const MONDELEZ = {
  westchester: { title: 'West Chester', timeZone: 'America/New_York' },
  morris: { title: 'Morris', timeZone: 'America/Chicago' },
  addison: { title: 'Addison', timeZone: 'America/Chicago' },
  indianapolis: { title: 'Indianapolis', timeZone: 'America/Indiana/Indianapolis' },
  louisville: { title: 'Louisville', timeZone: 'America/Kentucky/Louisville' },
  spokane: { title: 'Spokane', timeZone: 'America/Los_Angeles' },
  lasvegas: { title: 'Las Vegas', timeZone: 'America/Los_Angeles' },
  boise: { title: 'Boise', timeZone: 'America/Boise' },
  kent: { title: 'Kent', timeZone: 'America/Los_Angeles' },
  saltlakecity: { title: 'Salt Lake City', timeZone: 'America/Denver' },
  newberlin: { title: 'New Berlin', timeZone: 'America/Chicago' },
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
function pad(value) { return String(value).padStart(2, '0'); }
function dateKey(date) { return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`; }
function addDateKey(key, delta) {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d, 12, 0, 0, 0);
  date.setDate(date.getDate() + delta);
  return dateKey(date);
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
  const match = raw.match(/(\d{1,2})(?:\s*:\s*(\d{2}))?/);
  let hour;
  let minute;
  if (match && (raw.includes(':') || ampm)) {
    hour = Number(match[1]);
    minute = Number(match[2] || 0);
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
function prettyClock(value) {
  const n = clockNumber(value);
  if (n == null) return String(value || '—');
  const hour24 = Math.floor(n / 100);
  const minute = n % 100;
  const suffix = hour24 >= 12 ? 'PM' : 'AM';
  const hour = hour24 % 12 || 12;
  return `${hour}:${pad(minute)} ${suffix}`;
}
function meaningfulTrip(trip) { return !!String(trip?.route_id || trip?.trip_id || '').trim(); }
function inactiveStandard(row) { return !!(row.shift_complete || row.tonu || row.called_off || row.load_cancelled); }
function inactiveFlat(row) { return !!(row.shift_complete || row.tonu); }

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
function zonedDateTime(key, clockValue, timeZone) {
  const n = clockNumber(clockValue);
  if (n == null || !/^\d{4}-\d{2}-\d{2}$/.test(String(key || ''))) return null;
  const [year, month, day] = key.split('-').map(Number);
  const wallUtc = Date.UTC(year, month - 1, day, Math.floor(n / 100), n % 100, 0);
  let guess = new Date(wallUtc);
  let offset = timeZoneOffsetMs(guess, timeZone);
  guess = new Date(wallUtc - offset);
  const secondOffset = timeZoneOffsetMs(guess, timeZone);
  if (secondOffset !== offset) guess = new Date(wallUtc - secondOffset);
  return guess;
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
  const trips = (tripsByShift.get(shiftId) || []).filter(meaningfulTrip)
    .sort((a, b) => Number(a.trip_number || 0) - Number(b.trip_number || 0));
  if (!trips.length) return null;
  const open = trips.filter((trip) => !trip.complete && !trip.minimized);
  return open.length ? open[open.length - 1] : trips[trips.length - 1];
}
function profileName(profiles, driverId, fallback) {
  const profile = driverId ? profiles.get(String(driverId)) : null;
  return profile?.['Driver Name'] || fallback || 'Unassigned';
}

function standardMeta(location) { return STANDARD[location] || null; }
function mondelezMeta(location) {
  const base = MONDELEZ[location];
  if (!base) return null;
  return {
    key: `mondelez:${location}`,
    title: base.title,
    source: 'Mondelez',
    href: `mondelez.html?loc=${encodeURIComponent(location)}`,
    timeZone: base.timeZone,
  };
}

function standardItem(shift, trip, profiles, kind, operationalDate) {
  const meta = standardMeta(shift.location);
  if (!meta) return null;
  const driverId = trip?.driver_id || shift.driver_id;
  return {
    kind,
    operationalDate,
    meta,
    id: `standard:${shift.id}`,
    driver: profileName(profiles, driverId, shift.driver_name_text),
    load: shift.pro_number || shift.aljex_load_number || 'Load',
    route: trip?.trip_id || trip?.route_id || '',
    start: shift.shift_start,
    shiftDate: shift.shift_date,
    timeZone: meta.timeZone,
    active: !inactiveStandard(shift),
  };
}
function houstonItem(row, profiles, kind, operationalDate) {
  return {
    kind,
    operationalDate,
    meta: HOUSTON,
    id: `houston:${row.id}`,
    driver: profileName(profiles, row.driver_id, row.driver_name),
    load: row.aljex_number || 'Houston load',
    route: '',
    start: row.time,
    shiftDate: row.shift_date,
    timeZone: HOUSTON.timeZone,
    active: !inactiveFlat(row),
  };
}
function mondelezItem(row, profiles, kind, operationalDate) {
  const meta = mondelezMeta(row.location);
  if (!meta) return null;
  return {
    kind,
    operationalDate,
    meta,
    id: `mondelez:${row.id}`,
    driver: profileName(profiles, row.driver_id, row.driver_name),
    load: row.aljex_number || row.delivery_group || 'Mondelez load',
    route: row.delivery_group || '',
    start: row.start_time,
    shiftDate: row.shift_date,
    timeZone: meta.timeZone,
    active: !inactiveFlat(row),
  };
}

function buildRollingItems(data, dates) {
  const selected = new Set(dates);
  const items = [];
  for (const operationalDate of dates) {
    const prev = addDateKey(operationalDate, -1);
    const next = addDateKey(operationalDate, 1);
    const includePrev = !selected.has(prev);
    const includeNext = !selected.has(next);

    if (includePrev) {
      for (const shift of data.standardShifts) {
        if (shift.shift_date !== prev || inactiveStandard(shift)) continue;
        const trip = currentTrip(data.tripsByShift, shift.id);
        const start = clockNumber(shift.shift_start);
        const clearlyRunning = !!(trip && !trip.complete && (trip.dispatch_time || start == null || start >= CARRYOVER_EARLIEST));
        if (!clearlyRunning && !(start != null && start >= CARRYOVER_EARLIEST)) continue;
        const item = standardItem(shift, trip, data.profiles, 'carryover', operationalDate);
        if (item) items.push(item);
      }
      for (const row of data.houstonRows) {
        const start = clockNumber(row.time);
        if (row.shift_date !== prev || inactiveFlat(row) || start == null || start < CARRYOVER_EARLIEST) continue;
        items.push(houstonItem(row, data.profiles, 'carryover', operationalDate));
      }
      for (const row of data.mondelezRows) {
        const start = clockNumber(row.start_time);
        if (row.shift_date !== prev || inactiveFlat(row) || start == null || start < CARRYOVER_EARLIEST) continue;
        const item = mondelezItem(row, data.profiles, 'carryover', operationalDate);
        if (item) items.push(item);
      }
    }

    if (includeNext) {
      for (const shift of data.standardShifts) {
        const start = clockNumber(shift.shift_start);
        if (shift.shift_date !== next || inactiveStandard(shift) || start == null || start > EARLY_AM_CUTOFF) continue;
        const item = standardItem(shift, currentTrip(data.tripsByShift, shift.id), data.profiles, 'early', operationalDate);
        if (item) items.push(item);
      }
      for (const row of data.houstonRows) {
        const start = clockNumber(row.time);
        if (row.shift_date !== next || inactiveFlat(row) || start == null || start > EARLY_AM_CUTOFF) continue;
        items.push(houstonItem(row, data.profiles, 'early', operationalDate));
      }
      for (const row of data.mondelezRows) {
        const start = clockNumber(row.start_time);
        if (row.shift_date !== next || inactiveFlat(row) || start == null || start > EARLY_AM_CUTOFF) continue;
        const item = mondelezItem(row, data.profiles, 'early', operationalDate);
        if (item) items.push(item);
      }
    }
  }
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.operationalDate}|${item.id}|${item.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function removeInjected() {
  document.querySelectorAll('.mega-rolling-ribbon').forEach((node) => node.remove());
  document.querySelectorAll('.mega-location[data-mega-rolling-only="true"]').forEach((node) => node.remove());
}
function locationSection(item) {
  return document.querySelector(`#mega-locations [data-mega-location="${CSS.escape(item.meta.key)}"]`);
}
function ensureRollingOnlySection(item) {
  let section = locationSection(item);
  if (section) return section;
  const wrap = document.getElementById('mega-locations');
  if (!wrap) return null;
  section = document.createElement('section');
  section.className = 'mega-location';
  section.dataset.megaLocation = item.meta.key;
  section.dataset.megaRollingOnly = 'true';
  section.innerHTML = `<div class="mega-location-head">
    <div class="mega-location-toggle mega-rolling-static-head">
      <span class="mega-location-title">${esc(item.meta.title)}</span>
      <span class="mega-source-badge">${esc(item.meta.source)}</span>
      <span class="mega-count-badge">Rolling window</span>
    </div>
    <a class="mega-native-link" href="${esc(item.meta.href)}">Open native board ↗</a>
  </div><div class="mega-location-body"></div>`;
  wrap.appendChild(section);
  return section;
}
function renderRibbon(items, operationalDate) {
  const carryover = items.filter((item) => item.kind === 'carryover');
  const early = items.filter((item) => item.kind === 'early');
  const rows = [...carryover, ...early];
  if (!rows.length) return '';
  return `<div class="mega-rolling-ribbon" data-mega-operational-date="${esc(operationalDate)}">
    <div class="mega-rolling-ribbon-head">
      <strong>Rolling window</strong>
      <span>${carryover.length ? `${carryover.length} running from last night` : 'No carryover'}${early.length ? ` · ${early.length} early-AM start${early.length === 1 ? '' : 's'}` : ''}</span>
    </div>
    <div class="mega-rolling-list">${rows.map((item) => `<a class="mega-rolling-item ${item.kind}" href="${esc(item.meta.href)}" title="Open ${esc(item.meta.title)} board">
      <span class="mega-rolling-tag">${item.kind === 'carryover' ? 'RUNNING' : 'EARLY AM'}</span>
      <strong>${esc(item.driver)}</strong>
      <span>${esc(item.load)}</span>
      ${item.route ? `<span class="mega-rolling-route">${esc(item.route)}</span>` : ''}
      <span class="mega-rolling-time">${esc(prettyClock(item.start))}${item.kind === 'early' ? ' tomorrow' : ' start'}</span>
    </a>`).join('')}</div>
  </div>`;
}
function injectRollingRibbons(items, dates) {
  removeInjected();
  if (!items.length) return;
  const byLocationDate = groupBy(items, (item) => `${item.meta.key}|${item.operationalDate}`);
  const touchedSections = new Set();
  for (const [, groupedItems] of byLocationDate) {
    const first = groupedItems[0];
    const section = ensureRollingOnlySection(first);
    const body = section?.querySelector('.mega-location-body');
    if (!body) continue;
    if (!touchedSections.has(section)) {
      body.querySelectorAll('.mega-rolling-ribbon').forEach((node) => node.remove());
      touchedSections.add(section);
    }
    const html = renderRibbon(groupedItems, first.operationalDate);
    if (!html) continue;
    const holder = document.createElement('div');
    holder.innerHTML = html;
    body.insertBefore(holder.firstElementChild, body.firstChild);
  }
}

function isTodaySelected(dates) { return dates.includes(dateKey(new Date())); }
function buildLiveTimeline(data, dates) {
  if (!isTodaySelected(dates)) return { running: [], soon: [] };
  const today = dateKey(new Date());
  const yesterday = addDateKey(today, -1);
  const tomorrow = addDateKey(today, 1);
  const now = new Date();
  const running = [];
  const soon = [];

  const consider = (item) => {
    if (!item) return;
    const startsAt = zonedDateTime(item.shiftDate, item.start, item.timeZone);
    if (!startsAt) return;
    if (item.shiftDate === yesterday && item.active) {
      const n = clockNumber(item.start);
      if (n != null && n >= CARRYOVER_EARLIEST) running.push({ ...item, startsAt });
      return;
    }
    if (item.shiftDate === today) {
      if (item.active && startsAt.getTime() <= now.getTime()) running.push({ ...item, startsAt });
      else if (startsAt.getTime() > now.getTime()) soon.push({ ...item, startsAt });
      return;
    }
    if (item.shiftDate === tomorrow) {
      const n = clockNumber(item.start);
      if (n != null && n <= EARLY_AM_CUTOFF) soon.push({ ...item, startsAt });
    }
  };

  for (const shift of data.standardShifts) {
    if (!STANDARD[shift.location] || inactiveStandard(shift)) continue;
    consider(standardItem(shift, currentTrip(data.tripsByShift, shift.id), data.profiles, 'live', today));
  }
  for (const row of data.houstonRows) {
    if (inactiveFlat(row)) continue;
    consider(houstonItem(row, data.profiles, 'live', today));
  }
  for (const row of data.mondelezRows) {
    if (inactiveFlat(row)) continue;
    consider(mondelezItem(row, data.profiles, 'live', today));
  }

  const dedupe = (list) => {
    const seen = new Set();
    return list.filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
  };
  return {
    running: dedupe(running).sort((a, b) => a.startsAt - b.startsAt),
    soon: dedupe(soon).sort((a, b) => a.startsAt - b.startsAt),
  };
}
function timelineItem(item, kind) {
  return `<a class="mega-live-item ${kind}" href="${esc(item.meta.href)}">
    <span class="mega-live-dot"></span>
    <div><strong>${esc(item.driver)}</strong><span>${esc(item.meta.title)} · ${esc(item.load)}${item.route ? ` · ${esc(item.route)}` : ''}</span></div>
    <time>${esc(prettyClock(item.start))}</time>
  </a>`;
}
function renderLiveTimeline(model, dates) {
  const control = document.getElementById('mega-control-center');
  if (!control) return;
  let panel = document.getElementById('mega-live-timeline');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'mega-live-timeline';
    panel.className = 'mega-live-timeline';
    const head = control.querySelector('.mega-control-head');
    if (head?.nextSibling) control.insertBefore(panel, head.nextSibling);
    else control.appendChild(panel);
  }
  if (!isTodaySelected(dates)) {
    panel.innerHTML = '<div class="mega-live-paused">Live timeline appears when <strong>Today</strong> is selected.</div>';
    return;
  }
  const runningHtml = model.running.length
    ? model.running.map((item) => timelineItem(item, 'running')).join('')
    : '<div class="mega-live-empty">Nobody from the tracked boards is showing as actively running.</div>';
  const soonHtml = model.soon.length
    ? model.soon.map((item) => timelineItem(item, 'soon')).join('')
    : '<div class="mega-live-empty">No additional starts are scheduled through the overnight 04:00 window.</div>';
  panel.innerHTML = `<div class="mega-live-column">
      <div class="mega-live-title"><strong>Running now</strong><span>${model.running.length}</span></div>
      <div class="mega-live-scroll">${runningHtml}</div>
    </div>
    <div class="mega-live-column">
      <div class="mega-live-title"><strong>Running soon</strong><span>${model.soon.length}</span></div>
      <div class="mega-live-scroll">${soonHtml}</div>
    </div>`;
}

async function fetchRollingData(dates) {
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
    const profileResult = await client.from('atlanta_drivers').select('id,"Driver Name"').in('id', [...driverIds]).limit(5000);
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

async function refreshRollingWindow() {
  if (!client) return;
  const dates = selectedDates();
  if (!dates.length) return;
  const serial = ++refreshSerial;
  try {
    const data = await fetchRollingData(dates);
    if (serial !== refreshSerial) return;
    const rollingItems = buildRollingItems(data, dates);
    injectRollingRibbons(rollingItems, dates);
    renderLiveTimeline(buildLiveTimeline(data, dates), dates);
  } catch (error) {
    console.error('Megaboard rolling window failed:', error);
  }
}
function scheduleRefresh(delay = 180) {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshRollingWindow, delay);
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
    chipObserver.observe(chips, { attributes: true, subtree: true, attributeFilter: ['class', 'aria-pressed'] });
  }
}
function startRealtime() {
  if (!client || realtimeChannel) return;
  realtimeChannel = client.channel('megaboard-rolling-window-v1')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'loads_shifts' }, () => scheduleRefresh(250))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'loads_trips' }, () => scheduleRefresh(250))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'loads_houston' }, () => scheduleRefresh(250))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'mondelez_loads' }, () => scheduleRefresh(250))
    .subscribe();
}
async function init() {
  if (!window.supabase) return;
  client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: AUTH_STORAGE_KEY },
  });
  wireObservers();
  await refreshRollingWindow();
  startRealtime();
  setInterval(() => scheduleRefresh(0), 60000);
}
window.addEventListener('beforeunload', () => {
  if (client && realtimeChannel) client.removeChannel(realtimeChannel);
  statusObserver?.disconnect();
  chipObserver?.disconnect();
});
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
