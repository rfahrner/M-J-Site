/* ================================================================
     Accounting calculation engine — ported from a Python reference
     implementation validated against 6 real rows from the actual
     accounting workbook (every field matched exactly). Pricing tiers
     and settings are fetched live from Supabase so they stay editable
     without a code change.
     ================================================================ */

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

  export async function sendShiftToAccounting(row, locationKey, dKey) {
    if (!supabaseClient || !row.dbId) return;
    if (!pricingTiers || !pricingSettings) await loadPricingData();
    if (!pricingTiers || !pricingSettings) return; // pricing data unavailable — don't guess, skip silently (logged below)

    const drv = row.driverId ? findDriver(row.driverId) : null;
    const routes = row.trips
      .map((t, i) => ({ trip: t, num: i + 1 }))
      .filter(({ trip }) => trip.routeId && String(trip.routeId).trim());

    const costLevel = 1, revenueLevel = 1; // sensible default — editable afterward on the Accounting page
    let totalCost = 0, totalRevenue = 0, totalMiles = 0, totalStops = 0;
    const routeRecords = routes.map(({ trip, num }) => {
      const miles = Number(trip.routeMiles) || 0;
      const stops = Number(trip.stopCount) || 0;
      const calc = calcRoute({ costLevel, revenueLevel, miles, stops, contractRate: null }, pricingTiers, pricingSettings);
      totalCost += calc.totalCost; totalRevenue += calc.totalRevenue; totalMiles += miles; totalStops += stops;
      return {
        route_number: num, route_id: trip.routeId || null, trip_id: trip.tripId || null, trailer: trip.trailerOut || null,
        miles, stops, linehaul_cost: calc.linehaulCost, stop_charge: calc.stopCharge, total_cost: calc.totalCost,
        revenue: calc.revenue, stop_charge_revenue: calc.stopChargeRevenue, total_revenue: calc.totalRevenue,
      };
    });
    const fscRate = pricingSettings.fsc_rate || 0;
    const fscPayment = calcFscPayment(fscRate, totalMiles, pricingSettings);

    // Delaware doesn't use the tiered Kroger-style cost lookup — every Delaware
    // load pays $1000 flat or $4/mile, whichever is greater. Assumption: this
    // applies to what we PAY (carrier pay / cost), not the revenue side —
    // easy to adjust if that's wrong.
    if (locationKey === "delaware" && totalMiles > 0) {
      totalCost = Math.max(1000, totalMiles * 4);
    }

    const accountingRow = {
      source_shift_id: row.dbId, location: locationKey, shift_date: dKey,
      aljex_load_number: row.proNumber || null,
      mc_dot: drv ? (drv.mc || null) : null,
      driver_id: row.driverId ? Number(row.driverId) : null,
      driver_name_text: drv ? drv.name : (row.driverNameText || null),
      driver_cell: drv ? (drv.phone || null) : null,
      carrier_email: drv ? (drv.email || null) : null,
      cost_level: costLevel, revenue_level: revenueLevel,
      total_carrier_pay: totalCost, // starting suggestion — editable afterward
      fsc_rate_snapshot: fscRate, fsc_payment: fscPayment,
      total_cost: Math.round(totalCost * 100) / 100, total_revenue: Math.round(totalRevenue * 100) / 100,
      total_miles: totalMiles, total_stops: totalStops,
    };

    try {
      const { data: existing } = await supabaseClient.from(ACCOUNTING_TABLE).select("id").eq("source_shift_id", row.dbId);
      let accountingId;
      if (existing && existing.length) {
        accountingId = existing[0].id;
        await supabaseClient.from(ACCOUNTING_TABLE).update(accountingRow).eq("id", accountingId);
        await supabaseClient.from(ACCOUNTING_ROUTES_TABLE).delete().eq("accounting_id", accountingId);
      } else {
        const { data: inserted, error } = await supabaseClient.from(ACCOUNTING_TABLE).insert(accountingRow).select();
        if (error) throw error;
        accountingId = inserted[0].id;
      }
      if (routeRecords.length) {
        await supabaseClient.from(ACCOUNTING_ROUTES_TABLE).insert(routeRecords.map((r) => ({ ...r, accounting_id: accountingId })));
      }
      await supabaseClient.from(SHIFTS_TABLE).update({ sent_to_accounting: true }).eq("id", row.dbId);
    } catch (e) {
      console.error("sendShiftToAccounting failed:", e);
      
      setDriverSyncStatus(`Marked complete, but couldn't send to Accounting (${e.message || e}).`, "error");
    }
  }