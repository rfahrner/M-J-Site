/* ================================================================
   Board-side rate engine — drives the board's own "Rate" column and
   the new Rate section in the Load Details modal. Deliberately kept
   separate from accountingcalc.js's pricing_tiers/pricing_settings,
   which power the Accounting page's Cost/Revenue Level math — that's
   a different downstream calculation with its own tiers, and Building
   C's BIRM/Hostler rules don't fit a mileage-tier shape at all, so
   forcing everything through one engine would have made both harder
   to reason about.

   Data shape:
   - board_rate_tiers: mileage bands, Atlanta only right now (min_miles,
     max_miles, rate). Miles beyond the top tier fall through to the
     per-mile setting below.
   - board_rate_settings: flat numbers per location (per-mile rates,
     stop charges, TONU flat, BIRM flat, Hostler hourly, Houston flat).
   ================================================================ */
import { supabaseClient } from './loadboard.js';

export const BOARD_RATE_TIERS_TABLE = "board_rate_tiers";
export const BOARD_RATE_SETTINGS_TABLE = "board_rate_settings";

let cachedTiers = null;    // { atlanta: [{id, min, max, rate}, ...], ... }
let cachedSettings = null; // { atlanta: {key: value, ...}, houston: {...}, ... }

export async function loadBoardRateData() {
  if (!supabaseClient) return;
  const [{ data: tierRows, error: tErr }, { data: settingRows, error: sErr }] = await Promise.all([
    supabaseClient.from(BOARD_RATE_TIERS_TABLE).select("*"),
    supabaseClient.from(BOARD_RATE_SETTINGS_TABLE).select("*"),
  ]);
  if (tErr) { console.error("Failed to load board_rate_tiers:", tErr); return; }
  if (sErr) { console.error("Failed to load board_rate_settings:", sErr); return; }

  cachedTiers = {};
  (tierRows || []).forEach((r) => {
    (cachedTiers[r.location] = cachedTiers[r.location] || []).push(
      { id: r.id, min: Number(r.min_miles), max: Number(r.max_miles), rate: Number(r.rate) }
    );
  });
  Object.values(cachedTiers).forEach((list) => list.sort((a, b) => a.min - b.min));

  cachedSettings = {};
  (settingRows || []).forEach((r) => {
    (cachedSettings[r.location] = cachedSettings[r.location] || {})[r.key] = Number(r.value);
  });
}

export function getBoardRateTiers() { return cachedTiers; }
export function getBoardRateSettings() { return cachedSettings; }

export async function saveTierRate(tierId, newRate) {
  if (!supabaseClient) return false;
  const { error } = await supabaseClient.from(BOARD_RATE_TIERS_TABLE).update({ rate: newRate }).eq("id", tierId);
  if (error) { console.error("Failed to save tier rate:", error); return false; }
  if (cachedTiers) {
    for (const loc in cachedTiers) {
      const t = cachedTiers[loc].find((x) => x.id === tierId);
      if (t) t.rate = newRate;
    }
  }
  return true;
}

// Upserts by (location, key) since a brand-new location/key pair (or a
// fresh Supabase project that hasn't been seeded yet) may not have a row.
export async function saveSetting(location, key, newValue) {
  if (!supabaseClient) return false;
  const { data: existing, error: selErr } = await supabaseClient
    .from(BOARD_RATE_SETTINGS_TABLE).select("id").eq("location", location).eq("key", key);
  if (selErr) { console.error("Failed to look up rate setting:", selErr); return false; }
  let error;
  if (existing && existing.length) {
    ({ error } = await supabaseClient.from(BOARD_RATE_SETTINGS_TABLE).update({ value: newValue }).eq("id", existing[0].id));
  } else {
    ({ error } = await supabaseClient.from(BOARD_RATE_SETTINGS_TABLE).insert({ location, key, value: newValue }));
  }
  if (error) { console.error("Failed to save rate setting:", error); return false; }
  if (!cachedSettings) cachedSettings = {};
  (cachedSettings[location] = cachedSettings[location] || {})[key] = newValue;
  return true;
}

// Hostler hours = Shift Complete timestamp minus Shift Start time-of-day,
// both anchored to the shift's own date. Returns null (not zero) until the
// shift is actually marked complete — there's no honest hours number before
// then, and showing 0 would look like a real (and wrong) answer.
export function computeHoursWorked(row) {
  if (!row.shiftComplete || !row.shiftCompleteAt || !row.shiftStart) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(row.shiftStart).trim());
  if (!m) return null;
  const base = row.shiftDate ? new Date(row.shiftDate + "T00:00:00") : new Date(row.shiftCompleteAt);
  const start = new Date(base);
  start.setHours(Number(m[1]), Number(m[2]), 0, 0);
  const end = new Date(row.shiftCompleteAt);
  let diffMs = end.getTime() - start.getTime();
  if (diffMs < 0) diffMs += 24 * 60 * 60 * 1000; // shift crossed midnight
  return Math.round((diffMs / (1000 * 60 * 60)) * 100) / 100;
}

