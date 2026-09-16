// Megaboard is a current operational view. Keep the date-selector machinery in
// the DOM for the existing loaders, but remove it from the UI and keep the view
// anchored to Today. Also surface Next Call on every standard-board route row,
// including overnight/early-AM rows injected by the rolling-window module.

const SUPABASE_URL = 'https://ygsapysqzwrpcimgvaqx.supabase.co';
const SUPABASE_KEY = 'sb_publishable_8b8bSIiYm5TzLTw0WG1pAw_5ZWW5ZPL';
const AUTH_STORAGE_KEY = 'dl-dispatch-auth';
const STANDARD_LOCATIONS = new Set(['atlanta', 'delaware', 'buildingc']);

let client = null;
let model = { byPro: new Map(), byRoute: new Map(), byTrip: new Map() };
let observer = null;
let realtime = null;
let refreshTimer = null;
let applyScheduled = false;

function norm(value) {
  const raw = String(value == null ? '' : value).trim();
  return raw === '—' ? '' : raw;
}
function pad(value) { return String(value).padStart(2, '0'); }
function dateKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
function addDays(key, delta) {
  const [year, month, day] = key.split('-').map(Number);
  const date = new Date(year, month - 1, day, 12, 0, 0, 0);
  date.setDate(date.getDate() + delta);
  return dateKey(date);
}
function locationFromSection(section) {
  const key = String(section?.dataset?.megaLocation || '');
  return key.startsWith('kroger:') ? key.slice('kroger:'.length) : '';
}
function headerIndex(table, label) {
  return [...table.querySelectorAll('thead th')]
    .findIndex((th) => norm(th.textContent).toLowerCase() === label.toLowerCase());
}
function key(location, value) {
  return `${location}|${String(value || '').trim().toLowerCase()}`;
}
function resolveRowRecord(row, table, location) {
  const routeIndex = headerIndex(table, 'Route ID');
  const tripIndex = headerIndex(table, 'Trip ID');
  const proIndex = headerIndex(table, 'PRO#');
  const routeId = routeIndex >= 0 ? norm(row.children[routeIndex]?.textContent) : '';
  const tripId = tripIndex >= 0 ? norm(row.children[tripIndex]?.textContent) : '';
  const pro = proIndex >= 0 ? norm(row.children[proIndex]?.textContent) : '';
  if (routeId && model.byRoute.has(key(location, routeId))) return model.byRoute.get(key(location, routeId));
  if (tripId && model.byTrip.has(key(location, tripId))) return model.byTrip.get(key(location, tripId));
  if (pro && model.byPro.has(key(location, pro))) return model.byPro.get(key(location, pro));
  return null;
}
function nextCallValue(record) {
  return norm(record?.trip?.next_call_time) || norm(record?.shift?.next_call_time);
}

function hideDateSelector() {
  const filter = document.querySelector('.mega-filter-card');
  if (filter) filter.hidden = true;
  const subtitle = document.querySelector('.mega-toolbar .subtext');
  if (subtitle) subtitle.textContent = 'Current operational routes across every live load board, including overnight carryover and the next morning’s 00:00–04:00 handoff window.';
}

function ensureNextCallColumn(table, location) {
  if (!STANDARD_LOCATIONS.has(location)) return;
  let nextCallIndex = headerIndex(table, 'Next Call');
  if (nextCallIndex < 0) {
    const headerRow = table.querySelector('thead tr');
    if (!headerRow) return;
    const shiftStartIndex = headerIndex(table, 'Shift Start');
    const insertAt = shiftStartIndex >= 0 ? shiftStartIndex + 1 : Math.max(0, headerIndex(table, 'PRO#') + 1);
    const th = document.createElement('th');
    th.textContent = 'Next Call';
    const headerCells = headerRow.children;
    headerRow.insertBefore(th, headerCells[insertAt] || null);
    [...table.querySelectorAll('tbody tr')].forEach((row) => {
      const td = document.createElement('td');
      td.className = 'mega-next-call-cell';
      row.insertBefore(td, row.children[insertAt] || null);
    });
    nextCallIndex = insertAt;
  }

  [...table.querySelectorAll('tbody tr')].forEach((row) => {
    const cell = row.children[nextCallIndex];
    if (!cell) return;
    const record = resolveRowRecord(row, table, location);
    const value = nextCallValue(record);
    cell.textContent = value || '—';
    cell.classList.toggle('mega-next-call-active', !!value);
    if (value) cell.title = `Next call: ${value}`;
    else cell.removeAttribute('title');
  });
}

