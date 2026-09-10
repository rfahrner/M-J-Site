/* ================================================================
   Board-side rate engine.

   Rate priority is deliberately explicit:
   1. A dispatcher-entered manual total in the board Rate cell is handled
      by loadboard.js and wins over everything here.
   2. Otherwise, the working rate card for the load's LOCATION + DATE is
      the permanent base card with any date-scoped overrides substituted.
   3. A driver's negotiated rate is a floor: if it pays more than today's
      location rate, the driver rate wins; if today's rate pays more, the
      higher daily rate wins.
   4. If there is no daily override, the permanent location base applies.

   Permanent base tables:
   - board_rate_tiers: mileage bands (Atlanta)
   - board_rate_settings: flat/per-mile/stop/hourly values by location

   Date-scoped table:
   - board_rate_daily_overrides: location + date + tier/setting + value

   Legacy per-load rate_overrides JSON is intentionally no longer part of
   the calculation hierarchy. A one-load exception should be entered in
   the visible Rate cell, which sets rate_manual and is unambiguous.
   ================================================================ */
import { supabaseClient, findDriver } from './loadboard.js';

export const BOARD_RATE_TIERS_TABLE = "board_rate_tiers";
export const BOARD_RATE_SETTINGS_TABLE = "board_rate_settings";
export const BOARD_RATE_DAILY_TABLE = "board_rate_daily_overrides";

let cachedTiers = null;       // { atlanta: [{id,min,max,rate}, ...] }
let cachedSettings = null;    // { location: {key:value} }
let cachedDaily = null;       // { location: { YYYY-MM-DD: {tiers:{}, settings:{}} } }

function ensureDailyBucket(location, rateDate) {
  if (!cachedDaily) cachedDaily = {};
  if (!cachedDaily[location]) cachedDaily[location] = {};
  if (!cachedDaily[location][rateDate]) cachedDaily[location][rateDate] = { tiers: {}, settings: {} };
  return cachedDaily[location][rateDate];
}

export async function loadBoardRateData() {
  if (!supabaseClient) return;
  const [tierResult, settingResult, dailyResult] = await Promise.all([
    supabaseClient.from(BOARD_RATE_TIERS_TABLE).select("*"),
    supabaseClient.from(BOARD_RATE_SETTINGS_TABLE).select("*"),
    supabaseClient.from(BOARD_RATE_DAILY_TABLE).select("*"),
  ]);

  if (tierResult.error) { console.error("Failed to load board_rate_tiers:", tierResult.error); return; }
  if (settingResult.error) { console.error("Failed to load board_rate_settings:", settingResult.error); return; }
  if (dailyResult.error) { console.error("Failed to load board_rate_daily_overrides:", dailyResult.error); return; }

  cachedTiers = {};
  (tierResult.data || []).forEach((r) => {
    (cachedTiers[r.location] = cachedTiers[r.location] || []).push(
      { id: r.id, min: Number(r.min_miles), max: Number(r.max_miles), rate: Number(r.rate) }
    );
  });
  Object.values(cachedTiers).forEach((list) => list.sort((a, b) => a.min - b.min));

  cachedSettings = {};
  (settingResult.data || []).forEach((r) => {
    (cachedSettings[r.location] = cachedSettings[r.location] || {})[r.key] = Number(r.value);
  });

  cachedDaily = {};
  (dailyResult.data || []).forEach((r) => {
    const bucket = ensureDailyBucket(r.location, r.rate_date);
    if (r.kind === "tier") bucket.tiers[String(r.rate_key)] = Number(r.value);
    else bucket.settings[r.rate_key] = Number(r.value);
  });
}

export function getBoardRateTiers() { return cachedTiers; }
export function getBoardRateSettings() { return cachedSettings; }
export function getDailyRateOverrides() { return cachedDaily; }

export function getDailyRateCard(location, rateDate) {
  return cachedDaily?.[location]?.[rateDate] || { tiers: {}, settings: {} };
}

export function getBaseSetting(location, key, fallback = 0) {
  const settings = cachedSettings?.[location] || {};
  return settings[key] != null ? Number(settings[key]) : Number(fallback);
}

