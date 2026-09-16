/*
 * Stable Accounting presentation guard.
 *
 * This module deliberately does NOT rewrite Applied text nodes and does NOT
 * remove the status classes owned by accounting-columns.js. A second observer
 * fighting those values caused the visible millisecond back-and-forth flicker.
 *
 * Instead:
 * - Driver Rate is visually aliased to Carrier rate with CSS only.
 * - Aljex load-number buttons are visually neutral when complete.
 * - Aljex is red only when it was auto-sent to Accounting and its source shift
 *   has not been marked complete.
 * - Route/Trip pills keep their existing green/red closeout behavior.
 */
import { supabaseClient } from './loadboard.js';
import { getAccountingRecordById } from './accounting.js';

const shiftStatusById = new Map();
let fetchInFlight = false;
let scheduled = false;
let refreshTimer = null;

function installStyles() {
  if (document.getElementById('accounting-stable-status-styles')) return;
  const style = document.createElement('style');
  style.id = 'accounting-stable-status-styles';
  style.textContent = `
    #accounting-table .accounting-applied-label.accounting-carrier-alias {
      font-size: 0 !important;
    }
    #accounting-table .accounting-applied-label.accounting-carrier-alias::after {
      content: 'Carrier rate';
      font-size: 12.5px;
    }

    /* The load number itself is not a green success indicator. Keep the main
       status module's classes intact and override only the visual treatment. */
    #accounting-table .acct-load-number.acct-pill-good,
    #accounting-table .acct-load-number.acct-pill-bad:not(.acct-auto-incomplete) {
      background: transparent !important;
      border-color: var(--slate-400, #94a3b8) !important;
      color: inherit !important;
    }
    #accounting-table .acct-load-number.acct-auto-incomplete {
      background: #fee2e2 !important;
      border-color: #dc2626 !important;
      color: #991b1b !important;
    }
  `;
  document.head.appendChild(style);
}

function visibleRows() {
  return [...document.querySelectorAll('#accounting-table-body tr[id^="acct-"]')];
}

function normalizeAppliedLabels() {
  // Never change textContent here. accounting-pricing-v2 owns that text.
  document.querySelectorAll('#accounting-table [data-accounting-applied-label]').forEach((label) => {
    const isDriverRate = /^driver rate$/i.test(label.textContent.trim());
    label.classList.toggle('accounting-carrier-alias', isDriverRate);
    if (isDriverRate) {
      label.setAttribute('aria-label', 'Carrier rate');
      label.title = 'Carrier rate — carrier/driver-specific rate applied on the load board';
    } else if (label.getAttribute('aria-label') === 'Carrier rate') {
      label.removeAttribute('aria-label');
    }
  });
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

    // Mark the Aljex button once; CSS handles neutral-vs-red without deleting
    // the good/bad classes that accounting-columns.js owns.
    button.classList.add('acct-load-number');

    const shiftId = Number(rec.source_shift_id);
    const status = Number.isFinite(shiftId) ? shiftStatusById.get(shiftId) : null;
    const autoSentButIncomplete = !!status?.sent_to_accounting && !status?.shift_complete;
    button.classList.toggle('acct-auto-incomplete', autoSentButIncomplete);

    if (autoSentButIncomplete) {
      button.title = 'Automatically sent to Accounting before this load was marked complete';
    } else if (button.title?.startsWith('Automatically sent to Accounting')) {
      button.title = 'Open load details';
    }
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
  requestAnimationFrame(normalize);
}

function invalidateShiftStatus() {
  shiftStatusById.clear();
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => void refreshShiftStatuses(true), 100);
}

function setupRealtime(attempt = 0) {
  if (!supabaseClient) {
    if (attempt < 50) setTimeout(() => setupRealtime(attempt + 1), 100);
    return;
  }
  supabaseClient.channel('accounting-aljex-neutral-status-v2')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'loads_shifts' }, invalidateShiftStatus)
    .subscribe();
}

function init() {
  const table = document.getElementById('accounting-table');
  if (!table) return;
  installStyles();

  // Structural/text changes only. Do not observe class attributes: the main
  // Accounting status module changes those classes and watching them here was
  // the feedback loop.
  new MutationObserver(scheduleNormalize).observe(table, {
    childList: true,
    subtree: true,
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
