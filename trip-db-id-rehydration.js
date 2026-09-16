/*
 * Recover an existing loads_trips row id before the UI attempts to save a
 * route as a new row.
 *
 * The browser normally keeps trip.dbId, but modal/realtime redraws can leave a
 * local trip without it even though (shift_id, trip_number) already exists in
 * Supabase. saveTripNow() then takes its INSERT path and PostgreSQL correctly
 * rejects it with loads_trips_shift_id_trip_number_key.
 *
 * Keep the normal save code untouched. Before route edits/images are allowed
 * through, resolve the existing database row and put its id back on the local
 * trip object. Matching prefers Route ID / Trip ID, then falls back to the
 * canonical trip_number slot.
 */
import { loadDetailsState, state, supabaseClient } from './loadboard.js';

const inflightRows = new Map();
const replayingInputs = new WeakSet();
const replayingButtons = new WeakSet();
let scanQueued = false;

function loadedRows() {
  const out = [];
  const seen = new Set();
  for (const rows of Object.values(state?.sheets || {})) {
    for (const row of rows || []) {
      if (!row?.dbId || seen.has(String(row.dbId))) continue;
      seen.add(String(row.dbId));
      out.push(row);
    }
  }
  return out;
}

function activeRow() {
  const rowId = loadDetailsState?.rowId;
  if (!rowId) return null;
  for (const row of loadedRows()) {
    if (String(row.id) === String(rowId)) return row;
  }
  return null;
}

function contextForLocalTripId(localTripId) {
  if (!localTripId) return null;
  for (const row of loadedRows()) {
    const index = (row.trips || []).findIndex((trip) => String(trip.id) === String(localTripId));
    if (index >= 0) return { row, trip: row.trips[index], tripNumber: index + 1 };
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

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

async function hydrateRow(row) {
  if (!row?.dbId || !supabaseClient || !Array.isArray(row.trips)) return false;
  const missing = row.trips.some((trip) => !trip.dbId);
  if (!missing) return true;

  const key = String(row.dbId);
  if (inflightRows.has(key)) return inflightRows.get(key);

  const task = (async () => {
    try {
      const result = await supabaseClient
        .from('loads_trips')
        .select('id, trip_number, route_id, trip_id')
        .eq('shift_id', row.dbId)
        .order('trip_number', { ascending: true });

      if (result.error) {
        console.warn('[trip-db-id-rehydration] row lookup failed:', result.error);
        return false;
      }

      const dbTrips = result.data || [];
      const claimed = new Set(row.trips.filter((trip) => trip.dbId).map((trip) => String(trip.dbId)));

      row.trips.forEach((trip, index) => {
        if (trip.dbId) return;
        const routeId = normalize(trip.routeId);
        const tripId = normalize(trip.tripId);
        let match = null;

        if (routeId) {
          const hits = dbTrips.filter((db) => !claimed.has(String(db.id)) && normalize(db.route_id) === routeId);
          if (hits.length === 1) match = hits[0];
        }
        if (!match && tripId) {
          const hits = dbTrips.filter((db) => !claimed.has(String(db.id)) && normalize(db.trip_id) === tripId);
          if (hits.length === 1) match = hits[0];
        }
        if (!match) {
          match = dbTrips.find((db) => !claimed.has(String(db.id)) && Number(db.trip_number) === index + 1) || null;
        }

        if (match) {
          trip.dbId = match.id;
          claimed.add(String(match.id));
        }
      });
      return true;
    } catch (error) {
      console.warn('[trip-db-id-rehydration] row lookup threw:', error);
      return false;
    } finally {
      inflightRows.delete(key);
    }
  })();

  inflightRows.set(key, task);
  return task;
}

async function ensureTripDbId(context = activeTripContext()) {
  if (!context?.row || !context?.trip) return false;
  if (context.trip.dbId) return true;
  await hydrateRow(context.row);
  return !!context.trip.dbId;
}

async function hydrateAllLoadedRows() {
  for (const row of loadedRows()) {
    if ((row.trips || []).some((trip) => !trip.dbId)) await hydrateRow(row);
  }
}

function queueRehydrate() {
  if (scanQueued) return;
  scanQueued = true;
  requestAnimationFrame(() => {
    scanQueued = false;
    const active = activeTripContext();
    if (active) void ensureTripDbId(active);
    else void hydrateAllLoadedRows();
  });
}

function isRouteImageZoneTarget(target) {
  if (!(target instanceof Element)) return false;
  if (!target.closest('#ld-tab-content')) return false;
  return !!target.closest('[data-action="row-image-dropzone"], [data-action="upload-row-image"]');
}

function init() {
  // First pass and subsequent modal/board redraws. The all-row fallback also
  // repairs ids before a delayed 700ms board save has a chance to INSERT.
  queueRehydrate();
  new MutationObserver(queueRehydrate).observe(document.body, { childList: true, subtree: true });
  setTimeout(() => void hydrateAllLoadedRows(), 750);
  setTimeout(() => void hydrateAllLoadedRows(), 2500);

  // Any trip cell edit starts recovering that exact trip immediately. This is
  // intentionally capture-phase so it runs before the board schedules its
  // debounced save.
  document.addEventListener('input', (event) => {
    const tripId = event.target?.dataset?.trip;
    if (!tripId) return;
    const context = contextForLocalTripId(tripId);
    if (context && !context.trip.dbId) void ensureTripDbId(context);
  }, true);

  // Immediate-save checkbox paths need the same head start.
  document.addEventListener('pointerdown', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const tripId = target?.dataset?.trip;
    if (tripId) {
      const context = contextForLocalTripId(tripId);
      if (context && !context.trip.dbId) void ensureTripDbId(context);
    }
    if (isRouteImageZoneTarget(target)) void ensureTripDbId();
  }, true);

  for (const type of ['click', 'dragenter', 'focusin']) {
    document.addEventListener(type, (event) => {
      if (isRouteImageZoneTarget(event.target)) void ensureTripDbId();
    }, true);
  }

  // Modal Save is synchronous from the click handler's point of view. If the
  // trip id is missing, hold that click until the lookup completes, then replay
  // the exact same button once. That removes the race entirely instead of just
  // hoping the lookup wins before saveTripNow runs.
  document.addEventListener('click', (event) => {
    const button = event.target instanceof Element ? event.target.closest('[data-ld-save]') : null;
    if (!button || !button.closest('#ld-tab-content')) return;
    if (button.dataset.ldSave === 'overview') return;
    if (replayingButtons.has(button)) {
      replayingButtons.delete(button);
      return;
    }

    const context = activeTripContext();
    if (!context || context.trip.dbId || !context.row.dbId) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    void ensureTripDbId(context).finally(() => {
      replayingButtons.add(button);
      button.click();
    });
  }, true);

  // File-picker uploads have the same requirement. Hold the change event,
  // resolve the existing route id, and then replay the change so the shared
  // uploader sees a normal existing trip instead of taking INSERT.
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
