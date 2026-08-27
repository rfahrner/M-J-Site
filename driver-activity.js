import { supabaseClient, findDriver, state } from './loadboard.js';

const ACTIVITY_VIEW = 'driver_carrier_activity_ratings';
const REFRESH_MS = 5 * 60 * 1000;
const VALID_SCOPES = new Set(['atlanta', 'buildingc', 'delaware', 'houston', 'mondelez']);

let activityLoaded = false;
let activityRows = new Map();
let operatingDaysByScope = new Map();
let activitySortDir = null;
let qualitySortDir = null;
let hydrateQueued = false;
let tableObserver = null;

function normalizeCarrier(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function normalizeDriverName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function normalizeMc(value) {
  return String(value || '').replace(/\D/g, '');
}

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '');
}

function currentListScope() {
  return document.querySelector('#driverlist-location-tabs .location-tab.is-active')?.dataset.location || 'atlanta';
}

function profileRunScopes(driver) {
  const runsOutOf = Array.isArray(driver?.runsOutOf) ? driver.runsOutOf : [];
  return [...new Set(runsOutOf.map((value) => String(value || '').toLowerCase()).filter((value) => VALID_SCOPES.has(value)))];
}

function isAtlantaCarrierSource(driver) {
  if (!driver) return false;
  if (String(driver.location || '').toLowerCase() === 'atlanta') return true;
  const scopes = profileRunScopes(driver);
  return scopes.includes('atlanta') || scopes.includes('buildingc');
}

function isCarrierSourceForScope(driver, scope) {
  if (!driver) return false;
  if (scope === 'atlanta' || scope === 'buildingc') return isAtlantaCarrierSource(driver);
  if (scope === 'mondelez') return profileRunScopes(driver).includes('mondelez');
  if (String(driver.location || '').toLowerCase() === scope) return true;
  return profileRunScopes(driver).includes(scope);
}

function chooseCarrier(candidates, scope) {
  const byKey = new Map();
  candidates.forEach((candidate) => {
    const carrier = String(candidate?.carrier || '').trim();
    if (!carrier) return;
    const key = normalizeCarrier(carrier);
    if (!byKey.has(key)) byKey.set(key, carrier);
  });

  const choices = [...byKey.entries()];
  if (!choices.length) return '';
  if (choices.length === 1) return choices[0][1];

  // Duplicate carrier spellings occasionally exist. Prefer a carrier name
  // that is actually represented in this scope's activity history; if more
  // than one is represented, only pick the one with strictly more active
  // days. Otherwise leave it unresolved rather than guessing.
  const withActivity = choices
    .map(([key, display]) => ({ key, display, record: activityRows.get(`${scope}|${key}`) }))
    .filter((item) => item.record);
  if (withActivity.length === 1) return withActivity[0].display;
  if (withActivity.length > 1) {
    withActivity.sort((a, b) => Number(b.record.active_days || 0) - Number(a.record.active_days || 0));
    const first = Number(withActivity[0].record.active_days || 0);
    const second = Number(withActivity[1].record.active_days || 0);
    if (first > second) return withActivity[0].display;
  }

  return '';
}

function activityScopeForDriver(driver, selectedScope) {
  // Preferred Drivers is an Atlanta dispatch list, so always measure it
  // against Atlanta's qualifying operating-day window and grade scale.
  if (selectedScope === 'preferred') return 'atlanta';

  // Normal location tabs rate the driver only against that location's own
  // operating days. The Atlanta tab is visually shared with Building C, so
  // a Building-C-only profile still uses Building C math.
  if (selectedScope === 'atlanta') {
    const runScopes = profileRunScopes(driver);
    if (runScopes.includes('buildingc') && !runScopes.includes('atlanta')) return 'buildingc';
    return 'atlanta';
  }
  if (VALID_SCOPES.has(selectedScope)) return selectedScope;

  return null;
}

