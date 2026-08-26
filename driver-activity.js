import { supabaseClient, driversForLocation } from './loadboard.js';

const ACTIVITY_VIEW = 'driver_carrier_activity_ratings';
const REFRESH_MS = 5 * 60 * 1000;
const VALID_SCOPES = new Set(['atlanta', 'buildingc', 'delaware', 'houston', 'mondelez']);

let activityLoaded = false;
let activityRows = new Map();
let operatingDaysByScope = new Map();
let activitySortDir = null;
let hydrateQueued = false;
let tableObserver = null;

function normalizeCarrier(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function currentListScope() {
  return document.querySelector('#driverlist-location-tabs .location-tab.is-active')?.dataset.location || 'atlanta';
}

function allKnownDrivers() {
  const byId = new Map();
  ['atlanta', 'delaware', 'houston', 'mondelez'].forEach((scope) => {
    driversForLocation(scope).forEach((driver) => byId.set(String(driver.id), driver));
  });
  return [...byId.values()];
}

function driverPoolForScope(scope) {
  return scope === 'preferred' ? allKnownDrivers() : driversForLocation(scope);
}

function profileRunScopes(driver) {
  const runsOutOf = Array.isArray(driver?.runsOutOf) ? driver.runsOutOf : [];
  return [...new Set(runsOutOf.map((value) => String(value || '').toLowerCase()).filter((value) => VALID_SCOPES.has(value)))];
}

function activityScopeForDriver(driver, selectedScope) {
  // Normal location tabs rate the driver only against that location's own
  // operating days. The Atlanta tab is visually shared with Building C, so
  // a future Building-C-only profile should still use Building C math.
  if (selectedScope === 'atlanta') {
    const runScopes = profileRunScopes(driver);
    if (runScopes.includes('buildingc') && !runScopes.includes('atlanta')) return 'buildingc';
    return 'atlanta';
  }
  if (VALID_SCOPES.has(selectedScope)) return selectedScope;

  // Preferred Drivers is not an operating location. Only use a rating when
  // the profile identifies one unambiguous operating location. Do not quietly
  // assume Atlanta for profiles with no run location or several run locations.
  const home = String(driver?.location || '').toLowerCase();
  if (VALID_SCOPES.has(home)) return home;
  const runScopes = profileRunScopes(driver);
  return runScopes.length === 1 ? runScopes[0] : null;
}

function activityForDriver(driver, selectedScope) {
  if (!activityLoaded) {
    return { grade: '…', activeDays: null, operatingDays: null, percent: null, title: 'Loading carrier activity…' };
  }

  const carrier = String(driver?.carrier || '').trim();
  if (!carrier) {
    return {
      grade: '—',
      activeDays: null,
      operatingDays: null,
      percent: null,
      title: 'No carrier is listed for this driver, so a carrier activity rating cannot be calculated.',
    };
  }

  const scope = activityScopeForDriver(driver, selectedScope);
  if (!scope) {
    return {
      grade: '—',
      activeDays: null,
      operatingDays: null,
      percent: null,
      title: 'No single operating location is set for this driver profile, so an activity rating cannot be calculated here.',
    };
  }

  const carrierKey = normalizeCarrier(carrier);
  const record = activityRows.get(`${scope}|${carrierKey}`);
  const operatingDays = Number(record?.operating_days ?? operatingDaysByScope.get(scope) ?? 0);

  if (!operatingDays) {
    return {
      grade: '0',
      activeDays: 0,
      operatingDays: 0,
      percent: 0,
      title: `0/0 operating days — no activity history is available yet for ${carrier}.`,
    };
  }

  const activeDays = Number(record?.active_days || 0);
  const percent = record ? Number(record.activity_percent || 0) : 0;
  const grade = record?.grade || '0';
  return {
    grade,
    activeDays,
    operatingDays,
    percent,
    title: `${activeDays}/${operatingDays} operating days (${percent.toFixed(1)}%) — ${carrier}`,
  };
}

function gradeClass(grade) {
  return /^[A-F0]$/.test(grade) ? ` activity-grade-${grade}` : '';
}

function ensureActivityCell(row, info) {
  let cell = row.querySelector('.carrier-activity-cell');
  if (!cell) {
    cell = document.createElement('td');
    cell.className = 'carrier-activity-cell';
    // Existing layout: Rating is cell 7 and Rate is cell 8. Insert between them.
    row.insertBefore(cell, row.cells[8] || null);
  }

  cell.dataset.activityPercent = Number.isFinite(info.percent) ? String(info.percent) : '';
  cell.innerHTML = `<span class="activity-rating-badge${gradeClass(info.grade)}" title="${escapeAttribute(info.title)}">${escapeHtml(info.grade)}</span>`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/\n/g, ' ');
}

