/*
 * Time-sheet completion flow shared by the standard load boards.
 *
 * - The Complete Shift prompt no longer asks for a trailer drop location.
 * - It accepts an optional time-sheet image and stores it with the load's
 *   existing trip-sheet attachments.
 * - Entering both time-sheet times in Load Details > Overview and saving
 *   marks the whole load complete (and collapses its trips) in the same save.
 *
 * This module itself is loaded dynamically after loadboard.js finishes, so a
 * normal static import back to loadboard.js is safe here and lets all capture
 * listeners be installed before the integrity guard is imported.
 */
import * as lb from './loadboard.js';

let modalObserver = null;
let currentCompletionGeneration = 0;
let timesheetPreviewUrl = '';

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

function clearTimesheetPreviewUrl() {
  if (!timesheetPreviewUrl) return;
  URL.revokeObjectURL(timesheetPreviewUrl);
  timesheetPreviewUrl = '';
}

function renderTimesheetImageCell(file = null) {
  const zone = document.getElementById('tsc-timesheet-image-zone');
  const input = document.getElementById('tsc-timesheet-image');
  if (!zone || !input) return;

  clearTimesheetPreviewUrl();
  const oldPreview = zone.querySelector('.tsc-timesheet-preview');
  const oldHint = zone.querySelector('.mdz-upload-hint');
  if (oldPreview) oldPreview.remove();
  if (oldHint) oldHint.remove();

  if (file) {
    timesheetPreviewUrl = URL.createObjectURL(file);
    const wrap = document.createElement('div');
    wrap.className = 'mdz-thumb-wrap tsc-timesheet-preview';
    wrap.innerHTML = `
      <img src="${timesheetPreviewUrl}" class="mdz-route-thumb" alt="Selected time sheet image" title="Selected time sheet image">
      <button type="button" class="mdz-thumb-delete" data-tsc-delete-image title="Remove selected image">&times;</button>`;
    zone.insertBefore(wrap, input);
  } else {
    const hint = document.createElement('span');
    hint.className = 'mdz-upload-hint';
    hint.textContent = 'Drop / paste / click';
    zone.insertBefore(hint, input);
  }
}

function setTimesheetFile(file) {
  const input = document.getElementById('tsc-timesheet-image');
  if (!input) return;
  if (!file) {
    input.value = '';
    renderTimesheetImageCell();
    return;
  }
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  renderTimesheetImageCell(file);
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
    <label>Time Sheet Image <span class="subtext">(optional)</span></label>
    <div class="mdz-image-dropzone" tabindex="0" id="tsc-timesheet-image-zone" title="Click to browse, or drag/paste an image here">
      <span class="mdz-upload-hint">Drop / paste / click</span>
      <input type="file" accept="image/*" id="tsc-timesheet-image" class="mdz-hidden-file-input">
    </div>`;
  error.insertAdjacentElement('beforebegin', field);

  const zone = field.querySelector('#tsc-timesheet-image-zone');
  const input = field.querySelector('#tsc-timesheet-image');
  input.addEventListener('change', () => renderTimesheetImageCell(input.files?.[0] || null));
  zone.addEventListener('click', (event) => {
    if (event.target.closest('[data-tsc-delete-image]')) {
      event.preventDefault();
      event.stopPropagation();
      setTimesheetFile(null);
      return;
    }
    if (event.target.closest('img')) return;
    input.click();
  });
  zone.addEventListener('dragover', (event) => {
    event.preventDefault();
    zone.classList.add('is-dragging');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('is-dragging'));
  zone.addEventListener('drop', (event) => {
    event.preventDefault();
    zone.classList.remove('is-dragging');
    setTimesheetFile(event.dataTransfer?.files?.[0] || null);
  });
  zone.addEventListener('paste', (event) => {
    const file = [...(event.clipboardData?.files || [])].find((f) => f.type.startsWith('image/'));
    if (file) {
      event.preventDefault();
      setTimesheetFile(file);
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
  if (input) input.value = '';
  renderTimesheetImageCell();
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
    #tsc-timesheet-image-zone { min-height:42px; width:100%; }
    #tsc-timesheet-image-zone.is-dragging { border-color:#2563eb !important; background:#eff6ff !important; }
    #tsc-timesheet-image-zone .mdz-thumb-wrap { margin:0; }
    #tsc-timesheet-image-zone .mdz-route-thumb { cursor:default; }
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

async function finishCompletionArtifacts(row, file) {
  // submitTimesheetModal() still assigns the hidden compatibility value to the
  // old shift-level field. Clear that immediately so "Not required" never
  // becomes real operational data.
  row.trailerDropLocation = '';
  if (row.dbId && lb?.supabaseClient) {
    try {
      const { error } = await lb.supabaseClient.from('loads_shifts').update({ trailer_drop_location: null }).eq('id', row.dbId);
      if (error) throw error;
    } catch (error) {
      console.warn('[timesheet-completion-flow] could not clear legacy trailer drop value:', error);
    }
  }
  if (file) await uploadTimesheetImage(row, file);
}

function watchForCompletion(before, file) {
  const generation = ++currentCompletionGeneration;
  const started = Date.now();
  const poll = () => {
    if (generation !== currentCompletionGeneration) return;
    const row = newlyCompletedRow(before);
    if (row) {
      void finishCompletionArtifacts(row, file);
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

function init() {
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

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
else init();
