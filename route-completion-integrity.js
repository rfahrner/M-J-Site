/*
 * Route completion integrity guard.
 *
 * A route is considered explicitly completed when either:
 *   - the Stop In/Out completion modal is confirmed/skipped, or
 *   - Load Details > route is saved with Complete checked.
 *
 * The normal loadboard flow saves the entire trip row. If that full-row save
 * is interrupted or an older realtime echo arrives at the wrong moment, the
 * browser can temporarily show Complete while the database still says false.
 * This guard pins the user's explicit completion intent and verifies the three
 * completion fields directly by the trip's database id, without rewriting any
 * other route data.
 */
import { state, supabaseClient, setDriverSyncStatus } from './loadboard.js';

const TRIPS_TABLE = 'loads_trips';
const PIN_MS = 15000;
const completionPins = new Map(); // dbId -> { trip, completedAt, expiresAt }

function allRows() {
  return Object.values(state.sheets || {}).flatMap((sheet) => sheet || []);
}

function findTripByLocalId(localTripId) {
  if (!localTripId) return null;
  for (const row of allRows()) {
    const trip = (row.trips || []).find((item) => String(item.id) === String(localTripId));
    if (trip) return { row, trip };
  }
  return null;
}

function localTripIdFromStopModal() {
  const modal = document.getElementById('modal-stop-times');
  if (!modal || modal.classList.contains('hidden')) return null;
  return modal.querySelector('[data-row-image-id]')?.dataset?.rowImageId || null;
}

function rememberCompletion(trip) {
  if (!trip) return null;
  const completedAt = trip.completedAt || new Date().toISOString();
  trip.complete = true;
  trip.minimized = true;
  trip.completedAt = completedAt;
  if (trip.dbId != null) {
    completionPins.set(String(trip.dbId), {
      trip,
      completedAt,
      expiresAt: Date.now() + PIN_MS,
    });
  }
  return completedAt;
}

function reassertPinnedLocalState() {
  const now = Date.now();
  for (const [dbId, pin] of completionPins) {
    if (pin.expiresAt <= now) {
      completionPins.delete(dbId);
      continue;
    }
    pin.trip.complete = true;
    pin.trip.minimized = true;
    pin.trip.completedAt = pin.completedAt;
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureDbCompleted(trip, completedAt) {
  if (!trip?.dbId || !supabaseClient) return;
  const dbId = trip.dbId;
  const attempts = [0, 250, 900, 1800];

  for (const delay of attempts) {
    if (delay) await wait(delay);
    reassertPinnedLocalState();

    const { data, error: readError } = await supabaseClient
      .from(TRIPS_TABLE)
      .select('complete,minimized,completed_at')
      .eq('id', dbId)
      .maybeSingle();
    if (readError) {
      console.warn('[route-completion-integrity] verification read failed:', readError);
      continue;
    }
    if (data?.complete === true && data?.minimized === true) {
      completionPins.delete(String(dbId));
      return;
    }

    const { error: updateError } = await supabaseClient
      .from(TRIPS_TABLE)
      .update({ complete: true, minimized: true, completed_at: data?.completed_at || completedAt })
      .eq('id', dbId);
    if (updateError) {
      console.warn('[route-completion-integrity] completion repair failed:', updateError);
      continue;
    }
  }

  const { data: finalState, error: finalError } = await supabaseClient
    .from(TRIPS_TABLE)
    .select('complete,minimized')
    .eq('id', dbId)
    .maybeSingle();

  if (!finalError && finalState?.complete === true && finalState?.minimized === true) {
    completionPins.delete(String(dbId));
    return;
  }

  setDriverSyncStatus?.('The route looks complete here, but its completion could not be verified in the database. Please try completing it again.', 'error');
}

function pinTripCompletion(trip) {
  const completedAt = rememberCompletion(trip);
  if (!completedAt) return;
  void ensureDbCompleted(trip, completedAt);
}

function handleCompletionIntent(event) {
  const stopButton = event.target.closest?.('#st-confirm, #st-skip');
  if (stopButton) {
    const found = findTripByLocalId(localTripIdFromStopModal());
    if (found?.trip) pinTripCompletion(found.trip);
    return;
  }

  const saveButton = event.target.closest?.('[data-ld-save]');
  if (saveButton && saveButton.dataset.ldSave !== 'overview') {
    const checkbox = document.getElementById('ld-tr-complete');
    if (!checkbox?.checked) return;
    const found = findTripByLocalId(saveButton.dataset.ldSave);
    if (found?.trip) pinTripCompletion(found.trip);
  }
}

function handleShiftCompleteIntent(event) {
  if (!event.target.closest?.('#btn-complete-selected')) return;
  // If a realtime echo temporarily reset a trip during the few moments after
  // it was explicitly completed, make the Complete Selected pre-check see the
  // user's latest intent while the database verification finishes.
  reassertPinnedLocalState();
}

function init() {
  document.addEventListener('pointerdown', handleCompletionIntent, true);
  document.addEventListener('click', handleCompletionIntent, true);
  document.addEventListener('click', handleShiftCompleteIntent, true);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
else init();
