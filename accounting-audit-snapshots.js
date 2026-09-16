import { supabaseClient, loadDetailsState, renderLoadDetailsTabs } from './loadboard.js';

let activeAccountingId = null;
let snapshotNotes = [];
let snapshotHistory = [];
let requestSerial = 0;
let applying = false;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function mergeRows(current, snapshot, sortFn) {
  const byId = new Map();
  asArray(snapshot).forEach((row) => {
    const key = row && row.id != null ? `id:${row.id}` : `json:${JSON.stringify(row)}`;
    byId.set(key, row);
  });
  asArray(current).forEach((row) => {
    const key = row && row.id != null ? `id:${row.id}` : `json:${JSON.stringify(row)}`;
    byId.set(key, row); // live source wins if both exist
  });
  const merged = [...byId.values()];
  if (sortFn) merged.sort(sortFn);
  return merged;
}

function sameIds(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (String(a[i] && a[i].id) !== String(b[i] && b[i].id)) return false;
  }
  return true;
}

function applySnapshotsToOpenLoad() {
  if (applying || !activeAccountingId || !loadDetailsState) return;

  const mergedNotes = mergeRows(
    loadDetailsState.loadNotes || [],
    snapshotNotes,
    (a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')),
  );
  const mergedHistory = mergeRows(
    loadDetailsState.history || [],
    snapshotHistory,
    (a, b) => String(b.changed_at || '').localeCompare(String(a.changed_at || '')),
  );

  const notesChanged = !sameIds(loadDetailsState.loadNotes || [], mergedNotes);
  const historyChanged = !sameIds(loadDetailsState.history || [], mergedHistory);
  if (!notesChanged && !historyChanged) return;

  loadDetailsState.loadNotes = mergedNotes;
  loadDetailsState.history = mergedHistory;

  applying = true;
  try {
    renderLoadDetailsTabs();
  } finally {
    applying = false;
  }
}

async function loadAccountingAuditSnapshot(accountingId) {
  const id = String(accountingId || '').trim();
  if (!id || !supabaseClient) return;

  activeAccountingId = id;
  snapshotNotes = [];
  snapshotHistory = [];
  const serial = ++requestSerial;

  try {
    const { data, error } = await supabaseClient
      .from('loads_accounting')
      .select('notes_snapshot, change_history_snapshot')
      .eq('id', id)
      .limit(1);
    if (error) throw error;
    if (serial !== requestSerial || activeAccountingId !== id) return;

    const row = data && data[0] ? data[0] : {};
    snapshotNotes = asArray(row.notes_snapshot);
    snapshotHistory = asArray(row.change_history_snapshot);

    // The core modal fetches its live source data asynchronously. Apply now,
    // then again after those requests have had time to finish so a late empty
    // response cannot wipe out the Accounting copy.
    setTimeout(applySnapshotsToOpenLoad, 0);
    setTimeout(applySnapshotsToOpenLoad, 250);
    setTimeout(applySnapshotsToOpenLoad, 1000);
  } catch (e) {
    console.error('Failed to load Accounting note/history snapshots:', e);
  }
}

function init() {
  if ((location.pathname.split('/').pop() || '') !== 'accounting.html') return;

  document.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-open-acct-load]');
    if (btn && btn.dataset.openAcctLoad) {
      loadAccountingAuditSnapshot(btn.dataset.openAcctLoad);
      return;
    }

    const tab = event.target.closest('#ld-tabs .ld-tab[data-tab="notes"], #ld-tabs .ld-tab[data-tab="history"]');
    if (tab) setTimeout(applySnapshotsToOpenLoad, 0);
  }, true);

  const modal = document.getElementById('modal-load-details');
  if (modal) {
    const observer = new MutationObserver(() => {
      if (applying) return;
      const activeAuditTab = modal.querySelector('#ld-tabs .ld-tab.is-active[data-tab="notes"], #ld-tabs .ld-tab.is-active[data-tab="history"]');
      if (activeAuditTab) setTimeout(applySnapshotsToOpenLoad, 0);
    });
    observer.observe(modal, { childList: true, subtree: true });
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
