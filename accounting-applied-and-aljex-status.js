/*
 * Small Accounting presentation guard:
 * - Driver Rate and Carrier rate are the same Accounting concept, so Applied
 *   only shows Base rate / Daily Rate / Carrier rate.
 * - Aljex load-number buttons stay visually neutral when the source load is
 *   complete. They turn red only when the system has already sent the load to
 *   Accounting but the source shift has not been marked complete yet.
 *
 * Route/Trip pills keep their existing green/red closeout-status behavior.
 */
import { supabaseClient } from './loadboard.js';
import { getAccountingRecordById } from './accounting.js';

const shiftStatusById = new Map();
let fetchInFlight = false;
let scheduled = false;
let refreshTimer = null;

function visibleRows() {
  return [...document.querySelectorAll('#accounting-table-body tr[id^="acct-"]')];
}

function normalizeAppliedLabels() {
  document.querySelectorAll('#accounting-table [data-accounting-applied-label]').forEach((label) => {
    if (/^driver rate$/i.test(label.textContent.trim())) label.textContent = 'Carrier rate';
  });

  const heading = document.querySelector('#driverlist-view h1');
  const subtext = heading?.parentElement?.querySelector('.subtext');
  if (subtext && /driver rate/i.test(subtext.textContent)) {
    subtext.textContent = 'Loads arrive automatically from the boards. Applied shows whether the load used the location base, a daily rate, or a carrier rate; Customer Rate and Carrier Rate remain editable in Accounting.';
  }
}

function loadNumberButton(row, accountingId) {
  return row.querySelector(
    `[data-open-acct-load="${CSS.escape(String(accountingId))}"]:not([data-open-acct-route-text]):not([data-open-acct-trip])`
  );
}

function applyLoadNumberStatus() {
  for (const row of visibleRows()) {
    const accountingId = row.id.slice(5);
    const rec = getAccountingRecordById(accountingId);
    if (!rec) continue;
    const button = loadNumberButton(row, rec.id);
    if (!button) continue;

    // Aljex load numbers never use the green success treatment.
    button.classList.remove('acct-pill-good');

    const shiftId = Number(rec.source_shift_id);
    const status = Number.isFinite(shiftId) ? shiftStatusById.get(shiftId) : null;
    if (!status) {
      // Non-standard/older rows do not get a status color from this guard.
      button.classList.remove('acct-pill-bad');
      continue;
    }

    const autoSentButIncomplete = !!status.sent_to_accounting && !status.shift_complete;
    button.classList.toggle('acct-pill-bad', autoSentButIncomplete);
    button.title = autoSentButIncomplete
      ? 'Automatically sent to Accounting before this load was marked complete'
      : 'Open load details';
  }
}

async function refreshShiftStatuses(force = false) {
  if (!supabaseClient || fetchInFlight) return;
  const ids = [...new Set(visibleRows()
    .map((row) => getAccountingRecordById(row.id.slice(5))?.source_shift_id)
    .map(Number)
    .filter(Number.isFinite))];
  const needed = force ? ids : ids.filter((id) => !shiftStatusById.has(id));

  if (!needed.length) {
    applyLoadNumberStatus();
    return;
  }

  fetchInFlight = true;
  try {
    for (let i = 0; i < needed.length; i += 150) {
      const chunk = needed.slice(i, i + 150);
      const { data, error } = await supabaseClient
        .from('loads_shifts')
        .select('id,shift_complete,sent_to_accounting')
        .in('id', chunk);
      if (error) throw error;
      (data || []).forEach((shift) => shiftStatusById.set(Number(shift.id), shift));
    }
  } catch (error) {
    console.error('Could not refresh Accounting Aljex completion status:', error);
  } finally {
    fetchInFlight = false;
  }
  applyLoadNumberStatus();
}

function normalize() {
  scheduled = false;
  normalizeAppliedLabels();
  applyLoadNumberStatus();
  void refreshShiftStatuses();
}

function scheduleNormalize() {
  if (scheduled) return;
  scheduled = true;
  // accounting-columns.js does its presentation work in one rAF. Running on
  // the following frame makes this guard the final say on the Aljex button.
  requestAnimationFrame(() => requestAnimationFrame(normalize));
}

function invalidateShiftStatus() {
  shiftStatusById.clear();
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => void refreshShiftStatuses(true), 100);
  scheduleNormalize();
}

function setupRealtime(attempt = 0) {
  if (!supabaseClient) {
    if (attempt < 50) setTimeout(() => setupRealtime(attempt + 1), 100);
    return;
  }
  supabaseClient.channel('accounting-aljex-neutral-status-v1')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'loads_shifts' }, invalidateShiftStatus)
    .subscribe();
}

function init() {
  const table = document.getElementById('accounting-table');
  if (!table) return;

  new MutationObserver(scheduleNormalize).observe(table, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class'],
  });
  document.getElementById('acct-location-tabs')?.addEventListener('click', scheduleNormalize);
  setupRealtime();
  scheduleNormalize();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