export function getDailyTierValue(location, rateDate, tier) {
  const value = getDailyRateCard(location, rateDate).tiers[String(tier.id)];
  return value != null ? Number(value) : Number(tier.rate);
}

export function getDailySettingValue(location, rateDate, key, fallback = 0) {
  const daily = getDailyRateCard(location, rateDate).settings[key];
  return daily != null ? Number(daily) : getBaseSetting(location, key, fallback);
}

export async function saveTierRate(tierId, newRate) {
  if (!supabaseClient) return false;
  const value = Number(newRate);
  if (!Number.isFinite(value) || value < 0) return false;
  const { error } = await supabaseClient.from(BOARD_RATE_TIERS_TABLE).update({ rate: value }).eq("id", tierId);
  if (error) { console.error("Failed to save tier rate:", error); return false; }
  if (cachedTiers) {
    for (const loc in cachedTiers) {
      const tier = cachedTiers[loc].find((x) => String(x.id) === String(tierId));
      if (tier) tier.rate = value;
    }
  }
  return true;
}

export async function saveSetting(location, key, newValue) {
  if (!supabaseClient) return false;
  const value = Number(newValue);
  if (!Number.isFinite(value) || value < 0) return false;
  const { data: existing, error: selErr } = await supabaseClient
    .from(BOARD_RATE_SETTINGS_TABLE).select("id").eq("location", location).eq("key", key);
  if (selErr) { console.error("Failed to look up rate setting:", selErr); return false; }
  let error;
  if (existing?.length) {
    ({ error } = await supabaseClient.from(BOARD_RATE_SETTINGS_TABLE).update({ value }).eq("id", existing[0].id));
  } else {
    ({ error } = await supabaseClient.from(BOARD_RATE_SETTINGS_TABLE).insert({ location, key, value }));
  }
  if (error) { console.error("Failed to save rate setting:", error); return false; }
  if (!cachedSettings) cachedSettings = {};
  (cachedSettings[location] = cachedSettings[location] || {})[key] = value;
  return true;
}

async function saveDailyValue(location, rateDate, kind, rateKey, rawValue) {
  if (!supabaseClient || !location || !rateDate || !rateKey) return false;
  const bucket = ensureDailyBucket(location, rateDate);
  const target = kind === "tier" ? bucket.tiers : bucket.settings;
  const key = String(rateKey);

  if (rawValue === null || rawValue === undefined || String(rawValue).trim() === "") {
    const { error } = await supabaseClient.from(BOARD_RATE_DAILY_TABLE)
      .delete()
      .eq("location", location)
      .eq("rate_date", rateDate)
      .eq("kind", kind)
      .eq("rate_key", key);
    if (error) { console.error("Failed to clear daily rate override:", error); return false; }
    delete target[key];
    return true;
  }

  const value = Number(rawValue);
  if (!Number.isFinite(value) || value < 0) return false;
  const { error } = await supabaseClient.from(BOARD_RATE_DAILY_TABLE).upsert({
    location,
    rate_date: rateDate,
    kind,
    rate_key: key,
    value,
    updated_at: new Date().toISOString(),
  }, { onConflict: "location,rate_date,kind,rate_key" });
  if (error) { console.error("Failed to save daily rate override:", error); return false; }
  target[key] = value;
  return true;
}

export function saveDailyTierRate(location, rateDate, tierId, value) {
  return saveDailyValue(location, rateDate, "tier", String(tierId), value);
}

export function saveDailySetting(location, rateDate, key, value) {
  return saveDailyValue(location, rateDate, "setting", key, value);
}

function rowDate(row) {
  return row?.shiftDate || row?.shift_date || "";
}

function driverOverridesFor(row) {
  if (!row?.driverId) return null;
  const drv = findDriver(row.driverId);
  return drv?.atlantaRateOverrides || null;
}

function dailyTierForRow(row, tier) {
  const location = row?.location || "atlanta";
  return getDailyTierValue(location, rowDate(row), tier);
}

function dailySettingForRow(row, locationKey, key, fallback) {
  return getDailySettingValue(locationKey, rowDate(row), key, fallback);
}

