/*
 * Rehydrate a route's database id before Load Details image uploads.
 *
 * Realtime/modal redraws can occasionally leave a local trip.dbId blank even
 * though that trip already exists in loads_trips. The shared image uploader
 * tries to save the trip before uploading; without dbId that save takes the
 * INSERT path and can hit the unique (shift_id, trip_number) constraint.
 *
 * This module does not patch Supabase or replace any save function. It simply
 * looks up the existing trip slot and restores trip.dbId before the image
 * uploader runs.
 */
import { loadDetailsState, state, supabaseClient } from './loadboard.js';

const inflight = new Map();
const replayingInputs = new WeakSet();
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

function activeTripContext() {
  const row = activeRow();
  if (!row || !Array.isArray(row.trips)) return null;

  const domTab = document.querySelector('#ld-tabs .ld-tab.is-active, #ld-tabs .ld-tab.active')?.dataset?.tab || '';
  const tabKey = domTab || loadDetailsState?.activeTab || '';
  if (!String(tabKey).startsWith('trip-')) return null;

  const localId = String(tabKey).slice(5);
  let index = row.trips.findIndex((trip) => String(trip.id) === localId);

  // Fallback for a stale active-tab id: match the values currently visible
  // in the route form back to the local trip object.
  if (index < 0) {
    const routeId = document.getElementById('ld-tr-routeId')?.value?.trim() || '';
    const tripId = document.getElementById('ld-tr-tripId')?.value?.trim() || '';
    index = row.trips.findIndex((trip) =>
      (routeId && String(trip.routeId || '').trim() === routeId) ||
      (tripId && String(trip.tripId || '').trim() === tripId)
    );
  }

  if (index < 0) return null;
  return { row, trip: row.trips[index], tripNumber: index + 1 };
}

async function ensureTripDbId(context = activeTripContext()) {
  if (!context || !supabaseClient) return false;
  const { row, trip, tripNumber } = context;
  if (trip.dbId) return true;
  if (!row.dbId || !tripNumber) return false;

  const key = `${row.dbId}:${tripNumber}`;
  if (inflight.has(key)) return inflight.get(key);

  const task = (async () => {
    try {
      const result = await supabaseClient
        .from('loads_trips')
        .select('id')
        .eq('shift_id', row.dbId)
        .eq('trip_number', tripNumber)
        .limit(1);

      if (result.error) {
        console.warn('[trip-db-id-rehydration] lookup failed:', result.error);
        return false;
      }
      const id = result.data?.[0]?.id;
      if (id) {
        trip.dbId = id;
        return true;
      }
      return false;
    } catch (error) {
      console.warn('[trip-db-id-rehydration] lookup threw:', error);
      return false;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, task);
  return task;
}

function queueRehydrate() {
  if (scanQueued) return;
  scanQueued = true;
  requestAnimationFrame(() => {
    scanQueued = false;
    void ensureTripDbId();
  });
}

function isRouteImageZoneTarget(target) {
  if (!(target instanceof Element)) return false;
  if (!target.closest('#ld-tab-content')) return false;
  return !!target.closest('[data-action="row-image-dropzone"], [data-action="upload-row-image"]');
}

function init() {
  // Preload the db id as soon as a route tab/modal redraw appears.
  queueRehydrate();
  new MutationObserver(queueRehydrate).observe(document.body, { childList: true, subtree: true });

  // Clicking/dragging toward the image box gives the lookup extra time to
  // finish before the user actually chooses a file.
  for (const type of ['pointerdown', 'click', 'dragenter', 'focusin']) {
    document.addEventListener(type, (event) => {
      if (isRouteImageZoneTarget(event.target)) void ensureTripDbId();
    }, true);
  }

  // Guaranteed fallback for file-picker uploads: if the id is still missing
  // when the input changes, hold that one change event, hydrate the id, then
  // replay the change once so the existing uploader runs normally.
  document.addEventListener('change', (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    if (input.dataset.action !== 'upload-row-image' || !input.closest('#ld-tab-content')) return;
    if (replayingInputs.has(input)) {
      replayingInputs.delete(input);
      return;
    }

    const context = activeTripContext();
    if (!context || context.trip.dbId || !context.row.dbId) return;

    event.stopImmediatePropagation();
    void ensureTripDbId(context).finally(() => {
      replayingInputs.add(input);
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }, true);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
else init();
