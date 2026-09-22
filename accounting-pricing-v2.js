/*
 * Accounting pricing v2 presentation.
 *
 * Accounting receives the rate that was applied on the load board, but the
 * dollar fields remain normal editable Accounting fields after they arrive.
 * "Applied" is informational only and is derived from the SAME rate inputs
 * the load board used: Base rate / Daily Rate / Driver Rate / Carrier rate.
 * Revenue Rate selects Core or Holiday customer pricing. Day Type is hidden.
 */
import { supabaseClient } from './loadboard.js';
import { atlantaMileageTier } from './carrier-mileage-tiers.js';
import { getAccountingRecordById } from './accounting.js';

let scheduled = false;
let applying = false;
let sourceFetchInFlight = false;
let sourceRefreshTimer = null;
const appliedSourceByShiftId = new Map();

function appliedLabel(value) {
  return ({ 1: 'Base rate', 2: 'Driver Rate', 3: 'Daily Rate', 4: 'Carrier rate' })[Number(value)] || 'Base rate';
}

function installStyles() {
  if (document.getElementById('accounting-pricing-v2-styles')) return;
  const style = document.createElement('style');
  style.id = 'accounting-pricing-v2-styles';
  style.textContent = `
    #accounting-table .accounting-applied-label {
      display:block;
      min-width:104px;
      padding:7px 8px;
      text-align:left;
      white-space:nowrap;
    }
    #accounting-table input[data-action="acct-carrier-pay"],
    #accounting-table input[data-action="acct-customer-rate"] {
      cursor:text !important;
      user-select:text;
    }
  `;
  document.head.appendChild(style);
}

function removeHeaderByText(headRow, text) {
  const th = [...headRow.children].find((cell) => cell.textContent.trim() === text);
  if (th) th.remove();
}

function normalizeHeader() {
  const headRow = document.querySelector('#accounting-table-head tr');
  if (!headRow) return;

  const cost = [...headRow.children].find((th) => ['Cost Level', 'Applied'].includes(th.textContent.trim()));
  if (cost) {
    cost.textContent = 'Applied';
    cost.title = 'Rate source that was applied on the load board';
  }

  removeHeaderByText(headRow, 'Day Type');
}

function recordAppliedLabel(rec) {
  if (rec?.source_shift_id && appliedSourceByShiftId.has(Number(rec.source_shift_id))) {
    return appliedSourceByShiftId.get(Number(rec.source_shift_id));
  }
  return appliedLabel(rec?.cost_level);
}

function normalizeRow(row) {
  if (!row?.id?.startsWith('acct-')) return;
  const id = row.id.slice(5);
  const rec = getAccountingRecordById(id);
  if (!rec) return;


  // Applied is display-only. It reports what actually won on the board and
  // intentionally has no dropdown or change handler.
  const oldAppliedControl = row.querySelector('[data-action="acct-cost-level"], [data-action="acct-applied-rate"]');
  if (oldAppliedControl) {
    const td = oldAppliedControl.closest('td');
    if (td) {
      const label = document.createElement('span');
      label.className = 'accounting-applied-label';
      label.dataset.accountingAppliedLabel = '1';
      label.textContent = recordAppliedLabel(rec);
      label.title = 'Informational only — this is what the load board applied';
      td.replaceChildren(label);
    }
  } else {
    const label = row.querySelector('[data-accounting-applied-label]');
    const next = recordAppliedLabel(rec);
    if (label && label.textContent !== next) label.textContent = next;
  }

  // Day Type is no longer part of Accounting's workflow on any location tab.
  row.querySelector('[data-action="acct-day-type"]')?.closest('td')?.remove();

  // These are ordinary editable Accounting inputs. The board value / customer
  // formula provides the starting figure, but Accounting can click anywhere
  // in the number and type exactly like any other text cell.
  const carrier = row.querySelector('[data-action="acct-carrier-pay"]');
  if (carrier) {
    carrier.readOnly = false;
    carrier.removeAttribute('readonly');
    carrier.classList.remove('accounting-board-rate');
    carrier.title = 'Starts with the load-board rate; editable in Accounting';
  }

  const customer = row.querySelector('[data-action="acct-customer-rate"]');
  if (customer) {
    customer.readOnly = false;
    customer.removeAttribute('readonly');
    customer.classList.remove('accounting-customer-calculated');
    customer.title = 'Starts with the calculated customer rate; editable in Accounting';
  }
}