// Driver negotiated terms are a floor. For dollar values, higher wins.
// `stop_charge_free_stops` is the one inverted setting: fewer free stops
// means the driver is paid extra-stop money sooner, so the lower threshold
// is the more favorable negotiated term.
const LOWER_IS_MORE_FAVORABLE = new Set(["stop_charge_free_stops"]);

export function effectiveTierRate(row, tier) {
  const dailyOrBase = dailyTierForRow(row, tier);
  const driverOv = driverOverridesFor(row);
  const driverValue = driverOv?.tiers?.[tier.id] ?? driverOv?.tiers?.[String(tier.id)];
  if (driverValue == null) return dailyOrBase;
  return Math.max(Number(dailyOrBase), Number(driverValue));
}

export function effectiveSetting(row, locationKey, key, fallback) {
  const dailyOrBase = dailySettingForRow(row, locationKey, key, fallback);
  if (locationKey !== "atlanta") return dailyOrBase;
  const driverOv = driverOverridesFor(row);
  const driverValue = driverOv?.settings?.[key];
  if (driverValue == null) return dailyOrBase;
  return LOWER_IS_MORE_FAVORABLE.has(key)
    ? Math.min(Number(dailyOrBase), Number(driverValue))
    : Math.max(Number(dailyOrBase), Number(driverValue));
}

export function isDailyTierOverridden(row, tierId) {
  const location = row?.location || "atlanta";
  const date = rowDate(row);
  return getDailyRateCard(location, date).tiers[String(tierId)] != null;
}

export function isDailySettingOverridden(row, key) {
  const location = row?.location || "atlanta";
  const date = rowDate(row);
  return getDailyRateCard(location, date).settings[key] != null;
}

export function isDriverTierOverridden(row, tierId) {
  const driverOv = driverOverridesFor(row);
  return !!(driverOv?.tiers && (driverOv.tiers[tierId] != null || driverOv.tiers[String(tierId)] != null));
}

export function isDriverSettingOverridden(row, key) {
  const driverOv = driverOverridesFor(row);
  return !!(driverOv?.settings && driverOv.settings[key] != null);
}

// Kept under the old export names because loadboard.js already uses them
// for the dot indicator. They now mean "this date has an override" rather
// than the retired per-load JSON override layer.
export function isTierOverridden(row, tierId) { return isDailyTierOverridden(row, tierId); }
export function isSettingOverridden(row, key) { return isDailySettingOverridden(row, key); }

function withDriverFlatFloor(row, breakdown) {
  const drv = row?.driverId ? findDriver(row.driverId) : null;
  const raw = drv?.normalRate;
  if (raw === "" || raw == null) return breakdown;
  const negotiated = Number(raw);
  if (!Number.isFinite(negotiated) || negotiated <= breakdown.total) return breakdown;
  return {
    total: negotiated,
    mode: "driver-usual-rate",
    lines: [
      ...breakdown.lines,
      { label: "Driver negotiated minimum", detail: `${drv.name || "Driver"} — higher than today's calculated location rate`, amount: negotiated },
    ],
    note: "Driver negotiated rate is higher than today's location calculation, so the driver rate wins.",
    locationCalculatedTotal: breakdown.total,
  };
}

