/*
 * Unified load-board image cells.
 *
 * Atlanta, Delaware and Building C already use loadboard.js's shared image
 * cell (rowImageDropzoneHtml + wireRowImageDropzone). This bridge brings the
 * two flat-table boards onto that same structure instead of letting Mondelez
 * and Houston drift into their own slightly different upload implementations.
 *
 * Result on every load board:
 *   - click / drag-drop / paste uploads
 *   - multiple images per load
 *   - the same thumbnails + per-image delete controls
 *   - the same full-screen viewer / select / rotate / zoom behavior
 *   - the same storage bucket and JSON path format for multiple images
 */

import {
  state,
  supabaseClient,
  BOARD_IMAGE_BUCKET,
  rowImageDropzoneHtml,
  wireRowImageDropzone,
  batchSignImageUrls,
} from './loadboard.js';
import { mondelezState, MONDELEZ_TABLE } from './mondelez.js';
import { houstonState } from './houston.js';

const MONDELEZ_FILE = 'mondelez.html';
const HOUSTON_FILE = 'houston.html';
let normalizeTimer = null;

function currentFile() {
  return location.pathname.split('/').pop() || 'index.html';
}

function parseImagePaths(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  if (!value) return [];
  const raw = String(value).trim();
  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter(Boolean).map(String);
    } catch (_) { /* legacy single path that happens to begin with '[' */ }
  }
  return [String(value)];
}

function serializedImagePath(row) {
  const paths = Array.isArray(row.routeImagePaths)
    ? row.routeImagePaths.filter(Boolean).map(String)
    : parseImagePaths(row.routeImagePath);
  return paths.length > 1 ? JSON.stringify(paths) : (paths[0] || null);
}

/* ---------------- Mondelez ---------------- */

function mondelezRows() {
  return (mondelezState.rowsByDate && mondelezState.rowsByDate[state.activeDate]) || [];
}

function findMondelezRow(rowId) {
  return mondelezRows().find((row) => String(row.id) === String(rowId)) || null;
}

function mondelezInsertPayload(row) {
  return {
    location: row.location,
    shift_date: state.activeDate,
    aljex_number: row.aljexNumber || null,
    delivery_group: row.deliveryGroup || null,
    start_time: row.startTime || null,
    driver_app_id: row.driverAppId || null,
    trailer_number: row.trailerNumber || null,
    return_trailer_number: row.returnTrailerNumber || null,
    stop_count: row.stopCount !== '' && row.stopCount != null ? Number(row.stopCount) : null,
    notes: row.notes || null,
    driver_id: row.driverId ? Number(row.driverId) : null,
    driver_name: row.driverName || null,
    miles: row.miles !== '' && row.miles != null ? Number(row.miles) : null,
    carrier_rpm: row.carrierRpm !== '' && row.carrierRpm != null ? Number(row.carrierRpm) : null,
    carrier_pay_per_stop: row.carrierPayPerStop !== '' && row.carrierPayPerStop != null ? Number(row.carrierPayPerStop) : null,
    carrier_pay: row.carrierPay !== '' && row.carrierPay != null ? Number(row.carrierPay) : null,
    fsc: row.fsc !== '' && row.fsc != null ? Number(row.fsc) : null,
    additional_charges: row.additionalCharges !== '' && row.additionalCharges != null ? Number(row.additionalCharges) : null,
    revenue_total: row.revenueTotal !== '' && row.revenueTotal != null ? Number(row.revenueTotal) : null,
    revenue_manual: !!row.revenueManual,
    route_image_path: serializedImagePath(row),
    tonu: !!row.tonu,
    highlighted: !!row.highlighted,
    shift_complete: !!row.shiftComplete,
  };
}

async function saveMondelezImageState(row) {
  if (!supabaseClient || !row) throw new Error('Database connection is unavailable.');

  // The shared Delaware uploader saves a new row before it uploads so the
  // storage path has a durable database id. Preserve that exact behavior for
  // a brand-new Mondelez row too.
  if (!row.dbId) {
    const { data, error } = await supabaseClient
      .from(MONDELEZ_TABLE)
      .insert(mondelezInsertPayload(row))
      .select('id');
    if (error) throw error;
    if (!data?.[0]?.id) throw new Error('The load saved without returning an id.');
    row.dbId = data[0].id;
    return row.dbId;
  }

  // Once the row exists, image operations only own route_image_path. Do not
  // rewrite every other load field just because somebody added a picture.
  const { error } = await supabaseClient
    .from(MONDELEZ_TABLE)
    .update({ route_image_path: serializedImagePath(row) })
    .eq('id', row.dbId);
  if (error) throw error;
  return row.dbId;
}

function refreshMondelezImageCell(row) {
  const tr = document.getElementById(row.id);
  const cell = tr?.querySelector('.col-mdz-image');
  if (!cell) return;
  cell.innerHTML = rowImageDropzoneHtml(row, row.id);
}