function hasOverrides(value) {
  if (!value) return false;
  let obj = value;
  if (typeof obj === 'string') {
    try { obj = JSON.parse(obj); } catch (e) { return !!obj.trim(); }
  }
  if (!obj || typeof obj !== 'object') return false;
  if (Array.isArray(obj)) return obj.length > 0;
  const tiers = obj.tiers && typeof obj.tiers === 'object' ? Object.keys(obj.tiers) : [];
  const settings = obj.settings && typeof obj.settings === 'object' ? Object.keys(obj.settings) : [];
  return tiers.length > 0 || settings.length > 0 || Object.keys(obj).some((key) => !['tiers', 'settings'].includes(key));
}

function objOrEmpty(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value) || {}; } catch (e) { return {}; }
}

function sameMoney(a, b) {
  const aa = Number(a), bb = Number(b);
  return Number.isFinite(aa) && Number.isFinite(bb) && Math.abs(aa - bb) < 0.01;
}

function differentMoney(a, b) {
  const aa = Number(a), bb = Number(b);
  if (!Number.isFinite(aa) || !Number.isFinite(bb)) return true;
  return Math.abs(aa - bb) >= 0.01;
}

function mapDaily(rows) {
  const map = new Map();
  (rows || []).forEach((row) => {
    const key = `${row.location}|${row.rate_date}`;
    if (!map.has(key)) map.set(key, { tiers: {}, settings: {} });
    const bucket = map.get(key);
    if (row.kind === 'tier') bucket.tiers[String(row.rate_key)] = Number(row.value);
    else bucket.settings[String(row.rate_key)] = Number(row.value);
  });
  return map;
}

function settingValue(settings, key, fallback) {
  const hit = settings.find((row) => row.key === key);
  return hit ? Number(hit.value) : Number(fallback);
}

function dailySetting(baseSettings, daily, key, fallback) {
  const base = settingValue(baseSettings, key, fallback);
  const override = daily?.settings?.[key];
  return override != null ? Number(override) : base;
}

function driverSetting(driverOverrides, key, fallback) {
  const value = driverOverrides?.settings?.[key];
  if (value == null) return Number(fallback);
  if (key === 'stop_charge_free_stops') return Math.min(Number(fallback), Number(value));
  return Math.max(Number(fallback), Number(value));
}

function calcAtlantaTotal(shift, trips, driver, tiers, settings, dailyCard, mode) {
  const useDaily = mode !== 'base';
  const useDriver = mode === 'driver';
  const driverOverrides = objOrEmpty(driver?.atlanta_rate_overrides);

  if (shift.tonu) {
    let flat = useDaily ? dailySetting(settings, dailyCard, 'tonu_flat', 150) : settingValue(settings, 'tonu_flat', 150);
    if (useDriver) flat = driverSetting(driverOverrides, 'tonu_flat', flat);
    return Math.round(flat * 100) / 100;
  }

  let total = 0;
  for (const trip of trips) {
    if (!String(trip.route_id || trip.trip_id || '').trim()) continue;
    const miles = Number(trip.route_miles);
    if (!Number.isFinite(miles) || miles <= 0) continue;
    const tier = atlantaMileageTier(tiers, miles);
    let routeRate;
    if (tier) {
      const base = Number(tier.rate);
      const dailyValue = useDaily && dailyCard?.tiers?.[String(tier.id)] != null ? Number(dailyCard.tiers[String(tier.id)]) : base;
      routeRate = dailyValue;
      if (useDriver) {
        const driverValue = driverOverrides?.tiers?.[tier.id] ?? driverOverrides?.tiers?.[String(tier.id)];
        if (driverValue != null) routeRate = Math.max(routeRate, Number(driverValue));
      }
    } else {
      let perMile = useDaily ? dailySetting(settings, dailyCard, 'over_tier_per_mile', 2.4) : settingValue(settings, 'over_tier_per_mile', 2.4);
      if (useDriver) perMile = driverSetting(driverOverrides, 'over_tier_per_mile', perMile);
      routeRate = miles * perMile;
    }

    const stops = Number.parseInt(trip.stop_count, 10) || 0;
    let freeStops = useDaily ? dailySetting(settings, dailyCard, 'stop_charge_free_stops', 2) : settingValue(settings, 'stop_charge_free_stops', 2);
    let perStop = useDaily ? dailySetting(settings, dailyCard, 'stop_charge_per_stop', 20) : settingValue(settings, 'stop_charge_per_stop', 20);
    if (useDriver) {
      freeStops = driverSetting(driverOverrides, 'stop_charge_free_stops', freeStops);
      perStop = driverSetting(driverOverrides, 'stop_charge_per_stop', perStop);
    }
    const stopCharge = stops > freeStops ? (stops - freeStops) * perStop : 0;
    total += routeRate + stopCharge;
  }
  return Math.round(total * 100) / 100;
}

