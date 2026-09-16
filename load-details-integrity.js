/*
 * Load Details integrity guard.
 * - Reconciles completed-route pill validation from the actual DB stop rows.
 * - Removes stale Stop In/Out red styling when every expected pair is present.
 * - Verifies modal saves and idempotently retries the captured route/stop data
 *   so one transient stop-row failure cannot leave a half-saved modal.
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
  return !!document.getElementById(id)?.checked;
}

function boolish(raw) {
  if (raw === true) return true;
  if (raw === false || raw == null) return false;
  const text = String(raw).trim().toLowerCase();
  if (!text || ['false', '0', 'no', 'null', 'undefined'].includes(text)) return false;
  return true;
}

function nullableNumber(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function currentProNumber() {
  const title = document.getElementById('ld-title')?.textContent || '';
  const titleValue = title.replace(/^Load\s*#/i, '').replace(/^\s*\(not assigned\)\s*$/i, '').trim();
  if (titleValue) return titleValue;
  return document.querySelector('#board-table [data-field="proNumber"]:focus')?.value?.trim() || '';
}

function tripNumberForLocalId(localId) {
  const tabs = [...document.querySelectorAll('#ld-tabs .ld-tab[data-tab^="trip-"]')];
  const index = tabs.findIndex((tab) => tab.dataset.tab === `trip-${localId}`);
  return index >= 0 ? index + 1 : null;
}

function captureStops(count) {
  const result = [];
  for (let index = 0; index < count; index++) {
    const timeIn = document.querySelector(`#ld-tab-content [data-stop-field="timeIn"][data-stop-index="${index}"]`);
    const timeOut = document.querySelector(`#ld-tab-content [data-stop-field="timeOut"][data-stop-index="${index}"]`);
    result.push({
      stop_number: index + 1,
      time_in: timeIn ? String(timeIn.value || '').trim() || null : null,
      time_out: timeOut ? String(timeOut.value || '').trim() || null : null,
    });
  }
  return result;
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

  const stopCountText = value('ld-tr-stopCount');
  const stopCount = Math.max(0, parseInt(stopCountText, 10) || 0);
  const complete = checked('ld-tr-complete');
  return {
    ...base,
    tripNumber: tripNumberForLocalId(key),
    route: {
      route_id: value('ld-tr-routeId') || null,
      trip_id: value('ld-tr-tripId') || null,
      trailer_out: value('ld-tr-trailerOut') || null,
      route_miles: nullableNumber(value('ld-tr-routeMiles')),
      stop_count: nullableNumber(stopCountText),
      notes: value('ld-tr-notes') || null,
      dispatch_time: value('ld-tr-dispatch-time') || null,
      return_eta_to_dc: value('ld-tr-return-eta') || null,
      ppwk_received: complete ? 'true' : (checked('ld-tr-ppwk-received') ? 'true' : 'false'),
      checked_in: checked('ld-tr-checked-in'),
      return_drop_location: value('ld-tr-drop-location') || null,
      complete,
      minimized: complete,
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
  return data?.[0]?.id || null;
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

async function findOrCreateTrip(shiftId, snapshot) {
  const lookup = await supabaseClient
    .from(TRIPS)
    .select('id')
    .eq('shift_id', shiftId)
    .eq('trip_number', snapshot.tripNumber)
    .limit(1);
  if (lookup.error) throw lookup.error;
  if (lookup.data?.[0]?.id) return lookup.data[0].id;

  const inserted = await supabaseClient.from(TRIPS).insert({
    ...snapshot.route,
    shift_id: shiftId,
    trip_number: snapshot.tripNumber,
  }).select('id').limit(1);
  if (!inserted.error && inserted.data?.[0]?.id) return inserted.data[0].id;

  // If the normal save and the verification save raced to create the same
  // trip, re-read the winner rather than reporting a false failure.
  const retry = await supabaseClient
    .from(TRIPS)
    .select('id')
    .eq('shift_id', shiftId)
    .eq('trip_number', snapshot.tripNumber)
    .limit(1);
  if (retry.error) throw retry.error;
  if (retry.data?.[0]?.id) return retry.data[0].id;
  throw inserted.error || new Error('Trip row could not be resolved after save.');
}

async function verifyTripSave(snapshot) {
  if (!snapshot.tripNumber) return;
  const shiftId = await resolveShiftId(snapshot);
  if (!shiftId) return;
  const tripId = await findOrCreateTrip(shiftId, snapshot);

  const tripUpdate = await supabaseClient.from(TRIPS).update(snapshot.route).eq('id', tripId);
  if (tripUpdate.error) throw tripUpdate.error;

  if (snapshot.stops.length) {
    const payload = snapshot.stops.map((stop) => ({ ...stop, trip_id: tripId }));
    const stopUpdate = await supabaseClient
      .from(STOPS)
      .upsert(payload, { onConflict: 'trip_id,stop_number' });
    if (stopUpdate.error) throw stopUpdate.error;
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
  const countElement = document.getElementById('ld-tr-stopCount');
  if (!countElement) return null;
  const count = Math.max(0, parseInt(countElement.value, 10) || 0);
  if (count === 0) return true;
  for (let index = 0; index < count; index++) {
    const timeIn = document.querySelector(`#ld-tab-content [data-stop-field="timeIn"][data-stop-index="${index}"]`);
    const timeOut = document.querySelector(`#ld-tab-content [data-stop-field="timeOut"][data-stop-index="${index}"]`);
    if (!timeIn?.value?.trim() || !timeOut?.value?.trim()) return false;
  }
  return true;
}

function staticStopPanelComplete(fieldset) {
  const rows = [...fieldset.querySelectorAll('.ld-stop-row')].filter((row) =>
    /^Stop\s+\d+/i.test(row.children?.[0]?.textContent?.trim() || '')
  );
  if (!rows.length) return null;
  return rows.every((row) => {
    const timeIn = (row.children?.[1]?.textContent || '').replace(/^\s*In:\s*/i, '').trim();
    const timeOut = (row.children?.[2]?.textContent || '').replace(/^\s*Out:\s*/i, '').trim();
    return !!timeIn && timeIn !== '—' && !!timeOut && timeOut !== '—';
  });
}

