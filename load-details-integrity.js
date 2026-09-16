/*
 * Load Details integrity guard.
 *
 * Two jobs live here:
 *  1) Treat stop-time documentation from the database as the source of truth
 *     for completed-route pills and the visible Stop In/Out box. This avoids
 *     the stale client-side hasStopTimes flag leaving a fully documented route
 *     red until a full page refresh.
 *  2) Verify a modal Save after the normal handler runs and idempotently retry
 *     the captured route + stop values. trip_stops has a unique
 *     (trip_id, stop_number) key, so the retry cannot create duplicates. A
 *     transient failure on one stop can no longer leave the modal half-saved.
 */
import { supabaseClient, state, setDriverSyncStatus } from './loadboard.js';

const SHIFTS = 'loads_shifts';
const TRIPS = 'loads_trips';
const STOPS = 'trip_stops';
let pillTimer = null;
let pillRepairRunning = false;

function value(id) {
  const el = document.getElementById(id);
  return el ? String(el.value || '').trim() : '';
}

function checked(id) {
  const el = document.getElementById(id);
  return !!(el && el.checked);
}

function nullableNumber(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function currentProNumber() {
  const title = document.getElementById('ld-title')?.textContent || '';
  const fromTitle = title.replace(/^Load\s*#/i, '').replace(/^\s*\(not assigned\)\s*$/i, '').trim();
  if (fromTitle) return fromTitle;

  // Fallback for an open modal whose title was created before a PRO was typed.
  const activeTrip = document.querySelector('#ld-tabs .ld-tab.is-active[data-tab^="trip-"]');
  const localTripId = activeTrip?.dataset.tab?.slice(5);
  if (localTripId) {
    const routeInput = document.querySelector(`#board-table [data-trip="${CSS.escape(localTripId)}"]`);
    const tr = routeInput?.closest('tr');
    const parentId = tr?.dataset.parentRow || tr?.id;
    const proInput = parentId ? document.querySelector(`#${CSS.escape(parentId)} [data-field="proNumber"]`) : null;
    if (proInput?.value?.trim()) return proInput.value.trim();
  }
  return '';
}

function tripNumberForLocalId(localId) {
  const tripTabs = [...document.querySelectorAll('#ld-tabs .ld-tab[data-tab^="trip-"]')];
  const index = tripTabs.findIndex((tab) => tab.dataset.tab === `trip-${localId}`);
  return index >= 0 ? index + 1 : null;
}

function captureStops(stopCount) {
  const stops = [];
  for (let i = 0; i < stopCount; i++) {
    const timeIn = document.querySelector(`#ld-tab-content [data-stop-field="timeIn"][data-stop-index="${i}"]`);
    const timeOut = document.querySelector(`#ld-tab-content [data-stop-field="timeOut"][data-stop-index="${i}"]`);
    stops.push({
      stop_number: i + 1,
      time_in: timeIn ? String(timeIn.value || '').trim() || null : null,
      time_out: timeOut ? String(timeOut.value || '').trim() || null : null,
    });
  }
  return stops;
}

function captureModalSave(button) {
  const key = button?.dataset?.ldSave;
  if (!key) return null;
  const base = {
    location: state.activeLocation,
    shiftDate: state.activeDate,
    proNumber: currentProNumber(),
    kind: key === 'overview' ? 'overview' : 'trip',
  };

  if (key === 'overview') {
    return {
      ...base,
      timesheet_received: checked('ld-ov-timesheet-received'),
      timesheet_start_time: value('ld-ov-timesheet-start') || null,
      timesheet_end_time: value('ld-ov-timesheet-end') || null,
    };
  }

  const stopCountRaw = value('ld-tr-stopCount');
  const stopCount = Math.max(0, parseInt(stopCountRaw, 10) || 0);
  return {
    ...base,
    localTripId: key,
    tripNumber: tripNumberForLocalId(key),
    route: {
      route_id: value('ld-tr-routeId') || null,
      trip_id: value('ld-tr-tripId') || null,
      trailer_out: value('ld-tr-trailerOut') || null,
      route_miles: nullableNumber(value('ld-tr-routeMiles')),
      stop_count: nullableNumber(stopCountRaw),
      notes: value('ld-tr-notes') || null,
      dispatch_time: value('ld-tr-dispatch-time') || null,
      return_eta_to_dc: value('ld-tr-return-eta') || null,
      ppwk_received: checked('ld-tr-ppwk-received'),
      checked_in: checked('ld-tr-checked-in'),
      return_drop_location: value('ld-tr-drop-location') || null,
      complete: checked('ld-tr-complete'),
      minimized: checked('ld-tr-complete'),
    },
    stops: captureStops(stopCount),
  };
}

async function resolveShiftId(snapshot) {
  if (!supabaseClient || !snapshot?.proNumber || !snapshot.location) return null;
  let query = supabaseClient
    .from(SHIFTS)
    .select('id,shift_date')
    .eq('location', snapshot.location)
    .eq('pro_number', snapshot.proNumber)
    .order('shift_date', { ascending: false })
    .limit(2);
  if (snapshot.shiftDate) query = query.eq('shift_date', snapshot.shiftDate);
  let { data, error } = await query;
  if (error) throw error;

  // A modal opened from the currently-selected board day should resolve here.
  // If the date changed while the modal was open, fall back to the newest exact
  // PRO/location match rather than throwing away the safety retry.
  if (!data?.length && snapshot.shiftDate) {
    const fallback = await supabaseClient
      .from(SHIFTS)
      .select('id,shift_date')
      .eq('location', snapshot.location)
      .eq('pro_number', snapshot.proNumber)
      .order('shift_date', { ascending: false })
      .limit(2);
    if (fallback.error) throw fallback.error;
    data = fallback.data;
  }
  return data?.length ? data[0].id : null;
}

async function verifyOverviewSave(snapshot) {
  const shiftId = await resolveShiftId(snapshot);
  if (!shiftId) return;
  const { error } = await supabaseClient.from(SHIFTS).update({
    timesheet_received: snapshot.timesheet_received,
    timesheet_start_time: snapshot.timesheet_start_time,
    timesheet_end_time: snapshot.timesheet_end_time,
  }).eq('id', shiftId);
  if (error) throw error;
}

async function verifyTripSave(snapshot) {
  if (!snapshot.tripNumber) return;
  const shiftId = await resolveShiftId(snapshot);
  if (!shiftId) return;

  let { data: tripRows, error: tripLookupError } = await supabaseClient
    .from(TRIPS)
    .select('id')
    .eq('shift_id', shiftId)
    .eq('trip_number', snapshot.tripNumber)
    .limit(1);
  if (tripLookupError) throw tripLookupError;

  let tripId = tripRows?.[0]?.id || null;
  if (tripId) {
    const { error } = await supabaseClient.from(TRIPS).update(snapshot.route).eq('id', tripId);
    if (error) throw error;
  } else {
    const { data, error } = await supabaseClient.from(TRIPS).insert({
      ...snapshot.route,
      shift_id: shiftId,
      trip_number: snapshot.tripNumber,
    }).select('id').limit(1);
    if (error) throw error;
    tripId = data?.[0]?.id || null;
  }

  if (tripId && snapshot.stops.length) {
    const payload = snapshot.stops.map((stop) => ({ ...stop, trip_id: tripId }));
    const { error } = await supabaseClient
      .from(STOPS)
      .upsert(payload, { onConflict: 'trip_id,stop_number' });
    if (error) throw error;
  }
}

async function verifyCapturedSave(snapshot) {
  if (!snapshot || !supabaseClient) return;
  try {
    if (snapshot.kind === 'overview') await verifyOverviewSave(snapshot);
    else await verifyTripSave(snapshot);
    repairVisibleStopPanel();
    schedulePillRepair(80);
  } catch (error) {
    console.error('[load-details-integrity] verification retry failed:', error);
    setDriverSyncStatus(`The load saved, but verification found a problem (${error.message || error}). Please try Save again.`, 'error');
  }
}

function editStopPanelComplete() {
  const countEl = document.getElementById('ld-tr-stopCount');
  if (!countEl) return null;
  const count = Math.max(0, parseInt(countEl.value, 10) || 0);
  if (count === 0) return true;
  for (let i = 0; i < count; i++) {
    const timeIn = document.querySelector(`#ld-tab-content [data-stop-field="timeIn"][data-stop-index="${i}"]`);
    const timeOut = document.querySelector(`#ld-tab-content [data-stop-field="timeOut"][data-stop-index="${i}"]`);
    if (!timeIn?.value?.trim() || !timeOut?.value?.trim()) return false;
  }
  return true;
}

function staticStopPanelComplete(fieldset) {
  const stopRows = [...fieldset.querySelectorAll('.ld-stop-row')].filter((row) => {
    const label = row.children?.[0]?.textContent?.trim() || '';
    return /^Stop\s+\d+/i.test(label);
  });
  if (!stopRows.length) return null;
  return stopRows.every((row) => {
    const inText = row.children?.[1]?.textContent || '';
    const outText = row.children?.[2]?.textContent || '';
    const inVal = inText.replace(/^\s*In:\s*/i, '').trim();
    const outVal = outText.replace(/^\s*Out:\s*/i, '').trim();
    return !!inVal && inVal !== '—' && !!outVal && outVal !== '—';
  });
}

function repairVisibleStopPanel() {
  const fieldset = [...document.querySelectorAll('#ld-tab-content fieldset')].find((fs) =>
    /^Stop In\/Out Times$/i.test(fs.querySelector('legend')?.textContent?.trim() || '')
  );
  if (!fieldset) return;
  const complete = document.getElementById('ld-tr-stopCount')
    ? editStopPanelComplete()
    : staticStopPanelComplete(fieldset);
  if (complete === true) fieldset.classList.remove('field-box-missing');
}

function imagePresent(path) {
  if (Array.isArray(path)) return path.length > 0;
  return !!String(path || '').trim();
}

function stopPairsComplete(trip, stopRows) {
  const count = Math.max(0, parseInt(trip.stop_count, 10) || 0);
  if (count === 0) return true;
  const byNumber = new Map((stopRows || []).map((stop) => [Number(stop.stop_number), stop]));
  for (let n = 1; n <= count; n++) {
    const stop = byNumber.get(n);
    if (!stop || !String(stop.time_in || '').trim() || !String(stop.time_out || '').trim()) return false;
  }
  return true;
}

function tripMissingFromDb(trip, stopRows, location) {
  const missing = [];
  if (location === 'delaware') {
    if (!imagePresent(trip.route_image_path)) missing.push('an image');
    return missing;
  }
  if (!trip.ppwk_received) missing.push('paperwork confirmation');
  if (!stopPairsComplete(trip, stopRows)) missing.push('stop times');
  if (!imagePresent(trip.route_image_path)) missing.push('an image');
  if (!String(trip.return_drop_location || '').trim()) missing.push('a drop location');
  if (!trip.checked_in) missing.push('load checked in');
  return missing;
}

async function reconcileVisiblePills() {
  clearTimeout(pillTimer);
  pillTimer = null;
  if (pillRepairRunning || !supabaseClient) return;
  const pills = [...document.querySelectorAll('#board-table .trip-chip.trip-segment-done')];
  if (!pills.length || !state.activeLocation || !state.activeDate) return;

  pillRepairRunning = true;
  try {
    const { data: shifts, error: shiftError } = await supabaseClient
      .from(SHIFTS)
      .select('id,pro_number')
      .eq('location', state.activeLocation)
      .eq('shift_date', state.activeDate);
    if (shiftError) throw shiftError;
    const shiftIds = (shifts || []).map((s) => s.id);
    if (!shiftIds.length) return;

    const { data: trips, error: tripError } = await supabaseClient
      .from(TRIPS)
      .select('id,shift_id,route_id,trip_id,stop_count,ppwk_received,checked_in,return_drop_location,route_image_path,complete')
      .in('shift_id', shiftIds);
    if (tripError) throw tripError;
    const tripIds = (trips || []).map((t) => t.id);
    let stops = [];
    if (tripIds.length) {
      const stopResult = await supabaseClient
        .from(STOPS)
        .select('trip_id,stop_number,time_in,time_out')
        .in('trip_id', tripIds);
      if (stopResult.error) throw stopResult.error;
      stops = stopResult.data || [];
    }

    const shiftByPro = new Map();
    (shifts || []).forEach((s) => {
      const key = String(s.pro_number || '').trim();
      if (key && !shiftByPro.has(key)) shiftByPro.set(key, s.id);
    });
    const stopsByTrip = new Map();
    stops.forEach((stop) => {
      const list = stopsByTrip.get(stop.trip_id) || [];
      list.push(stop);
      stopsByTrip.set(stop.trip_id, list);
    });

    pills.forEach((pill) => {
      const parentRow = document.getElementById(pill.dataset.row || '');
      const pro = parentRow?.querySelector('[data-field="proNumber"]')?.value?.trim() || '';
      const shiftId = shiftByPro.get(pro);
      if (!shiftId) return;
      const label = pill.textContent.trim();
      const trip = (trips || []).find((candidate) =>
        candidate.shift_id === shiftId &&
        (String(candidate.route_id || '').trim() === label || String(candidate.trip_id || '').trim() === label)
      );
      if (!trip || !trip.complete) return;
      const missing = tripMissingFromDb(trip, stopsByTrip.get(trip.id) || [], state.activeLocation);
      const undocumented = missing.length > 0;
      pill.classList.toggle('trip-chip-undocumented', undocumented);
      pill.title = undocumented
        ? `Closed out but missing: ${missing.join(', ')} — click to restore`
        : 'Closed out — click to restore';
    });
  } catch (error) {
    console.warn('[load-details-integrity] could not reconcile completed pills:', error);
  } finally {
    pillRepairRunning = false;
  }
}

function schedulePillRepair(delay = 250) {
  clearTimeout(pillTimer);
  pillTimer = setTimeout(reconcileVisiblePills, delay);
}

function init() {
  // Capture before loadboard.js's normal click handler has a chance to rerender
  // the modal and destroy the exact values the user just submitted.
  document.addEventListener('click', (event) => {
    const button = event.target.closest?.('[data-ld-save]');
    if (!button) return;
    const snapshot = captureModalSave(button);
    if (snapshot) setTimeout(() => void verifyCapturedSave(snapshot), 700);
  }, true);

  const observer = new MutationObserver(() => {
    repairVisibleStopPanel();
    schedulePillRepair();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  repairVisibleStopPanel();
  schedulePillRepair(50);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
