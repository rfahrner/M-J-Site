/*
 * Time-sheet completion flow shared by the standard load boards.
 *
 * - The Complete Shift prompt no longer asks for a trailer drop location.
 * - It accepts an optional time-sheet image and stores it with the load's
 *   existing trip-sheet attachments.
 * - Entering both time-sheet times in Load Details > Overview and saving
 *   marks the whole load complete (and collapses its trips) in the same save.
 *
 * This lives beside loadboard.js instead of duplicating the modal markup on
 * every board page.
 */

let lb = null;
let modalObserver = null;
let currentCompletionGeneration = 0;

function allRows() {
  if (!lb?.state?.sheets) return [];
  return Object.values(lb.state.sheets).flatMap((sheet) => sheet || []);
}

function findRow(localId) {
  if (!localId) return null;
  return allRows().find((row) => String(row.id) === String(localId)) || null;
}

function snapshotCompletionState() {
  const map = new Map();
  for (const row of allRows()) map.set(String(row.id), !!row.shiftComplete);
  return map;
}

function newlyCompletedRow(before) {
  for (const row of allRows()) {
    if (before.get(String(row.id)) === false && row.shiftComplete) return row;
  }
  return null;
}

function hideLegacyDropLocation() {
  const input = document.getElementById('tsc-drop-location');
  if (!input) return;
  // Keep the legacy input in the DOM because loadboard.js still reads it,
  // but make it an implementation detail instead of asking dispatchers for it.
  input.value = 'Not required';
  const field = input.closest('.field');
  if (field) field.style.display = 'none';
}

function ensureImageField() {
  const modal = document.getElementById('modal-timesheet-complete');
  if (!modal || document.getElementById('tsc-timesheet-image-field')) return;
  const error = document.getElementById('tsc-error');
  if (!error) return;

  const field = document.createElement('div');
  field.className = 'field';
  field.id = 'tsc-timesheet-image-field';
  field.innerHTML = `
    <label for="tsc-timesheet-image">Time Sheet Image <span class="subtext">(optional)</span></label>
    <label class="tsc-image-dropzone" for="tsc-timesheet-image" tabindex="0">
      <span class="tsc-image-prompt">Drop / paste / click to add an image</span>
      <span class="tsc-image-name subtext"></span>
      <input type="file" accept="image/*" id="tsc-timesheet-image" class="tsc-hidden-file-input">
    </label>`;
  error.insertAdjacentElement('beforebegin', field);

  const zone = field.querySelector('.tsc-image-dropzone');
  const input = field.querySelector('#tsc-timesheet-image');
  const name = field.querySelector('.tsc-image-name');
  const setFile = (file) => {
    if (!file) return;
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    name.textContent = file.name;
  };
  input.addEventListener('change', () => {
    name.textContent = input.files?.[0]?.name || '';
  });
  zone.addEventListener('dragover', (event) => {
    event.preventDefault();
    zone.classList.add('is-dragging');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('is-dragging'));
  zone.addEventListener('drop', (event) => {
    event.preventDefault();
    zone.classList.remove('is-dragging');
    setFile(event.dataTransfer?.files?.[0]);
  });
  zone.addEventListener('paste', (event) => {
    const file = [...(event.clipboardData?.files || [])].find((f) => f.type.startsWith('image/'));
    if (file) {
      event.preventDefault();
      setFile(file);
    }
  });
  zone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      input.click();
    }
  });
}

function resetImageField() {
  const input = document.getElementById('tsc-timesheet-image');
  const name = document.querySelector('#tsc-timesheet-image-field .tsc-image-name');
  if (input) input.value = '';
  if (name) name.textContent = '';
}

function syncCompletionModal() {
  const modal = document.getElementById('modal-timesheet-complete');
  if (!modal) return;
  hideLegacyDropLocation();
  ensureImageField();
  if (!modal.classList.contains('hidden')) {
    // openTimesheetModal() clears the old drop field before showing the modal,
    // so restore the hidden sentinel every time a queue item opens.
    hideLegacyDropLocation();
  }
}

function installStyles() {
  if (document.getElementById('timesheet-completion-flow-styles')) return;
  const style = document.createElement('style');
  style.id = 'timesheet-completion-flow-styles';
  style.textContent = `
    .tsc-hidden-file-input { position:absolute !important; width:1px !important; height:1px !important; opacity:0 !important; pointer-events:none !important; }
    .tsc-image-dropzone { min-height:68px; border:1.5px dashed var(--slate-300,#cbd5e1); border-radius:8px; display:flex; flex-direction:column; justify-content:center; align-items:center; gap:4px; padding:10px; cursor:pointer; background:var(--slate-50,#f8fafc); text-align:center; }
    .tsc-image-dropzone:hover, .tsc-image-dropzone.is-dragging { border-color:#2563eb; background:#eff6ff; }
    .tsc-image-prompt { font-size:13px; font-weight:650; }
    .tsc-image-name { overflow-wrap:anywhere; }
  `;
  document.head.appendChild(style);
}

function autoCheckReceived() {
  const start = document.getElementById('tsc-start')?.value.trim() || '';
  const end = document.getElementById('tsc-end')?.value.trim() || '';
  const received = document.getElementById('tsc-received');
  if (start && end && received) received.checked = true;
}