function updateActivityArrow() {
  const header = document.getElementById('activity-rating-sort');
  if (!header) return;
  const arrow = header.querySelector('.sort-arrow');
  if (arrow) arrow.textContent = activitySortDir ? (activitySortDir === 'asc' ? ' ▲' : ' ▼') : '';

  if (activitySortDir) {
    document.querySelectorAll('th[data-sort] .sort-arrow').forEach((el) => { el.textContent = ''; });
  }
}

function sortRowsByActivity() {
  if (!activitySortDir) return;
  const body = document.getElementById('driverlist-table-body');
  if (!body) return;

  const rows = [...body.querySelectorAll('tr[id^="dl-"]')];
  rows.sort((a, b) => {
    const av = Number.parseFloat(a.querySelector('.carrier-activity-cell')?.dataset.activityPercent ?? '');
    const bv = Number.parseFloat(b.querySelector('.carrier-activity-cell')?.dataset.activityPercent ?? '');
    const aMissing = Number.isNaN(av);
    const bMissing = Number.isNaN(bv);
    if (aMissing && bMissing) return rowName(a).localeCompare(rowName(b));
    if (aMissing) return 1;
    if (bMissing) return -1;
    if (av !== bv) return activitySortDir === 'desc' ? bv - av : av - bv;
    return rowName(a).localeCompare(rowName(b));
  });

  if (tableObserver) tableObserver.disconnect();
  const fragment = document.createDocumentFragment();
  rows.forEach((row) => fragment.appendChild(row));
  body.appendChild(fragment);
  observeTable();
}

function rowName(row) {
  return String(row.cells[1]?.textContent || '').trim();
}

function hydrateRows() {
  hydrateQueued = false;
  const body = document.getElementById('driverlist-table-body');
  if (!body) return;

  const selectedScope = currentListScope();
  const drivers = driverPoolForScope(selectedScope);
  const driversById = new Map(drivers.map((driver) => [String(driver.id), driver]));

  body.querySelectorAll('tr[id^="dl-"]').forEach((row) => {
    const driverId = row.id.slice(3);
    const driver = driversById.get(driverId);
    if (!driver) return;
    ensureActivityCell(row, activityForDriver(driver, selectedScope));
  });

  const emptyCell = body.querySelector('tr:not([id^="dl-"]) > td[colspan]');
  if (emptyCell) emptyCell.colSpan = 15;

  updateActivityArrow();
  sortRowsByActivity();
}

function scheduleHydrate() {
  if (hydrateQueued) return;
  hydrateQueued = true;
  requestAnimationFrame(hydrateRows);
}

function observeTable() {
  const body = document.getElementById('driverlist-table-body');
  if (!body) return;
  if (!tableObserver) tableObserver = new MutationObserver(scheduleHydrate);
  tableObserver.observe(body, { childList: true });
}

async function waitForSupabaseClient() {
  for (let i = 0; i < 100; i += 1) {
    if (supabaseClient) return supabaseClient;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Supabase client did not initialize.');
}

async function refreshActivityRatings() {
  try {
    const client = await waitForSupabaseClient();
    const { data, error } = await client
      .from(ACTIVITY_VIEW)
      .select('scope,carrier_key,carrier_display,active_days,operating_days,activity_percent,grade');
    if (error) throw error;

    const nextRows = new Map();
    const nextOperatingDays = new Map();
    (data || []).forEach((row) => {
      nextRows.set(`${row.scope}|${row.carrier_key}`, row);
      const current = nextOperatingDays.get(row.scope) || 0;
      nextOperatingDays.set(row.scope, Math.max(current, Number(row.operating_days || 0)));
    });
    activityRows = nextRows;
    operatingDaysByScope = nextOperatingDays;
    activityLoaded = true;
    scheduleHydrate();
  } catch (error) {
    console.error('Carrier activity ratings failed to load:', error);
    activityLoaded = true;
    scheduleHydrate();
  }
}

function wireSorting() {
  const header = document.getElementById('activity-rating-sort');
  const thead = document.querySelector('.driverlist thead');
  if (!header || !thead) return;

  header.addEventListener('click', () => {
    activitySortDir = activitySortDir === 'desc' ? 'asc' : 'desc';
    updateActivityArrow();
    sortRowsByActivity();
  });

  // If the user switches back to one of the existing sort columns, let the
  // loadboard's normal sorter take over and clear this module's arrow/state.
  thead.addEventListener('click', (event) => {
    const otherSort = event.target.closest('th[data-sort]');
    if (!otherSort) return;
    activitySortDir = null;
    updateActivityArrow();
  }, true);
}

function initCarrierActivityRatings() {
  if (!document.getElementById('driverlist-table-body')) return;
  observeTable();
  wireSorting();
  scheduleHydrate();
  refreshActivityRatings();
  setInterval(refreshActivityRatings, REFRESH_MS);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initCarrierActivityRatings, { once: true });
} else {
  initCarrierActivityRatings();
}