function deriveAtlantaAppliedSource(shift, trips, driver, tiers, settings, dailyCard) {
  const carrierRate = Number(shift.carrier_rate);
  if (!Number.isFinite(carrierRate)) return null;

  // A typed rate or a load-specific rate card is, by definition, a rate for
  // this carrier/load rather than the permanent location rate.
  if (shift.rate_manual || hasOverrides(shift.rate_overrides)) return 'Carrier rate';

  const baseTotal = calcAtlantaTotal(shift, trips, driver, tiers, settings, dailyCard, 'base');
  const dailyTotal = calcAtlantaTotal(shift, trips, driver, tiers, settings, dailyCard, 'daily');
  const driverTotal = calcAtlantaTotal(shift, trips, driver, tiers, settings, dailyCard, 'driver');
  const normalRate = Number(driver?.normal_rate);

  // The carrier's profile/base rate is a floor on the board. It only wins
  // when it is actually higher than the tier/daily/driver calculation.
  if (Number.isFinite(normalRate) && normalRate > driverTotal + 0.005 && sameMoney(carrierRate, normalRate)) {
    return 'Carrier rate';
  }

  if (sameMoney(carrierRate, driverTotal) && differentMoney(driverTotal, dailyTotal)) return 'Driver Rate';
  if (sameMoney(carrierRate, dailyTotal) && differentMoney(dailyTotal, baseTotal)) return 'Daily Rate';
  if (sameMoney(carrierRate, baseTotal)) return 'Base rate';

  // If the final number does not match one of the calculated cards (older
  // records, a direct board edit, or a carrier agreement not represented by
  // the tier tables), it is safest and most useful to call it Carrier rate.
  if (Number.isFinite(normalRate) && sameMoney(carrierRate, normalRate) && differentMoney(normalRate, baseTotal)) return 'Carrier rate';
  return 'Carrier rate';
}

function visibleRecords() {
  return [...document.querySelectorAll('#accounting-table-body tr[id^="acct-"]')]
    .map((row) => getAccountingRecordById(row.id.slice(5)))
    .filter(Boolean);
}

function applyCachedLabels() {
  document.querySelectorAll('#accounting-table-body tr[id^="acct-"]').forEach((row) => normalizeRow(row));
}