async function uploadTimesheetImage(row, file) {
  if (!file || !row?.dbId || !lb?.supabaseClient) return;
  const safeName = String(file.name || 'timesheet-image').replace(/[^a-zA-Z0-9._-]+/g, '_');
  const path = `${row.dbId}/${Date.now()}_timesheet_${safeName}`;
  try {
    const { error: uploadError } = await lb.supabaseClient.storage.from('trip-sheets').upload(path, file);
    if (uploadError) throw uploadError;
    const { error: insertError } = await lb.supabaseClient.from('load_attachments').insert({
      shift_id: row.dbId,
      file_path: path,
      file_name: `Time Sheet - ${file.name || safeName}`,
    });
    if (insertError) throw insertError;
    lb.setDriverSyncStatus?.('Load completed and time sheet image uploaded.', 'success');
  } catch (error) {
    console.error('[timesheet-completion-flow] image upload failed:', error);
    lb.setDriverSyncStatus?.(`The load was completed, but the time sheet image could not be uploaded (${error.message || error}).`, 'error');
  }
}

function watchForCompletion(before, file) {
  if (!file) return;
  const generation = ++currentCompletionGeneration;
  const started = Date.now();
  const poll = () => {
    if (generation !== currentCompletionGeneration) return;
    const row = newlyCompletedRow(before);
    if (row) {
      void uploadTimesheetImage(row, file);
      return;
    }
    if (Date.now() - started < 10000) setTimeout(poll, 75);
  };
  setTimeout(poll, 0);
}

function validateAndPrepareCompleteClick(event) {
  const button = event.target.closest?.('#tsc-confirm');
  if (!button) return;
  autoCheckReceived();
  hideLegacyDropLocation();

  const received = !!document.getElementById('tsc-received')?.checked;
  const start = document.getElementById('tsc-start')?.value.trim() || '';
  const end = document.getElementById('tsc-end')?.value.trim() || '';
  if (!received || !start || !end) {
    event.preventDefault();
    event.stopImmediatePropagation();
    const error = document.getElementById('tsc-error');
    if (error) error.textContent = 'Time Sheet Received, Start, and Finish are required before this load can be marked complete.';
    return;
  }

  const file = document.getElementById('tsc-timesheet-image')?.files?.[0] || null;
  const before = snapshotCompletionState();
  watchForCompletion(before, file);
}

function prepareOverviewCompletion() {
  if (!lb?.loadDetailsState) return;
  const start = document.getElementById('ld-ov-timesheet-start')?.value.trim() || '';
  const end = document.getElementById('ld-ov-timesheet-end')?.value.trim() || '';
  if (!start || !end) return;

  const received = document.getElementById('ld-ov-timesheet-received');
  if (received) received.checked = true;

  const row = findRow(lb.loadDetailsState.rowId);
  if (!row || row.shiftComplete) return;
  row.shiftComplete = true;
  row.shiftCompleteAt = new Date().toISOString();
  for (const trip of row.trips || []) trip.minimized = true;

  // saveLoadDetailsEdit() runs immediately after this capture listener and
  // persists shiftComplete together with the time-sheet values. Persist the
  // collapsed trip state as well so a refresh looks exactly like a normal
  // Complete Shift action.
  if (row.dbId && lb.supabaseClient) {
    setTimeout(async () => {
      try {
        await lb.supabaseClient.from('loads_trips').update({ minimized: true }).eq('shift_id', row.dbId);
      } catch (error) {
        console.warn('[timesheet-completion-flow] could not persist minimized trips:', error);
      }
    }, 250);
  }
}

function isOverviewSaveTarget(target) {
  return !!target.closest?.('[data-ld-save="overview"]');
}

function installOverviewCompletionHooks() {
  // Pointer/keyboard preparation happens before the click event, which means
  // the existing Load Details integrity guard captures the final values too.
  document.addEventListener('pointerdown', (event) => {
    if (isOverviewSaveTarget(event.target)) prepareOverviewCompletion();
  }, true);
  document.addEventListener('keydown', (event) => {
    if ((event.key === 'Enter' || event.key === ' ') && isOverviewSaveTarget(event.target)) prepareOverviewCompletion();
  }, true);
  document.addEventListener('click', (event) => {
    if (isOverviewSaveTarget(event.target)) prepareOverviewCompletion();
  }, true);
}

async function init() {
  // This module is intentionally loaded after the main board module finishes
  // evaluating (see loadboard-toolbar-controls.js), avoiding an ESM cycle.
  lb = await import('./loadboard.js');
  installStyles();
  syncCompletionModal();
  installOverviewCompletionHooks();

  const modal = document.getElementById('modal-timesheet-complete');
  if (modal) {
    modal.addEventListener('input', (event) => {
      if (event.target?.id === 'tsc-start' || event.target?.id === 'tsc-end') autoCheckReceived();
    }, true);
    modal.addEventListener('click', validateAndPrepareCompleteClick, true);
    let wasHidden = modal.classList.contains('hidden');
    modalObserver = new MutationObserver(() => {
      const hidden = modal.classList.contains('hidden');
      if (wasHidden && !hidden) {
        syncCompletionModal();
        resetImageField();
      }
      wasHidden = hidden;
    });
    modalObserver.observe(modal, { attributes: true, attributeFilter: ['class'] });
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => void init(), { once: true });
else void init();
