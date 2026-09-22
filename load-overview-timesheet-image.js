/*
 * Time Sheet Image cell for Load Details > Overview.
 *
 * Uses the same thumbnail/dropzone language as the board image cells, stores
 * images in the existing trip-sheets bucket/load_attachments table, and only
 * redraws this small field so uploading an image cannot wipe unsaved Overview
 * or route form values.
 */
import {
  loadDetailsState,
  state,
  supabaseClient,
  setDriverSyncStatus,
  viewRowImage,
} from './loadboard.js';
import { UPLOAD_ACCEPT, acceptedUploads, isAcceptedUpload, isPdfRef, pdfChipHtml } from './upload-file-types.js';

const FIELD_ID = 'ld-overview-timesheet-image-field';
const ZONE_ID = 'ld-overview-timesheet-image-zone';
let uploadBusy = false;
let scanQueued = false;

function activeRow() {
  const rowId = loadDetailsState?.rowId;
  if (!rowId || !state?.sheets) return null;
  for (const rows of Object.values(state.sheets)) {
    const row = (rows || []).find((item) => String(item.id) === String(rowId));
    if (row) return row;
  }
  return null;
}

function isTimeSheetAttachment(att) {
  const name = String(att?.file_name || '').trim().toLowerCase();
  const path = String(att?.file_path || '').trim().toLowerCase();
  return name.startsWith('time sheet -') || path.includes('_timesheet_');
}

function attachments() {
  return (loadDetailsState?.attachments || []).filter(isTimeSheetAttachment);
}

