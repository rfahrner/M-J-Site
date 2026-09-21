/* ================================================================
   Accounting column presentation rules

   Keeps display-only Accounting rules out of the already-large board
   module. accounting.js still owns the records, calculations, saves,
   realtime sync, and table rendering. This module normalizes the columns
   after each render:
   - Customer Rate always appears immediately before Carrier Rate.
   - Delaware gets the Customer Rate column too.
   - Atlanta identifies routes by Trip ID; Delaware by Route ID.
   - Load/route pills reflect the LIVE board completion/documentation state.
   - By Driver totals line up with the Customer/Carrier header order.
   ================================================================ */
import './accounting-pricing-v2.js';
import { supabaseClient } from './loadboard.js';
import { getAccountingRecordById } from './accounting.js';

const ACCOUNTING_ROUTES_TABLE = 'loads_accounting_routes';

let scheduled = false;
let applying = false;
let routeFetchInFlight = false;
let statusFetchInFlight = false;
let statusRefreshTimer = null;
const atlantaRoutesByAccountingId = new Map();
const liveShiftsById = new Map();
const liveTripsByShiftId = new Map();
const liveTripsById = new Map();
const tripHasStopTimes = new Map();

function activeLocation() {
  return document.querySelector('#acct-location-tabs .location-tab.is-active')?.dataset.location || 'atlanta';
}

function installStatusStyles() {
  if (document.getElementById('accounting-live-status-styles')) return;
  const style = document.createElement('style');
  style.id = 'accounting-live-status-styles';
  style.textContent = `
    #accounting-table .acct-pill-good {
      background:#dcfce7 !important;
      border-color:#16a34a !important;
      color:#166534 !important;
    }
    #accounting-table .acct-pill-bad {
      background:#fee2e2 !important;
      border-color:#dc2626 !important;
      color:#991b1b !important;
    }
  `;
  document.head.appendChild(style);
}

function moneyInputCell(action, id, value) {
  const td = document.createElement('td');
  td.innerHTML = `
    <div style="display:flex; align-items:center; gap:2px;">
      <span class="subtext">$</span>
      <input class="cell-input" style="width:78px;" data-action="${action}" data-id="${id}" value="${value == null ? '' : Number(value).toFixed(2)}">
    </div>`;
  return td;
}

function ensureRateColumnOrder() {
  const headRow = document.querySelector('#accounting-table-head tr');
  const body = document.getElementById('accounting-table-body');
  if (!headRow || !body) return;

  const headers = [...headRow.children];
  const carrierHeader = headers.find((th) => th.textContent.trim() === 'Carrier Rate');
  let customerHeader = headers.find((th) => th.textContent.trim() === 'Customer Rate');
  if (!carrierHeader) return;

  if (!customerHeader) {
    customerHeader = document.createElement('th');
    customerHeader.textContent = 'Customer Rate';
  }
  if (customerHeader.nextElementSibling !== carrierHeader) {
    headRow.insertBefore(customerHeader, carrierHeader);
  }

  body.querySelectorAll('tr[id^="acct-"]').forEach((row) => {
    const carrierInput = row.querySelector('[data-action="acct-carrier-pay"]');
    if (!carrierInput) return;
    const carrierCell = carrierInput.closest('td');
    let customerInput = row.querySelector('[data-action="acct-customer-rate"]');
    let customerCell = customerInput?.closest('td') || null;

    if (!customerCell) {
      const accountingId = row.id.slice(5);
      const rec = getAccountingRecordById(accountingId);
      customerCell = moneyInputCell('acct-customer-rate', accountingId, rec?.total_revenue);
    }

    if (customerCell.nextElementSibling !== carrierCell) {
      row.insertBefore(customerCell, carrierCell);
    }
  });

  const emptyCell = body.querySelector('tr:not([id^="acct-"]) > td[colspan]');
  if (emptyCell) emptyCell.colSpan = headRow.children.length;
}

function normalizeRouteHeader() {
  const loc = activeLocation();
  if (loc !== 'atlanta' && loc !== 'delaware') return;
  const headRow = document.querySelector('#accounting-table-head tr');
  if (!headRow) return;
  const routeHeader = [...headRow.children].find((th) => {
    const text = th.textContent.trim();
    return text === 'Routes' || text === 'Trip ID' || text === 'Route ID';
  });
  if (routeHeader) routeHeader.textContent = loc === 'atlanta' ? 'Trip ID' : 'Route ID';
}

