/* ================================================================
     Accounting calculation engine — ported from a Python reference
     implementation validated against 6 real rows from the actual
     accounting workbook (every field matched exactly). Pricing tiers
     and settings are fetched live from Supabase so they stay editable
     without a code change.
     ================================================================ */
import './role-auth-compat.js';
import './storage-compat.js';
import { supabaseClient, SHIFTS_TABLE } from './loadboard.js';

  export const ACCOUNTING_TABLE = "loads_accounting";
  export const ACCOUNTING_ROUTES_TABLE = "loads_accounting_routes";
  let pricingTiers = null;   // { cost_1: [{min,max,rate}...], revenue_2: [...], ... }
  let pricingSettings = null; // { fsc_rate: 5.06, cost_1_per_mile: 2.4, ... }

  export async function loadPricingData() {
    if (!supabaseClient) return;
    const [{ data: tiers, error: tErr }, { data: settings, error: sErr }] = await Promise.all([
      supabaseClient.from("pricing_tiers").select("*"),
      supabaseClient.from("pricing_settings").select("*"),
    ]);
    if (tErr) { console.error("Failed to load pricing_tiers:", tErr); return; }
    if (sErr) { console.error("Failed to load pricing_settings:", sErr); return; }
    pricingTiers = {};
    (tiers || []).forEach((t) => {
      (pricingTiers[t.table_name] = pricingTiers[t.table_name] || []).push(
        { min: Number(t.min_miles), max: Number(t.max_miles), rate: Number(t.rate) }
      );
    });
    pricingSettings = {};
    (settings || []).forEach((s) => { pricingSettings[s.key] = Number(s.value); });
  }
  export function getPricingTiers() { return pricingTiers; }
  export function getPricingSettings() { return pricingSettings; }

  export function tierLookup(tableRows, miles) {
    if (!tableRows) return null;
    const hit = tableRows.find((t) => miles >= t.min && miles <= t.max);
    return hit ? hit.rate : null;
  }

  // Pure function — same logic as the validated Python reference. Takes
  // pricing data as an argument (rather than reading module state) so it
  // stays independently testable.
  export function calcRoute({ costLevel, revenueLevel, miles, stops, contractRate }, tiers, settings) {
    const costTable = tiers[`cost_${costLevel}`];
    const costPerMile = settings[`cost_${costLevel}_per_mile`] || 0;
    let linehaulCost = tierLookup(costTable, miles);
    if (linehaulCost === null) linehaulCost = miles * costPerMile;

    const freeStops = settings.stop_charge_free_stops || 0;
    const stopChargeRate = settings.stop_charge_per_stop || 0;
    const stopChargeRevRate = settings.stop_charge_revenue_per_stop || 0;
    const stopCharge = stops > freeStops ? (stops - freeStops) * stopChargeRate : 0;
    const stopChargeRevenue = stops * stopChargeRevRate;
    const totalCost = linehaulCost + stopCharge;

    let revenue;
    if (revenueLevel === 4) {
      revenue = (contractRate || 0) / (settings.market_revenue_divisor || 1);
    } else {
      const revTable = tiers[`revenue_${revenueLevel}`];
      const revPerMile = settings[`revenue_${revenueLevel}_per_mile`] || 0;
      revenue = tierLookup(revTable, miles);
      if (revenue === null) revenue = revPerMile ? miles * revPerMile : 0;
    }
    const totalRevenue = revenue + stopChargeRevenue;

    const round2 = (n) => Math.round(n * 100) / 100;
    return {
      linehaulCost: round2(linehaulCost), stopCharge: round2(stopCharge),
      stopChargeRevenue: round2(stopChargeRevenue), totalCost: round2(totalCost),
      revenue: round2(revenue), totalRevenue: round2(totalRevenue),
    };
  }

  export function calcFscPayment(fscRate, totalMiles, settings) {
    const mult = settings.fsc_multiplier || 0;
    return Math.round(fscRate * mult * totalMiles * 100) / 100;
  }

  /*
   * Accounting submission is server-owned now.
   *
   * Dispatchers used to write loads_accounting / loads_accounting_routes
   * directly from the browser. That made a clean accounting role boundary
   * impossible because the dispatcher browser itself needed Accounting CRUD.
   * Supabase now processes qualifying shifts with database triggers plus the
   * existing five-minute cron safety net. The browser only confirms whether
   * that server-side process has marked the shift sent.
   *
   * loadboard.js already calls this after a qualifying completion event and
   * only sets its local sentToAccounting flag when this resolves. If the
   * server has not processed the shift yet (most relevant to the 12-hour cron
   * path), throw so the board leaves the local flag false and retries later.
   */
  export async function sendShiftToAccounting(row) {
    if (!supabaseClient || !row || !row.dbId) return;

    const { data, error } = await supabaseClient
      .from(SHIFTS_TABLE)
      .select("sent_to_accounting")
      .eq("id", row.dbId)
      .limit(1);

    if (error) throw error;
    if (!data || !data[0] || !data[0].sent_to_accounting) {
      throw new Error("Accounting sync is pending server processing.");
    }
  }