function resolveCarrierForActivity(driver, selectedScope) {
  const direct = String(driver?.carrier || '').trim();
  if (direct) return { carrier: direct, inherited: false };
  if (!driver) return { carrier: '', inherited: false };

  const scope = activityScopeForDriver(driver, selectedScope);
  if (!scope) return { carrier: '', inherited: false };

  const driverName = normalizeDriverName(driver.name);
  const mc = normalizeMc(driver.mc);
  const sources = (state?.drivers || []).filter((candidate) =>
    String(candidate.id) !== String(driver.id)
    && isCarrierSourceForScope(candidate, scope)
    && String(candidate.carrier || '').trim()
  );

  const stages = [
    // Strongest identity: same person and same MC.
    sources.filter((candidate) => driverName && mc
      && normalizeDriverName(candidate.name) === driverName
      && normalizeMc(candidate.mc) === mc),
    // MC is a carrier identifier, so this is especially useful after the
    // history-based MC backfill for profiles whose Carrier box was blank.
    sources.filter((candidate) => mc && normalizeMc(candidate.mc) === mc),
    // Exact driver-name fallback for older imported duplicates with no MC.
    sources.filter((candidate) => driverName && normalizeDriverName(candidate.name) === driverName),
  ];

  for (const candidates of stages) {
    const carrier = chooseCarrier(candidates, scope);
    if (carrier) return { carrier, inherited: true };
  }

  return { carrier: '', inherited: false };
}

// ---------------------------------------------------------------------------
// Manual driver-quality Rating
// ---------------------------------------------------------------------------
// Atlanta / Building C no longer owns an independent manual rating. Preferred
// Drivers is the source of truth: if an Atlanta driver is not represented in
// Preferred (or the Preferred copy has no rating), the Atlanta list shows no
// manual rating. Activity Rating remains completely separate and automatic.

function preferredDrivers() {
  return (state?.drivers || []).filter((driver) => String(driver.location || '').toLowerCase() === 'preferred');
}

function choosePreferredRating(candidates) {
  const values = new Map();
  candidates.forEach((candidate) => {
    const rating = String(candidate?.rating || '').trim();
    if (!rating) return;
    const key = rating.toUpperCase();
    if (!values.has(key)) values.set(key, rating);
  });
  if (values.size !== 1) return null;
  return [...values.values()][0];
}

function resolvePreferredRating(driver) {
  if (!driver) return null;
  const name = normalizeDriverName(driver.name);
  const mc = normalizeMc(driver.mc);
  const phone = normalizePhone(driver.phone);
  const preferred = preferredDrivers();

  const stages = [
    // Same person + MC is the strongest cross-list identity.
    preferred.filter((candidate) => name && mc
      && normalizeDriverName(candidate.name) === name
      && normalizeMc(candidate.mc) === mc),
    // Name + phone survives old rows where one copy was missing an MC.
    preferred.filter((candidate) => name && phone
      && normalizeDriverName(candidate.name) === name
      && normalizePhone(candidate.phone) === phone),
    // Exact normalized name is the practical fallback for the imported lists.
    // choosePreferredRating refuses to choose if duplicate Preferred rows
    // disagree about the rating.
    preferred.filter((candidate) => name && normalizeDriverName(candidate.name) === name),
    // Phone-only is allowed only when all matching Preferred rows agree.
    preferred.filter((candidate) => phone && normalizePhone(candidate.phone) === phone),
  ];

  for (const candidates of stages) {
    const rating = choosePreferredRating(candidates);
    if (rating) return rating;
  }
  return null;
}

function qualityRatingForDriver(driver, selectedScope) {
  if (!driver) return null;
  if (selectedScope === 'atlanta') return resolvePreferredRating(driver);
  return String(driver.rating || '').trim() || null;
}

function qualityRatingInfo(driver, selectedScope) {
  const rating = qualityRatingForDriver(driver, selectedScope);
  if (selectedScope !== 'atlanta') {
    return {
      rating,
      title: rating ? `Driver rating: ${rating}` : 'No manual driver rating is on file.',
    };
  }
  return {
    rating,
    title: rating
      ? `Preferred Driver rating: ${rating}`
      : 'No Preferred Driver rating — this driver is not rated for the Atlanta / Building C call list.',
  };
}

function ensureQualityRatingCell(row, driver, selectedScope) {
  const cell = row.cells[7];
  if (!cell) return;
  const info = qualityRatingInfo(driver, selectedScope);
  cell.classList.add('preferred-quality-rating-cell');
  cell.dataset.qualityRating = info.rating || '';
  cell.title = info.title;
  cell.textContent = info.rating || '—';
}

function qualityRank(value) {
  const raw = String(value || '').trim().toUpperCase();
  if (!raw) return null;
  if (raw.startsWith('DNU')) return 90;
  if (raw.startsWith('A')) return 10;
  if (raw.startsWith('B')) return 20;
  if (raw.startsWith('C')) return 30;
  if (raw.startsWith('D')) return 40;
  if (raw.startsWith('E')) return 50;
  if (raw.startsWith('F')) return 60;
  if (raw.startsWith('R')) return 70;
  return 80;
}