function normalizeMondelezCells() {
  const table = document.getElementById('mondelez-table');
  if (!table) return;

  table.querySelectorAll('tbody tr[id]').forEach((tr) => {
    const row = findMondelezRow(tr.id);
    const cell = tr.querySelector('.col-mdz-image');
    if (!row || !cell) return;

    row.routeImagePaths = Array.isArray(row.routeImagePaths)
      ? row.routeImagePaths.filter(Boolean)
      : parseImagePaths(row.routeImagePath);
    row.routeImageUrls = Array.isArray(row.routeImageUrls) ? row.routeImageUrls : [];
    row.routeImagePath = row.routeImagePaths[0] || '';
    row.routeImageUrl = row.routeImageUrls[0] || row.routeImageUrl || '';

    // Mondelez used to render its own data-action="image-dropzone" markup.
    // Replace it with the exact same shared markup Delaware renders.
    if (!cell.querySelector('[data-action="row-image-dropzone"]')) {
      cell.innerHTML = rowImageDropzoneHtml(row, row.id);
    }
  });

  if (table.dataset.sharedImageCellsWired !== '1') {
    table.dataset.sharedImageCellsWired = '1';
    wireRowImageDropzone(
      table,
      findMondelezRow,
      saveMondelezImageState,
      refreshMondelezImageCell,
      (row) => row.aljexNumber || row.deliveryGroup || '',
    );
  }
}

/* ---------------- Houston ---------------- */

function allHoustonRows() {
  return Object.values(houstonState.sheets || {}).flat();
}

function installHoustonImagePathProxy(row) {
  if (!row || row.__sharedImagePathProxy) return;

  const initialPaths = Array.isArray(row.routeImagePaths)
    ? row.routeImagePaths.filter(Boolean).map(String)
    : parseImagePaths(row.routeImagePath);
  row.routeImagePaths = initialPaths;
  row.routeImageUrls = Array.isArray(row.routeImageUrls) ? row.routeImageUrls : [];
  if (!row.routeImageUrls.length && row.routeImageUrl && initialPaths.length === 1) {
    row.routeImageUrls = [row.routeImageUrl];
  }

  // Houston's save function historically persisted row.routeImagePath as a
  // single string. Keep that API intact, but make the property serialize the
  // shared multi-image array when needed. That lets the existing Houston save
  // path persist exactly the same JSON format Delaware uses, without creating
  // a second uploader or save routine.
  Object.defineProperty(row, 'routeImagePath', {
    configurable: true,
    enumerable: true,
    get() {
      const paths = Array.isArray(this.routeImagePaths) ? this.routeImagePaths.filter(Boolean).map(String) : [];
      return paths.length > 1 ? JSON.stringify(paths) : (paths[0] || '');
    },
    set(value) {
      const parsed = parseImagePaths(value);
      if (!parsed.length) {
        if (!this.routeImagePaths?.length) this.routeImagePaths = [];
        return;
      }
      if (parsed.length > 1) {
        this.routeImagePaths = parsed;
        return;
      }
      // Shared upload/delete code writes routeImagePaths first and then assigns
      // routeImagePath = firstPath for backwards compatibility. Do not let that
      // second assignment collapse a legitimate multi-image array back to one.
      if (Array.isArray(this.routeImagePaths) && this.routeImagePaths.length > 1) {
        this.routeImagePaths[0] = parsed[0];
      } else {
        this.routeImagePaths = parsed;
      }
    },
  });
  Object.defineProperty(row, '__sharedImagePathProxy', {
    configurable: true,
    enumerable: false,
    writable: true,
    value: true,
  });
}

async function ensureHoustonSignedImages(row) {
  if (!row || row.__sharedImageSigning) return;
  installHoustonImagePathProxy(row);
  const paths = row.routeImagePaths || [];
  if (!paths.length) return;

  const urls = Array.isArray(row.routeImageUrls) ? row.routeImageUrls : [];
  if (paths.every((_, index) => urls[index])) return;

  row.__sharedImageSigning = true;
  try {
    row.routeImageUrls = [];
    const targets = paths.map((_, index) => ({ routeImageTarget: row, index }));
    await batchSignImageUrls(BOARD_IMAGE_BUCKET, paths, targets);
    row.routeImageUrl = row.routeImageUrls[0] || '';
    const tr = document.getElementById(row.id);
    const cell = tr?.querySelector('.col-routeImage');
    if (cell) cell.innerHTML = rowImageDropzoneHtml(row, row.id);
  } finally {
    row.__sharedImageSigning = false;
  }
}

function normalizeHoustonCells() {
  allHoustonRows().forEach((row) => {
    installHoustonImagePathProxy(row);
    void ensureHoustonSignedImages(row);
  });
}

/* ---------------- lifecycle ---------------- */

function normalizeCurrentBoard() {
  const file = currentFile();
  if (file === MONDELEZ_FILE) normalizeMondelezCells();
  else if (file === HOUSTON_FILE) normalizeHoustonCells();
}

function scheduleNormalize() {
  clearTimeout(normalizeTimer);
  normalizeTimer = setTimeout(normalizeCurrentBoard, 30);
}

function init() {
  const file = currentFile();
  if (file !== MONDELEZ_FILE && file !== HOUSTON_FILE) return;

  normalizeCurrentBoard();
  const table = document.getElementById(file === MONDELEZ_FILE ? 'mondelez-table' : 'board-table');
  if (table) {
    new MutationObserver(scheduleNormalize).observe(table, { childList: true, subtree: true });
  }
  document.addEventListener('change', scheduleNormalize, true);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
else init();