async function fetchAtlantaRouteIds() {
  if (activeLocation() !== 'atlanta' || !supabaseClient || routeFetchInFlight) return;
  const rows = [...document.querySelectorAll('#accounting-table-body tr[id^="acct-"]')];
  const missingIds = rows
    .map((row) => Number(row.id.slice(5)))
    .filter((id) => Number.isFinite(id) && !atlantaRoutesByAccountingId.has(id));
  if (!missingIds.length) return;

  routeFetchInFlight = true;
  try {
    for (let i = 0; i < missingIds.length; i += 150) {
      const ids = missingIds.slice(i, i + 150);
      const { data, error } = await supabaseClient
        .from(ACCOUNTING_ROUTES_TABLE)
        .select('accounting_id,route_number,route_id,trip_id,source_trip_id')
        .in('accounting_id', ids);
      if (error) throw error;

      const grouped = new Map(ids.map((id) => [id, []]));
      (data || []).forEach((route) => {
        if (!grouped.has(Number(route.accounting_id))) grouped.set(Number(route.accounting_id), []);
        grouped.get(Number(route.accounting_id)).push(route);
      });
      grouped.forEach((routes, id) => {
        routes.sort((a, b) => Number(a.route_number || 0) - Number(b.route_number || 0));
        atlantaRoutesByAccountingId.set(id, routes);
      });
    }
  } catch (error) {
    console.error('Failed to load Atlanta Trip IDs for Accounting:', error);
  } finally {
    routeFetchInFlight = false;
  }
}

/*
 * The accounting route a chip stands for.
 *
 * route_id is a free-text route NAME and is routinely repeated inside a single
 * load -- two "FRGT" routes, two "Nestle" routes. Matching on it returned the
 * first one every time, which is why the Trip ID column showed the same number
 * against two different routes while the database held the right ones, and why
 * the completion pill beside the second route described the first.
 *
 * route_number is unique within the load, so it is tried first. The positional
 * fallback is sound because both arrays are sorted by route_number. Matching on
 * the text is last and only helps genuinely old rows that predate route_number.
 */
function routeForChip(routes, button, index) {
  if (!Array.isArray(routes) || !routes.length) return null;
  const wantedNumber = String(button.dataset.acctRouteNumber || '').trim();
  if (wantedNumber) {
    const byNumber = routes.find((r) => String(r.route_number ?? '').trim() === wantedNumber);
    if (byNumber) return byNumber;
  }
  if (routes[index]) return routes[index];
  const routeId = String(button.dataset.openAcctRouteText || '').trim();
  return routes.find((r) => String(r.route_id || '').trim() === routeId) || null;
}

function applyAtlantaTripIds() {
  if (activeLocation() !== 'atlanta') return;
  document.querySelectorAll('#accounting-table-body tr[id^="acct-"]').forEach((row) => {
    const accountingId = Number(row.id.slice(5));
    const routes = atlantaRoutesByAccountingId.get(accountingId);
    if (!routes) return;

    const buttons = [...row.querySelectorAll('[data-open-acct-route-text]')];
    buttons.forEach((button, index) => {
      const route = routeForChip(routes, button, index);
      const tripId = String(route?.trip_id || '').trim();
      if (button.textContent !== (tripId || '—')) button.textContent = tripId || '—';
      button.title = tripId ? 'Open this trip\'s details' : 'Trip ID was not recorded for this older route';
      button.disabled = !tripId;
    });
  });
}

function visibleAccountingRecords() {
  return [...document.querySelectorAll('#accounting-table-body tr[id^="acct-"]')]
    .map((row) => getAccountingRecordById(row.id.slice(5)))
    .filter(Boolean);
}

function imageOnFile(value) {
  if (!value) return false;
  const raw = String(value).trim();
  if (!raw || raw === '[]' || raw === 'null') return false;
  if (raw.startsWith('[')) {
    try {
      const list = JSON.parse(raw);
      return Array.isArray(list) && list.some(Boolean);
    } catch (e) { return true; }
  }
  return true;
}

function tripMissing(trip, location) {
  if (!trip) return ['route status unavailable'];
  const missing = [];
  if (!trip.complete) missing.push('route not complete');
  if (!imageOnFile(trip.route_image_path)) missing.push('image');

  // Delaware intentionally has the lighter documentation rule used on its
  // load board: complete + image. Atlanta/Building C use the full closeout.
  if (location !== 'delaware') {
    if (!trip.ppwk_received) missing.push('paperwork confirmation');
    if (!tripHasStopTimes.get(Number(trip.id))) missing.push('stop times');
    if (!String(trip.return_drop_location || '').trim()) missing.push('drop location');
    if (!trip.checked_in) missing.push('load checked in');
  }
  return missing;
}