function apply() {
  hideDateSelector();
  document.querySelectorAll('#mega-locations .mega-location').forEach((section) => {
    const location = locationFromSection(section);
    if (!STANDARD_LOCATIONS.has(location)) return;
    section.querySelectorAll('.mega-table').forEach((table) => ensureNextCallColumn(table, location));
  });
}
function scheduleApply() {
  if (applyScheduled) return;
  applyScheduled = true;
  requestAnimationFrame(() => {
    applyScheduled = false;
    apply();
  });
}

async function refreshModel() {
  if (!client) return;
  const today = dateKey(new Date());
  const dates = [addDays(today, -1), today, addDays(today, 1)];
  const shiftResult = await client.from('loads_shifts').select('*').in('shift_date', dates).limit(5000);
  if (shiftResult.error) throw shiftResult.error;
  const shifts = (shiftResult.data || []).filter((shift) => STANDARD_LOCATIONS.has(shift.location));
  const shiftById = new Map(shifts.map((shift) => [String(shift.id), shift]));
  const shiftIds = shifts.map((shift) => shift.id);
  const tripResult = shiftIds.length
    ? await client.from('loads_trips').select('*').in('shift_id', shiftIds).limit(10000)
    : { data: [], error: null };
  if (tripResult.error) throw tripResult.error;

  const byPro = new Map();
  const byRoute = new Map();
  const byTrip = new Map();
  shifts.forEach((shift) => {
    const pro = norm(shift.pro_number);
    if (pro) byPro.set(key(shift.location, pro), { shift, trip: null });
  });
  (tripResult.data || []).forEach((trip) => {
    const shift = shiftById.get(String(trip.shift_id));
    if (!shift) return;
    const record = { shift, trip };
    const routeId = norm(trip.route_id);
    const tripId = norm(trip.trip_id);
    if (routeId) byRoute.set(key(shift.location, routeId), record);
    if (tripId) byTrip.set(key(shift.location, tripId), record);
  });
  model = { byPro, byRoute, byTrip };
  scheduleApply();
}

function scheduleRefresh(delay = 150) {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshModel().catch((error) => console.error('Megaboard next-call refresh failed:', error));
  }, delay);
}
function installStyles() {
  if (document.getElementById('mega-current-focus-style')) return;
  const style = document.createElement('style');
  style.id = 'mega-current-focus-style';
  style.textContent = `
    .mega-filter-card[hidden] { display:none !important; }
    .mega-next-call-cell { white-space:nowrap; }
    .mega-next-call-active { font-weight:900; color:#9a3412; background:#fff7ed; }
  `;
  document.head.appendChild(style);
}

async function init() {
  hideDateSelector();
  installStyles();
  const locations = document.getElementById('mega-locations');
  if (locations) {
    observer = new MutationObserver(scheduleApply);
    observer.observe(locations, { childList: true, subtree: true });
  }
  if (!window.supabase) return;
  client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: AUTH_STORAGE_KEY },
  });
  const { data } = await client.auth.getSession();
  if (!data?.session) return;
  await refreshModel();
  realtime = client.channel('megaboard-current-focus-v1')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'loads_shifts' }, () => scheduleRefresh(250))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'loads_trips' }, () => scheduleRefresh(250))
    .subscribe();
}

window.addEventListener('beforeunload', () => {
  if (observer) observer.disconnect();
  if (client && realtime) client.removeChannel(realtime);
});

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