function sortRowsByQuality() {
  if (!qualitySortDir || currentListScope() !== 'atlanta') return;
  const body = document.getElementById('driverlist-table-body');
  if (!body) return;
  const rows = [...body.querySelectorAll('tr[id^="dl-"]')];
  rows.sort((a, b) => {
    const av = a.querySelector('.preferred-quality-rating-cell')?.dataset.qualityRating || '';
    const bv = b.querySelector('.preferred-quality-rating-cell')?.dataset.qualityRating || '';
    const ar = qualityRank(av);
    const br = qualityRank(bv);
    if (ar == null && br == null) return rowName(a).localeCompare(rowName(b));
    if (ar == null) return 1;
    if (br == null) return -1;
    if (ar !== br) return qualitySortDir === 'asc' ? ar - br : br - ar;
    const textCmp = String(av).localeCompare(String(bv), undefined, { sensitivity: 'base', numeric: true });
    if (textCmp) return qualitySortDir === 'asc' ? textCmp : -textCmp;
    return rowName(a).localeCompare(rowName(b));
  });

  if (tableObserver) tableObserver.disconnect();
  const fragment = document.createDocumentFragment();
  rows.forEach((row) => fragment.appendChild(row));
  body.appendChild(fragment);
  observeTable();
}

function updateQualityArrow() {
  const header = document.querySelector('th[data-sort="rating"]');
  if (!header) return;
  const arrow = header.querySelector('.sort-arrow');
  if (!arrow) return;
  arrow.textContent = qualitySortDir && currentListScope() === 'atlanta'
    ? (qualitySortDir === 'asc' ? ' ▲' : ' ▼')
    : '';
}

// The legacy Text Group implementation reads driver.rating directly. During
// the two click events where it builds the Rating options / recipient list,
// temporarily present Atlanta drivers with their Preferred-derived rating.
// The stored driver objects are restored immediately after the event bubbles,
// so nothing is written back to the Atlanta Driver Rating column.
function exposePreferredRatingsForCurrentEvent() {
  if (currentListScope() !== 'atlanta') return;
  const snapshots = [];
  (state?.drivers || []).forEach((driver) => {
    if (String(driver.location || '').toLowerCase() !== 'atlanta') return;
    snapshots.push([driver, driver.rating]);
    driver.rating = resolvePreferredRating(driver);
  });
  setTimeout(() => snapshots.forEach(([driver, rating]) => { driver.rating = rating; }), 0);
}

function configureRatingField(driver, addContext) {
  const field = document.getElementById('ad-rating');
  if (!field) return;
  const label = field.closest('.field')?.querySelector('label');
  if (label && !label.dataset.originalText) label.dataset.originalText = label.textContent;

  const isAtlantaExisting = driver && String(driver.location || '').toLowerCase() === 'atlanta';
  const isAtlantaAdd = !driver && ['atlanta', 'buildingc'].includes(String(addContext || '').toLowerCase());
  if (isAtlantaExisting || isAtlantaAdd) {
    field.disabled = true;
    field.value = isAtlantaExisting ? (resolvePreferredRating(driver) || '') : '';
    field.title = 'Atlanta / Building C ratings are managed from Preferred Drivers.';
    if (label) label.textContent = 'Driver rating (managed on Preferred Drivers)';
  } else {
    field.disabled = false;
    field.title = '';
    if (label && label.dataset.originalText) label.textContent = label.dataset.originalText;
  }
}