function repairVisibleStopPanel() {
  const fieldset = [...document.querySelectorAll('#ld-tab-content fieldset')].find((item) =>
    /^Stop In\/Out Times$/i.test(item.querySelector('legend')?.textContent?.trim() || '')
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
  for (let number = 1; number <= count; number++) {
    const stop = byNumber.get(number);
    if (!stop || !String(stop.time_in || '').trim() || !String(stop.time_out || '').trim()) return false;
  }
  return true;
}

function missingDocumentation(trip, stopRows, location) {
  const missing = [];
  if (location === 'delaware') {
    if (!imagePresent(trip.route_image_path)) missing.push('an image');
    return missing;
  }
  if (!boolish(trip.ppwk_received)) missing.push('paperwork confirmation');
  if (!stopPairsComplete(trip, stopRows)) missing.push('stop times');
  if (!imagePresent(trip.route_image_path)) missing.push('an image');
  if (!String(trip.return_drop_location || '').trim()) missing.push('a drop location');
  if (!boolish(trip.checked_in)) missing.push('load checked in');
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
    const shiftResult = await supabaseClient
      .from(SHIFTS)
      .select('id,pro_number')
      .eq('location', state.activeLocation)
      .eq('shift_date', state.activeDate);
    if (shiftResult.error) throw shiftResult.error;
    const shifts = shiftResult.data || [];
    const shiftIds = shifts.map((shift) => shift.id);
    if (!shiftIds.length) return;

    const tripResult = await supabaseClient
      .from(TRIPS)
      .select('id,shift_id,route_id,trip_id,stop_count,ppwk_received,checked_in,return_drop_location,route_image_path,complete')
      .in('shift_id', shiftIds);
    if (tripResult.error) throw tripResult.error;
    const trips = tripResult.data || [];
    const tripIds = trips.map((trip) => trip.id);

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
    shifts.forEach((shift) => {
      const key = String(shift.pro_number || '').trim();
      if (key && !shiftByPro.has(key)) shiftByPro.set(key, shift.id);
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
      const trip = trips.find((candidate) =>
        candidate.shift_id === shiftId &&
        (String(candidate.route_id || '').trim() === label || String(candidate.trip_id || '').trim() === label)
      );
      if (!trip || !boolish(trip.complete)) return;

      const missing = missingDocumentation(trip, stopsByTrip.get(trip.id) || [], state.activeLocation);
      pill.classList.toggle('trip-chip-undocumented', missing.length > 0);
      pill.title = missing.length
        ? `Closed out but missing: ${missing.join(', ')} — click to restore`
        : 'Closed out — click to restore';
    });
  } catch (error) {
    console.warn('[load-details-integrity] completed-pill reconciliation failed:', error);
  } finally {
    pillRepairRunning = false;
  }
}

function schedulePillRepair(delay = 250) {
  clearTimeout(pillTimer);
  pillTimer = setTimeout(() => void reconcileVisiblePills(), delay);
}

function init() {
  document.addEventListener('click', (event) => {
    const button = event.target.closest?.('[data-ld-save]');
    if (!button) return;
    const snapshot = captureModalSave(button);
    if (snapshot) setTimeout(() => void verifyCapturedSave(snapshot), 700);
  }, true);

  new MutationObserver(() => {
    repairVisibleStopPanel();
    schedulePillRepair();
  }).observe(document.body, { childList: true, subtree: true });

  repairVisibleStopPanel();
  schedulePillRepair(50);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