// Calculates the non-manual rate. The helpers above already apply the
// permanent-base -> daily-date -> driver-negotiated hierarchy at each rate
// component. A driver's single flat normalRate is compared against the
// completed calculation as a final pay floor.
export function calcLoadRateBreakdown(locationKey, row) {
  const tiers = (cachedTiers?.[locationKey]) || [];
  let breakdown;

  if (locationKey === "atlanta" || locationKey === "delaware") {
    const realTrips = (row.trips || []).filter((t) => String(t.routeId || "").trim() || String(t.tripId || "").trim());

    if (locationKey === "atlanta" && row.tonu) {
      const flat = effectiveSetting(row, locationKey, "tonu_flat", 150);
      breakdown = { total: flat, mode: "tonu", lines: [{ label: "TONU", detail: "Flat TONU rate", amount: flat }], note: null };
      return withDriverFlatFloor(row, breakdown);
    }

    if (!realTrips.length) {
      breakdown = { total: 0, mode: locationKey === "atlanta" ? "mileage-tiers" : "flat-per-route", lines: [], note: "No routes entered yet." };
      return withDriverFlatFloor(row, breakdown);
    }

    let total = 0;
    const lines = [];
    realTrips.forEach((t, i) => {
      const miles = parseFloat(t.routeMiles);
      const label = t.routeId || t.tripId || `Route ${i + 1}`;
      if (!Number.isFinite(miles) || miles <= 0) {
        lines.push({ label, detail: "Miles not entered yet", amount: 0 });
        return;
      }

      if (locationKey === "delaware") {
        const minFlat = effectiveSetting(row, locationKey, "flat_minimum", 1000);
        const perMile = effectiveSetting(row, locationKey, "per_mile", 4);
        const calc = Math.max(minFlat, miles * perMile);
        const rounded = Math.round(calc * 100) / 100;
        lines.push({ label, detail: `${miles} mi — greater of $${minFlat} flat or $${perMile}/mi`, amount: rounded });
        total += calc;
        return;
      }

      const tier = tiers.find((tr) => miles >= tr.min && miles <= tr.max);
      let routeRate;
      let tierLabel;
      if (tier) {
        routeRate = effectiveTierRate(row, tier);
        tierLabel = `${tier.min}-${tier.max}mi tier`;
      } else {
        const perMile = effectiveSetting(row, locationKey, "over_tier_per_mile", 2.4);
        routeRate = miles * perMile;
        tierLabel = `over tier, $${perMile}/mi`;
      }
      const stops = parseInt(t.stopCount, 10) || 0;
      const freeStops = effectiveSetting(row, locationKey, "stop_charge_free_stops", 2);
      const perStop = effectiveSetting(row, locationKey, "stop_charge_per_stop", 20);
      const stopCharge = stops > freeStops ? (stops - freeStops) * perStop : 0;
      const routeTotal = routeRate + stopCharge;
      const stopNote = stopCharge
        ? ` + ${stops} stops (${stops - freeStops} over ${freeStops} free × $${perStop})`
        : (stops ? ` + ${stops} stops (within ${freeStops} free)` : "");
      lines.push({ label, detail: `${miles} mi (${tierLabel})${stopNote}`, amount: Math.round(routeTotal * 100) / 100 });
      total += routeTotal;
    });
    breakdown = {
      total: Math.round(total * 100) / 100,
      mode: locationKey === "atlanta" ? "mileage-tiers" : "flat-per-route",
      lines,
      note: null,
    };
    return withDriverFlatFloor(row, breakdown);
  }

  if (locationKey === "buildingc") {
    const routeType = row.routeType || "birm";
    if (routeType === "birm") {
      const flat = effectiveSetting(row, locationKey, "birm_flat", 800);
      breakdown = { total: flat, mode: "birm", lines: [{ label: "BIRM", detail: "Flat BIRM rate", amount: flat }], note: null };
      return withDriverFlatFloor(row, breakdown);
    }
    if (routeType === "hostler") {
      const hourly = effectiveSetting(row, locationKey, "hostler_hourly", 100);
      const hours = parseFloat(row.hostlerHours);
      if (!Number.isFinite(hours) || hours <= 0) {
        breakdown = { total: 0, mode: "hostler", lines: [], note: "Enter the shift length to calculate the Hostler rate." };
        return withDriverFlatFloor(row, breakdown);
      }
      const total = Math.round(hours * hourly * 100) / 100;
      breakdown = { total, mode: "hostler", lines: [{ label: "Hostler", detail: `${hours} hrs × $${hourly}/hr`, amount: total }], note: null };
      return withDriverFlatFloor(row, breakdown);
    }
    breakdown = { total: 0, mode: "na", lines: [], note: "Marked N/A — no automatic rate for this route type." };
    return withDriverFlatFloor(row, breakdown);
  }

  // Houston (and any future flat-rate location using this engine).
  const flat = effectiveSetting(row, locationKey, "flat_rate", 0);
  breakdown = { total: flat, mode: "flat", lines: [{ label: "Location flat rate", detail: "", amount: flat }], note: null };
  return withDriverFlatFloor(row, breakdown);
}