function setPillState(button, good, title) {
  if (!button) return;
  button.classList.toggle('acct-pill-good', !!good);
  button.classList.toggle('acct-pill-bad', !good);
  if (title) button.title = title;
}

/*
 * The live loads_trips row an accounting route came from.
 *
 * Ordered most-specific first, which is the opposite of how this used to read.
 * source_trip_id IS the loads_trips id, so it is exact. Trip ID is the
 * dispatcher-facing number and is effectively unique. route_id is a route NAME
 * and repeats within a load -- matching on it first meant two routes called
 * "FRGT" resolved to the same live trip, so the second one's completion pill
 * described the first one's paperwork.
 */
function findLiveTripForRoute(rec, route, index) {
  const trips = liveTripsByShiftId.get(Number(rec.source_shift_id)) || [];
  if (!trips.length) return null;

  const sourceTripId = route?.source_trip_id;
  if (sourceTripId != null) {
    const exact = liveTripsById.get(Number(sourceTripId));
    if (exact) return exact;
  }
  const tripId = String(route?.trip_id || '').trim();
  if (tripId) {
    const byTripId = trips.find((trip) => String(trip.trip_id || '').trim() === tripId);
    if (byTripId) return byTripId;
  }
  const routeId = String(route?.route_id || '').trim();
  // Only safe when the name is unambiguous within this shift.
  if (routeId) {
    const named = trips.filter((trip) => String(trip.route_id || '').trim() === routeId);
    if (named.length === 1) return named[0];
  }
  return trips[index] || null;
}

function applyCompletionStatus() {
  document.querySelectorAll('#accounting-table-body tr[id^="acct-"]').forEach((row) => {
    const rec = getAccountingRecordById(row.id.slice(5));
    if (!rec || !rec.source_shift_id) return;
    const shift = liveShiftsById.get(Number(rec.source_shift_id));
    if (!shift) return;
    const trips = liveTripsByShiftId.get(Number(rec.source_shift_id)) || [];

    if (rec.location === 'atlanta') {
      const routes = atlantaRoutesByAccountingId.get(Number(rec.id)) || [];
      const buttons = [...row.querySelectorAll('[data-open-acct-route-text]')];
      buttons.forEach((button, index) => {
        const route = routeForChip(routes, button, index);
        const trip = findLiveTripForRoute(rec, route, index);
        if (!trip) return;
        const missing = tripMissing(trip, rec.location);
        setPillState(button, missing.length === 0, missing.length ? `Missing: ${missing.join(', ')}` : 'Route complete — all closeout information is on file');
      });
    } else if (rec.location === 'delaware') {
      [...row.querySelectorAll('[data-open-acct-trip]')].forEach((button) => {
        const trip = liveTripsById.get(Number(button.dataset.openAcctTrip));
        if (!trip) return;
        const missing = tripMissing(trip, rec.location);
        setPillState(button, missing.length === 0, missing.length ? `Missing: ${missing.join(', ')}` : 'Route complete — all required information is on file');
      });
    }

    // The Aljex/PRO pill reflects the whole load, not merely the shift_complete
    // boolean. Green means Accounting truly has a completed shift and every
    // route's required closeout data; red means something is still missing.
    const loadButton = row.querySelector(`[data-open-acct-load="${rec.id}"]:not([data-open-acct-route-text]):not([data-open-acct-trip])`);
    const routeProblems = trips.flatMap((trip) => tripMissing(trip, rec.location));
    const timeSheetMissing = rec.location === 'atlanta' && (
      !shift.timesheet_received || !String(shift.timesheet_start_time || '').trim() || !String(shift.timesheet_end_time || '').trim()
    );
    const loadGood = !!shift.shift_complete && trips.length > 0 && routeProblems.length === 0 && !timeSheetMissing;
    const reasons = [];
    if (!shift.shift_complete) reasons.push('shift not marked complete');
    if (!trips.length) reasons.push('no route record');
    if (routeProblems.length) reasons.push('route closeout incomplete');
    if (timeSheetMissing) reasons.push('time sheet incomplete');
    setPillState(loadButton, loadGood, loadGood ? 'Load complete — all required information is on file' : `Missing: ${reasons.join(', ')}`);
  });
}