function wirePreferredQualityBehavior() {
  const thead = document.querySelector('.driverlist thead');
  if (thead) {
    thead.addEventListener('click', (event) => {
      const ratingHeader = event.target.closest('th[data-sort="rating"]');
      if (ratingHeader && currentListScope() === 'atlanta') {
        // Take over Atlanta quality sorting because loadboard's native sorter
        // only knows the dormant Atlanta-side stored rating.
        event.preventDefault();
        event.stopImmediatePropagation();
        activitySortDir = null;
        qualitySortDir = qualitySortDir === 'asc' ? 'desc' : 'asc';
        updateActivityArrow();
        updateQualityArrow();
        sortRowsByQuality();
        return;
      }

      if (event.target.closest('th[data-sort]') || event.target.closest('#activity-rating-sort')) {
        qualitySortDir = null;
        updateQualityArrow();
      }
    }, true);
  }

  document.addEventListener('click', (event) => {
    if (event.target.closest('#btn-text-group') || event.target.closest('#tg-start')) {
      exposePreferredRatingsForCurrentEvent();
    }

    const editButton = event.target.closest('[data-action="edit-driver"]');
    if (editButton) {
      const driver = findDriver(editButton.dataset.driverId);
      setTimeout(() => configureRatingField(driver, null), 0);
    }

    if (event.target.closest('#btn-add-driver')) {
      const context = state.activeLocation || state.driverListTab || 'atlanta';
      setTimeout(() => configureRatingField(null, context), 0);
    }

    // Preserve the dormant Atlanta-side value when an Atlanta profile is
    // saved. The disabled field shows the Preferred rating for reference,
    // but the Preferred copy remains the only authoritative source.
    if (event.target.closest('#ad-submit') && state.editingDriverId) {
      const driver = findDriver(state.editingDriverId);
      if (driver && String(driver.location || '').toLowerCase() === 'atlanta') {
        const field = document.getElementById('ad-rating');
        if (field) field.value = driver.rating || '';
      }
    }
  }, true);
}

// ---------------------------------------------------------------------------
// Activity rating
// ---------------------------------------------------------------------------

function activityForDriver(driver, selectedScope) {
  if (!activityLoaded) {
    return { grade: '…', activeDays: null, operatingDays: null, percent: null, title: 'Loading carrier activity…' };
  }

  const scope = activityScopeForDriver(driver, selectedScope);
  if (!scope) {
    return {
      grade: '—',
      activeDays: null,
      operatingDays: null,
      percent: null,
      title: 'No operating location is available for this activity rating.',
    };
  }

  const resolved = resolveCarrierForActivity(driver, selectedScope);
  const carrier = resolved.carrier;
  if (!carrier) {
    return {
      grade: '—',
      activeDays: null,
      operatingDays: null,
      percent: null,
      title: 'No carrier could be resolved from this driver profile, MC, or matching profile.',
    };
  }

  const carrierKey = normalizeCarrier(carrier);
  const record = activityRows.get(`${scope}|${carrierKey}`);
  const operatingDays = Number(record?.operating_days ?? operatingDaysByScope.get(scope) ?? 0);
  const inheritedNote = resolved.inherited ? ' · carrier inherited from matching profile / MC' : '';

  if (!operatingDays) {
    return {
      grade: '0',
      activeDays: 0,
      operatingDays: 0,
      percent: 0,
      title: `0/0 operating days — no activity history is available yet for ${carrier}${inheritedNote}.`,
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
    title: `${activeDays}/${operatingDays} operating days (${percent.toFixed(1)}%) — ${carrier}${inheritedNote}`,
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

  body.querySelectorAll('tr[id^="dl-"]').forEach((row) => {
    const driverId = row.id.slice(3);
    const driver = findDriver(driverId);
    if (!driver) return;
    ensureQualityRatingCell(row, driver, selectedScope);
    ensureActivityCell(row, activityForDriver(driver, selectedScope));
  });

  const emptyCell = body.querySelector('tr:not([id^="dl-"]) > td[colspan]');
  if (emptyCell) emptyCell.colSpan = 15;

  updateActivityArrow();
  updateQualityArrow();
  if (activitySortDir) sortRowsByActivity();
  else sortRowsByQuality();
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
    qualitySortDir = null;
    activitySortDir = activitySortDir === 'desc' ? 'asc' : 'desc';
    updateQualityArrow();
    updateActivityArrow();
    sortRowsByActivity();
  });

  // If the user switches back to one of the existing sort columns, let the
  // loadboard's normal sorter take over and clear this module's activity state.
  thead.addEventListener('click', (event) => {
    const otherSort = event.target.closest('th[data-sort]');
    if (!otherSort) return;
    if (otherSort.dataset.sort !== 'rating' || currentListScope() !== 'atlanta') {
      activitySortDir = null;
      updateActivityArrow();
    }
  }, true);
}

function initCarrierActivityRatings() {
  if (!document.getElementById('driverlist-table-body')) return;
  observeTable();
  wireSorting();
  wirePreferredQualityBehavior();
  scheduleHydrate();
  refreshActivityRatings();
  setInterval(refreshActivityRatings, REFRESH_MS);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initCarrierActivityRatings, { once: true });
} else {
  initCarrierActivityRatings();
}