async function refreshAppliedSources(force = false) {
  if (!supabaseClient || sourceFetchInFlight) return;
  const records = visibleRecords().filter((rec) => rec.location === 'atlanta' && rec.source_shift_id);
  const shiftIds = [...new Set(records.map((rec) => Number(rec.source_shift_id)).filter(Number.isFinite))];
  const needed = force ? shiftIds : shiftIds.filter((id) => !appliedSourceByShiftId.has(id));
  if (!needed.length) {
    applyCachedLabels();
    return;
  }

  sourceFetchInFlight = true;
  try {
    const [{ data: shifts, error: shiftError }, { data: trips, error: tripError }, { data: tiers, error: tierError }, { data: settings, error: settingError }] = await Promise.all([
      supabaseClient.from('loads_shifts')
        .select('id,driver_id,carrier_rate,rate_manual,rate_overrides,location,shift_date,tonu')
        .in('id', needed),
      supabaseClient.from('loads_trips')
        .select('id,shift_id,route_id,trip_id,route_miles,stop_count')
        .in('shift_id', needed),
      supabaseClient.from('board_rate_tiers').select('id,location,min_miles,max_miles,rate').eq('location', 'atlanta'),
      supabaseClient.from('board_rate_settings').select('location,key,value').eq('location', 'atlanta'),
    ]);
    if (shiftError) throw shiftError;
    if (tripError) throw tripError;
    if (tierError) throw tierError;
    if (settingError) throw settingError;

    const shiftRows = shifts || [];
    const driverIds = [...new Set(shiftRows.map((shift) => Number(shift.driver_id)).filter(Number.isFinite))];
    const dates = [...new Set(shiftRows.map((shift) => shift.shift_date).filter(Boolean))];
    const [driverResult, dailyResult] = await Promise.all([
      driverIds.length
        ? supabaseClient.from('atlanta_drivers').select('id,normal_rate,atlanta_rate_overrides').in('id', driverIds)
        : Promise.resolve({ data: [], error: null }),
      dates.length
        ? supabaseClient.from('board_rate_daily_overrides').select('location,rate_date,kind,rate_key,value').eq('location', 'atlanta').in('rate_date', dates)
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (driverResult.error) throw driverResult.error;
    if (dailyResult.error) throw dailyResult.error;

    const drivers = new Map((driverResult.data || []).map((driver) => [Number(driver.id), driver]));
    const daily = mapDaily(dailyResult.data || []);
    const tripsByShift = new Map();
    (trips || []).forEach((trip) => {
      const key = Number(trip.shift_id);
      if (!tripsByShift.has(key)) tripsByShift.set(key, []);
      tripsByShift.get(key).push(trip);
    });

    for (const shift of shiftRows) {
      const id = Number(shift.id);
      const driver = drivers.get(Number(shift.driver_id)) || null;
      const dailyCard = daily.get(`${shift.location || 'atlanta'}|${shift.shift_date}`) || { tiers: {}, settings: {} };
      const label = deriveAtlantaAppliedSource(shift, tripsByShift.get(id) || [], driver, tiers || [], settings || [], dailyCard);
      if (label) appliedSourceByShiftId.set(id, label);
    }
    applyCachedLabels();
  } catch (error) {
    console.error('Could not derive Accounting Applied rate sources:', error);
  } finally {
    sourceFetchInFlight = false;
  }
}

function invalidateAppliedSources() {
  appliedSourceByShiftId.clear();
  clearTimeout(sourceRefreshTimer);
  sourceRefreshTimer = setTimeout(() => void refreshAppliedSources(true), 150);
}

function setupAppliedSourceRealtime(attempt = 0) {
  if (!supabaseClient) {
    if (attempt < 50) setTimeout(() => setupAppliedSourceRealtime(attempt + 1), 100);
    return;
  }
  supabaseClient.channel('accounting-applied-rate-source-v1')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'loads_shifts' }, invalidateAppliedSources)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'atlanta_drivers' }, invalidateAppliedSources)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'board_rate_daily_overrides' }, invalidateAppliedSources)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'board_rate_tiers' }, invalidateAppliedSources)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'board_rate_settings' }, invalidateAppliedSources)
    .subscribe();
}

function normalizeTable() {
  scheduled = false;
  if (applying) return;
  applying = true;
  try {
    normalizeHeader();
    document.querySelectorAll('#accounting-table-body tr[id^="acct-"]').forEach(normalizeRow);

    const headRow = document.querySelector('#accounting-table-head tr');
    const emptyCell = document.querySelector('#accounting-table-body tr:not([id^="acct-"]) > td[colspan]');
    if (headRow && emptyCell) emptyCell.colSpan = headRow.children.length;

    // Keep the page explanation aligned with the simplified workflow.
    const heading = document.querySelector('#driverlist-view h1');
    const subtext = heading?.parentElement?.querySelector('.subtext');
    if (subtext) {
      subtext.textContent = 'Loads arrive automatically from the boards. Applied shows whether the load used the location base, a daily rate, a driver rate, or the carrier base rate; Customer Rate and Carrier Rate remain editable in Accounting.';
    }
  } finally {
    applying = false;
  }
  void refreshAppliedSources();
}

function scheduleNormalize() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(normalizeTable);
}

function initAccountingPricingV2() {
  const table = document.getElementById('accounting-table');
  if (!table) return;
  installStyles();
  new MutationObserver(scheduleNormalize).observe(table, { childList: true, subtree: true });
  document.getElementById('acct-location-tabs')?.addEventListener('click', scheduleNormalize);
  setupAppliedSourceRealtime();
  scheduleNormalize();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initAccountingPricingV2, { once: true });
} else {
  initAccountingPricingV2();
}