async function fetchLiveCompletionStatus(force = false) {
  if (!supabaseClient || statusFetchInFlight) return;
  const records = visibleAccountingRecords().filter((rec) => rec.source_shift_id);
  const shiftIds = [...new Set(records.map((rec) => Number(rec.source_shift_id)).filter(Number.isFinite))];
  const needed = force ? shiftIds : shiftIds.filter((id) => !liveShiftsById.has(id));
  if (!needed.length) {
    applyCompletionStatus();
    return;
  }

  statusFetchInFlight = true;
  try {
    for (let i = 0; i < needed.length; i += 150) {
      const ids = needed.slice(i, i + 150);
      const [{ data: shifts, error: shiftError }, { data: trips, error: tripError }] = await Promise.all([
        supabaseClient.from('loads_shifts')
          .select('id,shift_complete,timesheet_received,timesheet_start_time,timesheet_end_time')
          .in('id', ids),
        supabaseClient.from('loads_trips')
          .select('id,shift_id,route_id,trip_id,complete,ppwk_received,checked_in,return_drop_location,route_image_path')
          .in('shift_id', ids),
      ]);
      if (shiftError) throw shiftError;
      if (tripError) throw tripError;

      (shifts || []).forEach((shift) => liveShiftsById.set(Number(shift.id), shift));
      ids.forEach((id) => liveTripsByShiftId.set(Number(id), []));
      (trips || []).forEach((trip) => {
        liveTripsById.set(Number(trip.id), trip);
        const key = Number(trip.shift_id);
        if (!liveTripsByShiftId.has(key)) liveTripsByShiftId.set(key, []);
        liveTripsByShiftId.get(key).push(trip);
      });

      const tripIds = (trips || []).map((trip) => Number(trip.id)).filter(Number.isFinite);
      tripIds.forEach((id) => tripHasStopTimes.set(id, false));
      for (let j = 0; j < tripIds.length; j += 150) {
        const tripChunk = tripIds.slice(j, j + 150);
        const { data: stops, error: stopError } = await supabaseClient
          .from('trip_stops')
          .select('trip_id,time_in,time_out')
          .in('trip_id', tripChunk);
        if (stopError) throw stopError;
        (stops || []).forEach((stop) => {
          if (stop.time_in || stop.time_out) tripHasStopTimes.set(Number(stop.trip_id), true);
        });
      }
    }
    applyCompletionStatus();
  } catch (error) {
    console.error('Failed to load live Accounting completion status:', error);
  } finally {
    statusFetchInFlight = false;
  }
}

function invalidateLiveStatus() {
  liveShiftsById.clear();
  liveTripsByShiftId.clear();
  liveTripsById.clear();
  tripHasStopTimes.clear();
  clearTimeout(statusRefreshTimer);
  statusRefreshTimer = setTimeout(() => void fetchLiveCompletionStatus(true), 120);
}

function setupLiveStatusRealtime(attempt = 0) {
  if (!supabaseClient) {
    if (attempt < 50) setTimeout(() => setupLiveStatusRealtime(attempt + 1), 100);
    return;
  }
  const channel = supabaseClient.channel('accounting-live-completion-v1');
  channel
    .on('postgres_changes', { event: '*', schema: 'public', table: 'loads_shifts' }, invalidateLiveStatus)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'loads_trips' }, invalidateLiveStatus)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'trip_stops' }, invalidateLiveStatus)
    .subscribe();
}

function fixByDriverColumnOrder() {
  const body = document.getElementById('accounting-driver-table-body');
  if (!body) return;
  body.querySelectorAll('tr').forEach((row) => {
    if (row.dataset.rateColumnsFixed === 'true' || row.cells.length < 7) return;
    // accounting.js renders carrier pay in cell 5 and revenue in cell 6,
    // while the existing headers are Customer Rate then Carrier Rate.
    // Move revenue ahead of carrier pay so the values match the headers.
    row.insertBefore(row.cells[5], row.cells[4]);
    row.dataset.rateColumnsFixed = 'true';
  });
}

async function applyAccountingPresentation() {
  scheduled = false;
  if (applying) return;
  applying = true;
  try {
    ensureRateColumnOrder();
    normalizeRouteHeader();
    fixByDriverColumnOrder();
    if (activeLocation() === 'atlanta') {
      await fetchAtlantaRouteIds();
      applyAtlantaTripIds();
    }
    await fetchLiveCompletionStatus();
    applyCompletionStatus();
  } finally {
    applying = false;
  }
}

function scheduleApply() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => { void applyAccountingPresentation(); });
}

function initAccountingColumns() {
  const table = document.getElementById('accounting-table');
  const driverTable = document.getElementById('accounting-driver-table');
  if (!table) return;

  installStatusStyles();
  const observer = new MutationObserver(scheduleApply);
  observer.observe(table, { childList: true, subtree: true });
  if (driverTable) observer.observe(driverTable, { childList: true, subtree: true });

  document.getElementById('acct-location-tabs')?.addEventListener('click', scheduleApply);
  setupLiveStatusRealtime();
  scheduleApply();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initAccountingColumns, { once: true });
} else {
  initAccountingColumns();
}