function safeText(text) {
  return String(text ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function timeSheetFieldset() {
  return [...document.querySelectorAll('#ld-tab-content fieldset')].find(
    (field) => /^Time Sheet$/i.test(field.querySelector('legend')?.textContent?.trim() || '')
  ) || null;
}

function signature() {
  return `${uploadBusy ? 'busy' : 'ready'}|${attachments().map((att) => `${att.id}:${att.publicUrl || ''}`).join('|')}`;
}

function renderField(field) {
  const sig = signature();
  if (field.dataset.signature === sig) return;
  field.dataset.signature = sig;

  const list = attachments();
  const thumbs = list.map((att, index) => `
    <div class="mdz-thumb-wrap ld-overview-timesheet-thumb-wrap">
      ${isPdfRef(att.publicUrl || att.file_name || '')
        ? pdfChipHtml(att.publicUrl || '', { label: att.file_name })
        : `<img
        src="${safeText(att.publicUrl || '')}"
        class="mdz-route-thumb"
        data-ld-timesheet-view="${index}"
        alt="Time sheet image ${index + 1}"
        title="Click to view full size">`}
      <button
        type="button"
        class="mdz-thumb-delete"
        data-ld-timesheet-delete="${safeText(att.id)}"
        title="Delete time sheet image ${index + 1}">&times;</button>
    </div>`).join('');

  field.innerHTML = `
    <legend>Time Sheet Image</legend>
    <div class="mdz-image-dropzone${uploadBusy ? ' is-uploading' : ''}" tabindex="0" id="${ZONE_ID}" title="Click to browse, or drag/paste one or more time sheet images here">
      ${thumbs || `<span class="mdz-upload-hint">${uploadBusy ? 'Uploading…' : 'Drop / paste / click'}</span>`}
      <input type="file" accept="${UPLOAD_ACCEPT}" multiple id="ld-overview-timesheet-image-input" class="mdz-hidden-file-input" ${uploadBusy ? 'disabled' : ''}>
    </div>`;
}

function ensureField() {
  if (!loadDetailsState || loadDetailsState.activeTab !== 'overview') return;
  const anchor = timeSheetFieldset();
  if (!anchor) return;

  let field = document.getElementById(FIELD_ID);
  if (!field) {
    field = document.createElement('fieldset');
    field.id = FIELD_ID;
    field.className = 'field-box';
    field.style.gridColumn = 'span 2';
    anchor.insertAdjacentElement('afterend', field);
  }
  renderField(field);
}

function queueEnsure() {
  if (scanQueued) return;
  scanQueued = true;
  requestAnimationFrame(() => {
    scanQueued = false;
    ensureField();
  });
}

function openViewer(index) {
  const list = attachments();
  const urls = list.map((att) => att.publicUrl).filter(Boolean);
  if (!urls.length) return;
  const safeIndex = Math.max(0, Math.min(Number(index) || 0, urls.length - 1));
  viewRowImage(
    { routeImageUrl: urls[0], routeImageUrls: urls },
    'Time Sheet',
    safeIndex,
    (deleteIndex) => {
      const target = list[Number(deleteIndex) || 0];
      if (target) void deleteAttachment(target.id, false);
    },
  );
}

async function deleteAttachment(id, ask = true) {
  const att = (loadDetailsState?.attachments || []).find((item) => String(item.id) === String(id));
  if (!att || !supabaseClient) return;
  if (ask && !confirm('Delete this time sheet image? This can\'t be undone.')) return;

  try {
    if (att.file_path) {
      const storageResult = await supabaseClient.storage.from('trip-sheets').remove([att.file_path]);
      if (storageResult.error) throw storageResult.error;
    }
    const dbResult = await supabaseClient.from('load_attachments').delete().eq('id', att.id);
    if (dbResult.error) throw dbResult.error;
    loadDetailsState.attachments = (loadDetailsState.attachments || []).filter((item) => String(item.id) !== String(att.id));
    document.getElementById(FIELD_ID)?.removeAttribute('data-signature');
    ensureField();
  } catch (error) {
    console.error('[load-overview-timesheet-image] delete failed:', error);
    setDriverSyncStatus?.(`Couldn't delete that time sheet image (${error.message || error}).`, 'error');
  }
}

async function uploadFiles(files) {
  const row = activeRow();
  const imageFiles = acceptedUploads(files);
  if (!imageFiles.length || uploadBusy) return;
  if (!row?.dbId || !supabaseClient) {
    setDriverSyncStatus?.('Save this load first before adding a time sheet image.', 'error');
    return;
  }

  uploadBusy = true;
  document.getElementById(FIELD_ID)?.removeAttribute('data-signature');
  ensureField();

  try {
    for (let index = 0; index < imageFiles.length; index++) {
      const file = imageFiles[index];
      const safeName = String(file.name || `timesheet-${index + 1}.jpg`).replace(/[^a-zA-Z0-9._-]+/g, '_');
      const path = `${row.dbId}/${Date.now()}_${index}_timesheet_${safeName}`;

      const upload = await supabaseClient.storage.from('trip-sheets').upload(path, file);
      if (upload.error) throw upload.error;

      const inserted = await supabaseClient.from('load_attachments').insert({
        shift_id: row.dbId,
        file_path: path,
        file_name: `Time Sheet - ${file.name || safeName}`,
      }).select().limit(1);
      if (inserted.error) throw inserted.error;

      let publicUrl = '';
      try {
        const signed = await supabaseClient.storage.from('trip-sheets').createSignedUrl(path, 3600);
        publicUrl = signed.data?.signedUrl || '';
      } catch (_) { /* fallback below */ }
      if (!publicUrl) {
        try { publicUrl = supabaseClient.storage.from('trip-sheets').getPublicUrl(path).data.publicUrl || ''; }
        catch (_) { /* leave blank */ }
      }

      if (inserted.data?.[0]) {
        loadDetailsState.attachments.push({ ...inserted.data[0], publicUrl });
      }
    }
    setDriverSyncStatus?.('Time sheet image uploaded.', 'success');
  } catch (error) {
    console.error('[load-overview-timesheet-image] upload failed:', error);
    setDriverSyncStatus?.(`Couldn't upload the time sheet image (${error.message || error}).`, 'error');
  } finally {
    uploadBusy = false;
    document.getElementById(FIELD_ID)?.removeAttribute('data-signature');
    ensureField();
  }
}

function isZoneTarget(target) {
  return target instanceof Element && !!target.closest(`#${ZONE_ID}`);
}

function installStyles() {
  if (document.getElementById('load-overview-timesheet-image-styles')) return;
  const style = document.createElement('style');
  style.id = 'load-overview-timesheet-image-styles';
  style.textContent = `
    #${ZONE_ID} { min-height:42px; width:100%; }
    #${ZONE_ID}.is-dragging { border-color:#2563eb !important; background:#eff6ff !important; }
    #${ZONE_ID}.is-uploading { opacity:.7; pointer-events:none; }
    #${ZONE_ID} .mdz-thumb-wrap { margin:0; }
    #${ZONE_ID} .mdz-route-thumb { cursor:zoom-in !important; }
  `;
  document.head.appendChild(style);
}

function init() {
  installStyles();
  queueEnsure();

  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    const deleteButton = target.closest('[data-ld-timesheet-delete]');
    if (deleteButton) {
      event.preventDefault();
      event.stopPropagation();
      void deleteAttachment(deleteButton.dataset.ldTimesheetDelete);
      return;
    }

    const image = target.closest('[data-ld-timesheet-view]');
    if (image) {
      event.preventDefault();
      event.stopPropagation();
      openViewer(image.dataset.ldTimesheetView);
      return;
    }

    const zone = target.closest(`#${ZONE_ID}`);
    if (zone) {
      if (target.closest('button')) return;
      document.getElementById('ld-overview-timesheet-image-input')?.click();
    }
  }, true);

  document.addEventListener('change', (event) => {
    if (event.target?.id !== 'ld-overview-timesheet-image-input') return;
    void uploadFiles(event.target.files);
  }, true);

  document.addEventListener('dragover', (event) => {
    if (!isZoneTarget(event.target)) return;
    event.preventDefault();
    document.getElementById(ZONE_ID)?.classList.add('is-dragging');
  }, true);

  document.addEventListener('dragleave', (event) => {
    if (!isZoneTarget(event.target)) return;
    document.getElementById(ZONE_ID)?.classList.remove('is-dragging');
  }, true);

  document.addEventListener('drop', (event) => {
    if (!isZoneTarget(event.target)) return;
    event.preventDefault();
    document.getElementById(ZONE_ID)?.classList.remove('is-dragging');
    void uploadFiles(event.dataTransfer?.files);
  }, true);

  document.addEventListener('paste', (event) => {
    if (!isZoneTarget(event.target)) return;
    const files = acceptedUploads(event.clipboardData?.files);
    if (!files.length) return;
    event.preventDefault();
    void uploadFiles(files);
  }, true);

  document.addEventListener('keydown', (event) => {
    if ((event.key !== 'Enter' && event.key !== ' ') || !isZoneTarget(event.target)) return;
    if (event.target.closest('[data-ld-timesheet-view], [data-ld-timesheet-delete]')) return;
    event.preventDefault();
    document.getElementById('ld-overview-timesheet-image-input')?.click();
  }, true);

  new MutationObserver(queueEnsure).observe(document.body, { childList: true, subtree: true });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
else init();
