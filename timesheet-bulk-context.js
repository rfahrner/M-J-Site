// Makes the existing bulk Complete Selected queue explicit in the time-sheet modal.
// loadboard.js already opens one modal per selected Atlanta shift; this layer shows
// which driver/PRO is being completed and the current position in that queue.

import * as lb from './loadboard.js';

let batchIds = [];
const skippedIds = new Set();
let observer = null;
let scheduled = false;

function activeRows() {
  const location = lb?.state?.activeLocation;
  const date = lb?.state?.activeDate;
  if (!location || !date || !lb?.state?.sheets) return [];
  return lb.state.sheets[`${location}__${date}`] || [];
}

function findRow(id) {
  return activeRows().find((row) => String(row.id) === String(id)) || null;
}

function driverName(row) {
  if (!row) return '';
  const profile = row.driverId ? lb.findDriver?.(row.driverId) : null;
  return String(profile?.name || row.driverNameText || 'Unnamed driver').trim();
}

function armBatch() {
  const rows = activeRows().filter((row) => row.selected && !row.shiftComplete);
  batchIds = rows.map((row) => String(row.id));
  skippedIds.clear();
}

function activeBatchEntry() {
  for (let index = 0; index < batchIds.length; index += 1) {
    const id = batchIds[index];
    const row = findRow(id);
    if (!row || row.shiftComplete || skippedIds.has(id)) continue;
    return { row, index };
  }
  return null;
}

function ensureContextBox() {
  const modal = document.getElementById('modal-timesheet-complete');
  if (!modal) return null;
  let box = document.getElementById('tsc-load-context');
  if (box) return box;

  box = document.createElement('div');
  box.id = 'tsc-load-context';
  box.className = 'tsc-load-context';

  const firstField = document.getElementById('tsc-received')?.closest('.field');
  if (firstField) firstField.insertAdjacentElement('beforebegin', box);
  else modal.querySelector('.modal-body')?.prepend(box);
  return box;
}

function renderContext() {
  const modal = document.getElementById('modal-timesheet-complete');
  const box = ensureContextBox();
  if (!modal || !box) return;
  if (modal.classList.contains('hidden')) return;

  if (!batchIds.length) {
    // The normal bulk button arms this before the modal opens. This fallback
    // covers keyboard activation or a browser timing edge case.
    armBatch();
  }

  const current = activeBatchEntry();
  if (!current) {
    box.classList.add('hidden');
    return;
  }

  const { row, index } = current;
  const name = driverName(row);
  const pro = String(row.proNumber || '').trim();
  const progress = batchIds.length > 1 ? `Load ${index + 1} of ${batchIds.length}` : 'Completing load';

  box.innerHTML = `
    <div class="tsc-load-progress">${progress}</div>
    <div class="tsc-load-identity">
      <strong>${lb.escapeHtml?.(name) || name}</strong>
      <span>${pro ? `PRO# ${lb.escapeHtml?.(pro) || pro}` : 'No PRO# entered'}</span>
    </div>`;
  box.classList.remove('hidden');
}

function scheduleRender(delay = 0) {
  if (scheduled) return;
  scheduled = true;
  setTimeout(() => {
    scheduled = false;
    renderContext();
  }, delay);
}

function markCurrentSkipped() {
  const current = activeBatchEntry();
  if (current) skippedIds.add(String(current.row.id));
  scheduleRender(0);
}

function installStyles() {
  if (document.getElementById('timesheet-bulk-context-styles')) return;
  const style = document.createElement('style');
  style.id = 'timesheet-bulk-context-styles';
  style.textContent = `
    .tsc-load-context {
      margin:0 0 12px;
      padding:10px 12px;
      border:1px solid #cbd5e1;
      border-left:4px solid #2563eb;
      border-radius:6px;
      background:#f8fbff;
    }
    .tsc-load-context.hidden { display:none; }
    .tsc-load-progress {
      margin-bottom:4px;
      color:#52647c;
      font-size:11px;
      font-weight:800;
      letter-spacing:.04em;
      text-transform:uppercase;
    }
    .tsc-load-identity { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
    .tsc-load-identity strong { font-size:14px; color:#172542; }
    .tsc-load-identity span {
      padding:2px 7px;
      border-radius:999px;
      background:#e8eef8;
      color:#33415c;
      font-size:11px;
      font-weight:700;
    }
  `;
  document.head.appendChild(style);
}

function init() {
  installStyles();
  const modal = document.getElementById('modal-timesheet-complete');
  if (!modal) return;
  ensureContextBox();

  // Capture before loadboard.js handles Complete Selected so our queue mirrors
  // exactly the selected rows it is about to process.
  document.addEventListener('click', (event) => {
    if (event.target.closest?.('#btn-complete-selected')) {
      armBatch();
      scheduleRender(0);
      return;
    }

    if (event.target.closest?.('#tsc-cancel, #tsc-close')) {
      markCurrentSkipped();
      return;
    }

    if (event.target.closest?.('#tsc-confirm')) {
      // loadboard.js marks the current row complete and immediately advances
      // to the next queue item. Re-evaluate after that async save begins so the
      // identity box changes to the next driver instead of staying on the prior one.
      scheduleRender(180);
    }
  }, true);

  let wasHidden = modal.classList.contains('hidden');
  observer = new MutationObserver(() => {
    const hidden = modal.classList.contains('hidden');
    if (wasHidden && !hidden) scheduleRender(0);
    if (!hidden) scheduleRender(80);
    wasHidden = hidden;
  });
  observer.observe(modal, { attributes: true, attributeFilter: ['class'] });
}

window.addEventListener('beforeunload', () => observer?.disconnect());

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
else init();