// A load's own rate_overrides (row.rateOverrides = {tiers:{id:rate}, settings:{key:value}})
// always win over the shared board_rate_tiers/board_rate_settings default —
// these two helpers are the single place that "which number actually
// applies to this load" gets decided, so every other spot in this file
// only has to call them instead of re-deriving that logic.
export function effectiveTierRate(row, tier) {
  const override = row && row.rateOverrides && row.rateOverrides.tiers ? row.rateOverrides.tiers[tier.id] : undefined;
  return override != null ? override : tier.rate;
}
export function effectiveSetting(row, locationKey, key, fallback) {
  const override = row && row.rateOverrides && row.rateOverrides.settings ? row.rateOverrides.settings[key] : undefined;
  if (override != null) return override;
  const settings = (cachedSettings && cachedSettings[locationKey]) || {};
  return settings[key] != null ? settings[key] : fallback;
}
export function isTierOverridden(row, tierId) {
  return !!(row && row.rateOverrides && row.rateOverrides.tiers && row.rateOverrides.tiers[tierId] != null);
}
export function isSettingOverridden(row, key) {
  return !!(row && row.rateOverrides && row.rateOverrides.settings && row.rateOverrides.settings[key] != null);
}

// The one function loadboard.js actually calls to both compute a rate AND
// explain how it got there. Always returns the same shape regardless of
// location, so the modal only needs one generic renderer for the "lines".
//   { total, mode, lines: [{label, detail, amount}], note }
export function calcLoadRateBreakdown(locationKey, row) {
  const tiers = (cachedTiers && cachedTiers[locationKey]) || [];

  if (locationKey === "atlanta" || locationKey === "delaware") {
    const realTrips = (row.trips || []).filter((t) => String(t.routeId || "").trim() || String(t.tripId || "").trim());

    if (locationKey === "atlanta" && row.tonu) {
      const flat = effectiveSetting(row, locationKey, "tonu_flat", 150);
      return { total: flat, mode: "tonu", lines: [{ label: "TONU", detail: "Flat TONU rate", amount: flat }], note: null };
    }

    if (!realTrips.length) {
      return { total: 0, mode: locationKey === "atlanta" ? "mileage-tiers" : "flat-per-route", lines: [], note: "No routes entered yet." };
    }

    let total = 0;
    const lines = [];
    realTrips.forEach((t, i) => {
      const miles = parseFloat(t.routeMiles);
      const label = t.routeId || t.tripId || `Route ${i + 1}`;
      if (isNaN(miles) || miles <= 0) {
        lines.push({ label, detail: "Miles not entered yet", amount: 0 });
        return;
      }
      if (locationKey === "delaware") {
        const minFlat = effectiveSetting(row, locationKey, "flat_minimum", 1000);
        const perMile = effectiveSetting(row, locationKey, "per_mile", 4);
        const calc = Math.max(minFlat, miles * perMile);
        lines.push({ label, detail: `${miles} mi — greater of $${minFlat} flat or $${perMile}/mi`, amount: Math.round(calc * 100) / 100 });
        total += calc;
        return;
      }
      // atlanta
      const tier = tiers.find((tr) => miles >= tr.min && miles <= tr.max);
      let routeRate, tierLabel;
      if (tier) { routeRate = effectiveTierRate(row, tier); tierLabel = `${tier.min}-${tier.max}mi tier`; }
      else {
        const perMile = effectiveSetting(row, locationKey, "over_tier_per_mile", 2.4);
        routeRate = miles * perMile;
        tierLabel = `over tier, $${perMile}/mi`;
      }
      const stops = parseInt(t.stopCount, 10) || 0;
      const freeStops = effectiveSetting(row, locationKey, "stop_charge_free_stops", 2);
      const perStop = effectiveSetting(row, locationKey, "stop_charge_per_stop", 20);
      const stopCharge = stops > freeStops ? (stops - freeStops) * perStop : 0;
      const routeTotal = routeRate + stopCharge;
      const stopNote = stopCharge ? ` + ${stops} stops (${stops - freeStops} over ${freeStops} free × $${perStop})` : (stops ? ` + ${stops} stops (within ${freeStops} free)` : "");
      lines.push({ label, detail: `${miles} mi (${tierLabel})${stopNote}`, amount: Math.round(routeTotal * 100) / 100 });
      total += routeTotal;
    });
    return { total: Math.round(total * 100) / 100, mode: locationKey === "atlanta" ? "mileage-tiers" : "flat-per-route", lines, note: null };
  }

  if (locationKey === "buildingc") {
    if (row.birm) {
      const flat = effectiveSetting(row, locationKey, "birm_flat", 800);
      return { total: flat, mode: "birm", lines: [{ label: "BIRM", detail: "Flat BIRM rate", amount: flat }], note: null };
    }
    const hourly = effectiveSetting(row, locationKey, "hostler_hourly", 100);
    const hours = computeHoursWorked(row);
    if (hours == null) {
      return { total: 0, mode: "hostler", lines: [], note: "Shift not complete yet — Hostler hours aren't known until Shift Complete is marked." };
    }
    const total = Math.round(hours * hourly * 100) / 100;
    return { total, mode: "hostler", lines: [{ label: "Hostler", detail: `${hours} hrs × $${hourly}/hr`, amount: total }], note: null };
  }

  // houston (and anywhere else) — flat, no per-route breakdown to show
  const flat = effectiveSetting(row, locationKey, "flat_rate", 0);
  return { total: flat, mode: "flat", lines: [{ label: "Flat rate", detail: "", amount: flat }], note: null };
}