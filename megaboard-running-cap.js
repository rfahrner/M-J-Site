// Guard the Megaboard live view against stale, unclosed prior-day loads.
// A driver/route is only treated as current overnight carryover for 12 hours
// from its scheduled start. The native load remains untouched; this only
// controls what Megaboard presents as current operational work.

const MAX_RUNNING_HOURS = 12;

const LOCATION_TIMEZONES = {
  'kroger:atlanta': 'America/New_York',
  'kroger:delaware': 'America/New_York',
  'kroger:buildingc': 'America/New_York',
  'kroger:houston': 'America/Chicago',
  'mondelez:westchester': 'America/New_York',
  'mondelez:morris': 'America/Chicago',
  'mondelez:addison': 'America/Chicago',
  'mondelez:indianapolis': 'America/Indiana/Indianapolis',
  'mondelez:louisville': 'America/Kentucky/Louisville',
  'mondelez:spokane': 'America/Los_Angeles',
  'mondelez:lasvegas': 'America/Los_Angeles',
  'mondelez:boise': 'America/Boise',
  'mondelez:kent': 'America/Los_Angeles',
  'mondelez:saltlakecity': 'America/Denver',
  'mondelez:newberlin': 'America/Chicago',
};

let observer = null;
let scheduled = false;
let minuteTimer = null;

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

function addDateKey(key, delta) {
  const [y, m, d] = String(key || '').split('-').map(Number);
  if (![y, m, d].every(Number.isFinite)) return '';
  const date = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

function headerIndex(table, labels) {
  const wanted = Array.isArray(labels) ? labels : [labels];
  const headers = [...table.querySelectorAll('thead th')];
  return headers.findIndex((th) => wanted.some((label) => norm(th.textContent).toLowerCase() === label.toLowerCase()));
}

function elapsedHours(start) {
  return (Date.now() - start.getTime()) / 3600000;
}

function isWithinRunningWindow(dateKey, timeValue, timeZone) {
  const start = zonedDateTime(dateKey, timeValue, timeZone);
  if (!start) return false;
  const hours = elapsedHours(start);
  return hours >= -0.25 && hours <= MAX_RUNNING_HOURS;
}

function cleanOperationalTables() {
  document.querySelectorAll('#mega-locations .mega-operational-extra').forEach((block) => {
    const operationalDate = block.dataset.megaOperationalDate || '';
    const priorDate = addDateKey(operationalDate, -1);
    const section = block.closest('.mega-location');
    const locationKey = String(section?.dataset?.megaLocation || '');
    const timeZone = LOCATION_TIMEZONES[locationKey];
    if (!priorDate || !timeZone) return;

    block.querySelectorAll('table tbody tr').forEach((row) => {
      const table = row.closest('table');
      if (!table) return;
      const windowIndex = headerIndex(table, 'Window');
      const windowLabel = windowIndex >= 0 ? norm(row.children[windowIndex]?.textContent).toUpperCase() : '';
      if (windowLabel !== 'OVERNIGHT') return;

      const startIndex = headerIndex(table, ['Shift Start', 'Time', 'Start']);
      if (startIndex < 0) return;
      const startValue = norm(row.children[startIndex]?.textContent);
      if (!isWithinRunningWindow(priorDate, startValue, timeZone)) row.remove();
    });

    if (!block.querySelector('tbody tr')) block.remove();
  });

  document.querySelectorAll('#mega-locations .mega-location[data-mega-rolling-only="true"]').forEach((section) => {
    if (!section.querySelector('.mega-operational-extra')) section.remove();
  });
}

function hrefTimeZone(href) {
  const raw = String(href || '').toLowerCase();
  if (raw.includes('houston')) return 'America/Chicago';
  if (raw.includes('dalaware') || raw.includes('buildingc') || raw.endsWith('index.html')) return 'America/New_York';
  if (raw.includes('loc=morris') || raw.includes('loc=addison') || raw.includes('loc=newberlin')) return 'America/Chicago';
  if (raw.includes('loc=indianapolis')) return 'America/Indiana/Indianapolis';
  if (raw.includes('loc=louisville')) return 'America/Kentucky/Louisville';
  if (raw.includes('loc=spokane') || raw.includes('loc=lasvegas') || raw.includes('loc=kent')) return 'America/Los_Angeles';
  if (raw.includes('loc=boise')) return 'America/Boise';
  if (raw.includes('loc=saltlakecity')) return 'America/Denver';
  if (raw.includes('loc=westchester')) return 'America/New_York';
  return null;
}

function localDateKeyInZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const pick = (type) => parts.find((part) => part.type === type)?.value || '';
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

function localClockMinutes(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value || 0) % 24;
  const minute = Number(parts.find((part) => part.type === 'minute')?.value || 0);
  return hour * 60 + minute;
}

function cleanLegacyRunningCards() {
  document.querySelectorAll('.mega-live-item.running, .mega-rolling-item.carryover').forEach((item) => {
    const href = item.getAttribute('href') || '';
    const timeZone = hrefTimeZone(href);
    if (!timeZone) return;
    const text = norm(item.textContent);
    const match = text.match(/(\d{1,2}:\d{2}\s*(?:AM|PM)|\b\d{3,4}\b)/i);
    if (!match) return;
    const parsed = parseClock(match[1]);
    if (!parsed) return;
    const now = new Date();
    let startDateKey = localDateKeyInZone(now, timeZone);
    const startMinutes = parsed.hour * 60 + parsed.minute;
    const nowMinutes = localClockMinutes(now, timeZone);
    if (startMinutes > nowMinutes) startDateKey = addDateKey(startDateKey, -1);
    if (!isWithinRunningWindow(startDateKey, match[1], timeZone)) item.remove();
  });
}

function apply() {
  cleanOperationalTables();
  cleanLegacyRunningCards();
}

function scheduleApply() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    apply();
  });
}

function init() {
  const root = document.getElementById('megaboard-view') || document.body;
  apply();
  observer = new MutationObserver(scheduleApply);
  observer.observe(root, { childList: true, subtree: true });
  minuteTimer = setInterval(apply, 60000);
}

window.addEventListener('beforeunload', () => {
  if (observer) observer.disconnect();
  if (minuteTimer) clearInterval(minuteTimer);
});

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
