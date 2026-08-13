/* ---------------- Accounting page ---------------- */
import {
  supabaseClient, TRIPS_TABLE, escapeHtml, $, $all, on, setDriverSyncStatus,
  state, dateKey, addDays, todayDate, keyToDate, openDateDropdown, closeDateDropdown,
  SAVE_DEBOUNCE_MS, closeLoadDetailsModal, loadDetailsState, renderLoadDetailsTabs,
  uploadTripSheetImages, removeTripSheetImage, startLoadDetailsEdit, cancelLoadDetailsEdit,
  saveLoadDetailsEdit, stopFieldsHtml, openLoadDetailsFromAccounting,
  commitRateOverride, resetRateToCalculated, changeRouteType, setHostlerHours, commitRateBoxOverride, openEditDriverModal,
  loadLocationNotes, openLocationNotesModal, closeLocationNotesModal, saveLocationNotes,
  showDriverAssignmentWarning, SHIFTS_TABLE,
} from './loadboard.js';
import { ACCOUNTING_TABLE, ACCOUNTING_ROUTES_TABLE, loadPricingData, calcRoute, getPricingTiers, getPricingSettings } from './accountingcalc.js';
let accountingRecords = [];
  // Date descending (most recent first), then status within the same date
  // — active loads before released ones, since those are the ones more
  // likely to still need attention.
  function acctSortCompare(a, b) {
    if (a.shift_date !== b.shift_date) return a.shift_date < b.shift_date ? 1 : -1;
    if (a.status !== b.status) return a.status === "active" ? -1 : 1;
    return 0;
  }
  let acctTripsByShiftId = {}; // source_shift_id -> [trips], used for the Delaware "Routes" column
  // source_shift_id -> boolean, whether the underlying board shift is
  // actually marked complete. Populated for every location (not just
  // Delaware) since this drives the "shift not marked complete" warning
  // on the PRO#/Aljex# link — a load can now reach Accounting via the
  // 12-hour or time-sheet-filled-in triggers without ever being marked
  // complete, and this is how that gets flagged when someone opens it.
  let acctShiftCompleteById = {};
  // accounting_id -> [route rows from loads_accounting_routes], sorted by
  // route_number. Powers both the new Atlanta "Routes" column and the
  // per-route Total Miles / Total Stops breakdown everywhere. There's no
  // real foreign key back to loads_trips here (route_id/trip_id are just
  // text snapshots taken when the shift was completed), so clicking a
  // route chip has to match by that text — see openLoadDetailsFromAccounting.
  let acctRoutesByAccountingId = {};
  // loadboard.js's openLoadDetailsFromAccounting() needs to look up a
  // record from this module-private array — this is the sanctioned way
  // in, rather than exporting the array itself.
  export function getAccountingRecordById(id) {
    return accountingRecords.find((r) => r.id == id) || null;
  }
  // Fetches accounting records (plus their linked Delaware trips and
  // route rows) for a given shift_date range and merges them into
  // accountingRecords — used for both the initial bounded load and for
  // pulling in an earlier window on demand (see loadOlderAccountingRecords).
  // Every fetch stays scoped to a bounded range instead of ever pulling
  // the whole table's history in one shot: unscoped, this table will
  // eventually cross Supabase/PostgREST's 1000-row-per-query cap and
  // start silently dropping older rows with no error at all (the same
  // failure mode we already hit once with the drivers table), on top of
  // just getting slower to load and render as years of history pile up.
  async function loadAccountingRecordsForRange(fromKey, toKey, replaceExisting) {
    const { data, error } = await supabaseClient.from(ACCOUNTING_TABLE).select("*").gte("shift_date", fromKey).lte("shift_date", toKey);
    if (error) { console.error("Failed to load accounting records:", error); setDriverSyncStatus(`Couldn't load Accounting (${error.message}).`, "error"); return; }
    const fresh = data || [];
    accountingRecords = (replaceExisting ? fresh : [...accountingRecords, ...fresh]).sort(acctSortCompare);

    const shiftIds = [...new Set(accountingRecords.filter((r) => r.location === "delaware" && r.source_shift_id).map((r) => r.source_shift_id))];
    if (shiftIds.length) {
      const { data: trips, error: tripsErr } = await supabaseClient.from(TRIPS_TABLE).select("*").in("shift_id", shiftIds);
      if (!tripsErr) {
        acctTripsByShiftId = {};
        (trips || []).forEach((t) => {
          if (!acctTripsByShiftId[t.shift_id]) acctTripsByShiftId[t.shift_id] = [];
          acctTripsByShiftId[t.shift_id].push(t);
        });
      }
    }
    const allShiftIds = [...new Set(accountingRecords.filter((r) => r.source_shift_id).map((r) => r.source_shift_id))];
    if (allShiftIds.length) {
      const { data: shiftRows, error: shiftErr } = await supabaseClient.from(SHIFTS_TABLE).select("id, shift_complete").in("id", allShiftIds);
      if (!shiftErr) {
        (shiftRows || []).forEach((s) => { acctShiftCompleteById[s.id] = !!s.shift_complete; });
      }
    }
    const accountingIds = accountingRecords.map((r) => r.id);
    if (accountingIds.length) {
      const { data: routes, error: routesErr } = await supabaseClient.from(ACCOUNTING_ROUTES_TABLE).select("*").in("accounting_id", accountingIds);
      if (routesErr) {
        console.error("Failed to load accounting routes:", routesErr);
      } else {
        acctRoutesByAccountingId = {};
        (routes || [])
          .sort((a, b) => (a.route_number || 0) - (b.route_number || 0))
          .forEach((r) => {
            (acctRoutesByAccountingId[r.accounting_id] = acctRoutesByAccountingId[r.accounting_id] || []).push(r);
          });
      }
    }
  }

  export async function loadAccountingRecords() {
    if (!supabaseClient) return;
    await loadAccountingRecordsForRange(state.minDate, state.maxDate, true);
  }

  const ACCT_WINDOW_DAYS = 60; // matches the calendar's existing default lookback

  // Pulls in the next 60-day window further back than what's currently
  // loaded, and extends state.minDate to match — so the calendar's date
  // picker also opens up to let you navigate into that older range.
  export async function loadOlderAccountingRecords() {
    const newMinDate = dateKey(addDays(keyToDate(state.minDate), -ACCT_WINDOW_DAYS));
    const rangeEnd = dateKey(addDays(keyToDate(state.minDate), -1));
    const btn = $("#btn-load-earlier");
    if (btn) { btn.disabled = true; btn.textContent = "Loading…"; }
    await loadAccountingRecordsForRange(newMinDate, rangeEnd, false);
    state.minDate = newMinDate;
    if (btn) { btn.disabled = false; btn.textContent = `Load Earlier Records (${ACCT_WINDOW_DAYS} more days)`; }
    renderAccountingTable();
    renderAcctDateChrome();
  }
 
  export function acctRoutesChipsHtml(rec) {
    const trips = rec.source_shift_id ? acctTripsByShiftId[rec.source_shift_id] : null;
    if (!trips || !trips.length) return `<span class="subtext" style="font-size:11px;">—</span>`;
    return trips.map((t, i) => {
      const label = t.route_id || t.trip_id || `Route ${i + 1}`;
      const cls = t.complete ? "trip-segment-done" : "";
      return `<button type="button" class="trip-chip ${cls}" data-open-acct-load="${rec.id}" data-open-acct-trip="${t.id}" title="Open this route's details">${escapeHtml(label)}</button>`;
    }).join(" ");
  }
  // Atlanta's own Routes column — sourced from loads_accounting_routes
  // rather than loads_trips (Delaware's source), since that's where each
  // route's Cost/Revenue Level calc actually lives. Same click-to-open
  // pattern, but has to match by route_id TEXT rather than a trip dbId —
  // see the note by acctRoutesByAccountingId above.
  export function acctRouteIdsHtml(rec) {
    const routes = acctRoutesByAccountingId[rec.id];
    if (!routes || !routes.length) return `<span class="subtext" style="font-size:11px;">—</span>`;
    return `<div style="display:flex; flex-direction:column; gap:2px; align-items:flex-start;">
      ${routes.map((r) => {
        const label = r.route_id || r.trip_id || "—";
        return `<button type="button" class="trip-chip" data-open-acct-load="${rec.id}" data-open-acct-route-text="${escapeHtml(r.route_id || "")}" title="Open this route's details">${escapeHtml(label)}</button>`;
      }).join("")}
    </div>`;
  }
  // Per-route Miles / Stops, stacked to line up visually with the Routes
  // column's own stacked chips (same array, same order). Falls back to
  // the old single aggregate number when there's no per-route data on
  // file for this load (older/unrecoverable rows, or a shift with zero
  // real routes).
  export function acctMilesStopsHtml(rec) {
    const routes = acctRoutesByAccountingId[rec.id];
    if (!routes || !routes.length) {
      return {
        miles: escapeHtml(rec.total_miles != null ? String(rec.total_miles) : "—"),
        stops: escapeHtml(rec.total_stops != null ? String(rec.total_stops) : "—"),
      };
    }
    const miles = `<div style="display:flex; flex-direction:column; gap:2px;">${routes.map((r) => `<div>${escapeHtml(r.miles != null ? String(r.miles) : "—")}</div>`).join("")}</div>`;
    const stops = `<div style="display:flex; flex-direction:column; gap:2px;">${routes.map((r) => `<div>${escapeHtml(r.stops != null ? String(r.stops) : "—")}</div>`).join("")}</div>`;
    return { miles, stops };
  }
  export function fmtMoney(n) { return n == null ? "—" : `$${Number(n).toFixed(2)}`; }
  const LOCATIONS_WITH_LEVELS = ["atlanta"]; // only these use Cost/Revenue Level tiers — everyone else has a set rate
  const LOCATIONS_WITH_ROUTES_INSTEAD_OF_COST = ["delaware"]; // flat-rate locations: show Routes, hide Total Cost/Revenue/FSC
  const LOCATIONS_WITHOUT_FSC = ["atlanta"]; // Atlanta keeps Total Cost/Revenue but doesn't need its own FSC column
  export function acctTableHeaderHtml() {
    const loc = state.acctLocationTab || "atlanta";
    const showLevels = LOCATIONS_WITH_LEVELS.includes(loc);
    const showRoutesInstead = LOCATIONS_WITH_ROUTES_INSTEAD_OF_COST.includes(loc);
    const showFsc = !showRoutesInstead && !LOCATIONS_WITHOUT_FSC.includes(loc);
    return `<tr>
      <th>Date</th>
      <th>Aljex #</th>
      <th>Driver</th>
      <th>MC</th>
      ${showLevels ? `<th>Cost Level</th><th>Revenue Level</th>` : ""}
      ${showLevels ? `<th>Routes</th>` : ""}
      ${showRoutesInstead ? `<th>Routes</th>` : ""}
      <th>Total Miles</th>
      <th>Total Stops</th>
      <th>Carrier Rate</th>
      ${showRoutesInstead ? "" : `<th>Customer Rate</th>${showFsc ? "<th>FSC Payment</th>" : ""}`}
      <th>Day Type</th>
      <th>Sent</th>
      <th>Released</th>
      <th>Hidden</th>
    </tr>`;
  }
  export function accountingRowHtml(rec) {
    const showLevels = LOCATIONS_WITH_LEVELS.includes(rec.location);
    const showRoutesInstead = LOCATIONS_WITH_ROUTES_INSTEAD_OF_COST.includes(rec.location);
    const showFsc = !showRoutesInstead && !LOCATIONS_WITHOUT_FSC.includes(rec.location);
    const levelOptions = (selected) => [1, 2, 3, 4].map((n) => `<option value="${n}" ${n === selected ? "selected" : ""}>${n}${n === 4 ? " (Market)" : ""}</option>`).join("");
    const dayTypeOptions = ["weekday", "weekend", "holiday"].map((d) => `<option value="${d}" ${d === (rec.day_type || "weekday") ? "selected" : ""}>${d[0].toUpperCase() + d.slice(1)}</option>`).join("");
    const ms = acctMilesStopsHtml(rec);
    const isDimmed = rec.hidden || rec.status === "released";
    const rowStyle = isDimmed ? ` style="opacity:0.5;"` : "";
    return `<tr id="acct-${rec.id}"${rowStyle}>
      <td>${escapeHtml(rec.shift_date)}</td>
      <td>${rec.aljex_load_number ? `<button type="button" class="cell-link-btn" style="width:auto; padding:2px 10px;" data-open-acct-load="${rec.id}">${escapeHtml(rec.aljex_load_number)} ↗</button>` : "—"}</td>
      <td>${escapeHtml(rec.driver_name_text || "—")}</td>
      <td>${escapeHtml(rec.mc_dot || "—")}</td>
      ${showLevels ? `
      <td><select class="cell-input" data-action="acct-cost-level" data-id="${rec.id}">${levelOptions(rec.cost_level)}</select></td>
      <td><select class="cell-input" data-action="acct-revenue-level" data-id="${rec.id}">${levelOptions(rec.revenue_level)}</select></td>` : ""}
      ${showLevels ? `<td>${acctRouteIdsHtml(rec)}</td>` : ""}
      ${showRoutesInstead ? `<td>${acctRoutesChipsHtml(rec)}</td>` : ""}
      <td>${ms.miles}</td>
      <td>${ms.stops}</td>
      <td>
        <div style="display:flex; align-items:center; gap:2px;">
          <span class="subtext">$</span>
          <input class="cell-input" style="width:78px;" data-action="acct-carrier-pay" data-id="${rec.id}" value="${rec.total_carrier_pay != null ? Number(rec.total_carrier_pay).toFixed(2) : ""}">
        </div>
      </td>
      ${showRoutesInstead ? "" : `<td>
        <div style="display:flex; align-items:center; gap:2px;">
          <span class="subtext">$</span>
          <input class="cell-input" style="width:78px;" data-action="acct-customer-rate" data-id="${rec.id}" value="${rec.total_revenue != null ? Number(rec.total_revenue).toFixed(2) : ""}">
        </div>
      </td>${showFsc ? `<td>${fmtMoney(rec.fsc_payment)}</td>` : ""}`}
      <td><select class="cell-input" data-action="acct-day-type" data-id="${rec.id}">${dayTypeOptions}</select></td>
      <td style="text-align:center;"><input type="checkbox" class="chk" data-action="acct-sent" data-id="${rec.id}" ${rec.sent ? "checked" : ""} title="Sent"></td>
      <td style="text-align:center;"><input type="checkbox" class="chk" data-action="acct-released" data-id="${rec.id}" ${rec.status === "released" ? "checked" : ""} title="Released"></td>
      <td style="text-align:center;"><input type="checkbox" class="chk" data-action="acct-hidden" data-id="${rec.id}" ${rec.hidden ? "checked" : ""} title="Hidden"></td>
    </tr>`;
  }
  export function getFilteredAccountingRecords() {
    const loc = state.acctLocationTab || "atlanta";
    let filtered = accountingRecords.filter((r) => r.location === loc);
    if (state.acctDateFilter) filtered = filtered.filter((r) => r.shift_date === state.acctDateFilter);
    if (!state.acctShowHidden) filtered = filtered.filter((r) => !r.hidden);
    return filtered;
  }

  // Count of hidden rows for the current location tab — drives the label
  // on the Show Hidden toggle. Deliberately ignores the day filter (shows
  // the total for the whole tab), so the count doesn't flicker as someone
  // clicks through days.
  function hiddenCountForCurrentTab() {
    const loc = state.acctLocationTab || "atlanta";
    return accountingRecords.filter((r) => r.location === loc && r.hidden).length;
  }

  function updateShowHiddenButton() {
    const btn = $("#btn-show-hidden");
    if (!btn) return;
    const count = hiddenCountForCurrentTab();
    btn.textContent = state.acctShowHidden ? "Hide Hidden Again" : `Show Hidden (${count})`;
  }
  export function renderAccountingTable() {
    const body = $("#accounting-table-body");
    if (!body) return;
    const filtered = getFilteredAccountingRecords();
    const loc = state.acctLocationTab || "atlanta";
    if ($("#accounting-table-head")) $("#accounting-table-head").innerHTML = acctTableHeaderHtml();
    const showLevels = LOCATIONS_WITH_LEVELS.includes(loc);
    const showRoutesInstead = LOCATIONS_WITH_ROUTES_INSTEAD_OF_COST.includes(loc);
    const showFsc = !showRoutesInstead && !LOCATIONS_WITHOUT_FSC.includes(loc);
    const colspan = (showLevels ? (showFsc ? 14 : 13) : (showRoutesInstead ? 10 : (showFsc ? 11 : 10))) + 1;      body.innerHTML = filtered.length
      ? filtered.map(accountingRowHtml).join("")
      : `<tr><td colspan="${colspan}" class="subtext" style="padding:16px;">No completed loads ${state.acctDateFilter ? "for this day" : ""} here yet — mark a shift complete on the ${loc} board and it'll show up here.</td></tr>`;
    renderDriverStatsTable();
    updateShowHiddenButton();
  }
export function renderDriverStatsTable() {
    const body = $("#accounting-driver-table-body");
    if (!body) return;
    const filtered = getFilteredAccountingRecords();
    const byDriver = {};
    filtered.forEach((r) => {
      const key = r.driver_name_text || "(no driver on file)";
      if (!byDriver[key]) byDriver[key] = { name: key, loads: 0, miles: 0, stops: 0, revenue: 0, carrierPay: 0 };
      const d = byDriver[key];
      d.loads += 1;
      d.miles += Number(r.total_miles) || 0;
      d.stops += Number(r.total_stops) || 0;
      d.revenue += Number(r.total_revenue) || 0;
      d.carrierPay += Number(r.total_carrier_pay) || 0;
    });
    const rows = Object.values(byDriver).sort((a, b) => b.loads - a.loads);
    body.innerHTML = rows.length
      ? rows.map((d) => `<tr>
          <td>${escapeHtml(d.name)}</td>
          <td>${d.loads}</td>
          <td>${d.miles.toFixed(0)}</td>
          <td>${d.stops.toFixed(0)}</td>
          <td>${fmtMoney(d.carrierPay)}</td>
          <td>${fmtMoney(d.revenue)}</td>
          <td>${fmtMoney(d.loads ? d.carrierPay / d.loads : 0)}</td>
        </tr>`).join("")
      : `<tr><td colspan="7" class="subtext" style="padding:16px;">No completed loads here yet.</td></tr>`;
  }
  export function switchAcctLocationTab(loc) {
    state.acctLocationTab = loc;
    $all(".location-tab", $("#acct-location-tabs")).forEach((btn) => btn.classList.toggle("is-active", btn.dataset.location === loc));
    renderAccountingTable();
  }
  export function setAcctDateFilter(dKey) {
    state.acctDateFilter = dKey;
    state.activeDate = dKey; // reuses the shared calendar's "selected day" highlighting
    renderAcctDateChrome();
    renderAccountingTable();
  }
  export async function recalcAccountingRecord(accountingId, patch) {
    accountingId = Number(accountingId);
    const rec = accountingRecords.find((r) => Number(r.id) === accountingId);
    if (!rec) return;
    Object.assign(rec, patch);
      if (!getPricingTiers() || !getPricingSettings()) await loadPricingData();
    const { data: routes, error } = await supabaseClient.from(ACCOUNTING_ROUTES_TABLE).select("*").eq("accounting_id", accountingId);
    if (error) { console.error("Failed to load routes for recalc:", error); return; }
    let totalCost = 0, totalRevenue = 0;
    const routeUpdates = (routes || []).map((r) => {
    const calc = calcRoute({ costLevel: rec.cost_level, revenueLevel: rec.revenue_level, miles: Number(r.miles) || 0, stops: Number(r.stops) || 0, contractRate: rec.contract_rate }, getPricingTiers(), getPricingSettings());      totalCost += calc.totalCost; totalRevenue += calc.totalRevenue;
      return { id: r.id, linehaul_cost: calc.linehaulCost, stop_charge: calc.stopCharge, total_cost: calc.totalCost, revenue: calc.revenue, stop_charge_revenue: calc.stopChargeRevenue, total_revenue: calc.totalRevenue };
    });
    rec.total_cost = Math.round(totalCost * 100) / 100;
    rec.total_revenue = Math.round(totalRevenue * 100) / 100;
    if (rec.location === "delaware" && rec.total_miles > 0) {
      rec.total_cost = Math.round(Math.max(1000, rec.total_miles * 4) * 100) / 100;
    }
    try {
      await supabaseClient.from(ACCOUNTING_TABLE).update({ cost_level: rec.cost_level, revenue_level: rec.revenue_level, total_cost: rec.total_cost, total_revenue: rec.total_revenue }).eq("id", accountingId);
      for (const ru of routeUpdates) {
        await supabaseClient.from(ACCOUNTING_ROUTES_TABLE).update(ru).eq("id", ru.id);
      }
    } catch (e) {
      console.error("recalcAccountingRecord failed:", e);
      setDriverSyncStatus(`Couldn't save the recalculated totals (${e.message || e}).`, "error");
    }
    renderAccountingTable();
  }
  export function renderAcctDateChrome() {
    const input = $("#date-input");
    if (!input) return;
    input.value = state.activeDate || state.todayKey;
    input.min = state.minDate;
    input.max = state.maxDate;
    if ($("#date-next")) $("#date-next").disabled = (state.activeDate || state.todayKey) >= state.maxDate;
    if ($("#date-prev")) $("#date-prev").disabled = (state.activeDate || state.todayKey) <= state.minDate;
  }
  export async function initAccountingPage() {
    console.log("accounting.js build marker: 2026-08-13-c"); // confirms THIS version's code actually ran — check DevTools Console for this exact string
    // Accounting looks back further than the boards do — override the
    // shared min/max just for this page's calendar.
    state.minDate = dateKey(addDays(todayDate(), -60));
    state.maxDate = state.todayKey;
    state.acctLocationTab = "atlanta";
    state.acctDateFilter = state.todayKey;
    state.activeDate = state.todayKey;
    state.acctShowHidden = false;
    await loadPricingData();
    const initialSettings = getPricingSettings();
    if (initialSettings && $("#fsc-rate-input")) $("#fsc-rate-input").value = initialSettings.fsc_rate || "";
    await loadAccountingRecords();
    await loadLocationNotes();
    renderAccountingTable();
    setupAccountingRealtimeSync();
    if ($("#acct-location-tabs")) {
      $("#acct-location-tabs").addEventListener("click", (e) => {
        const btn = e.target.closest(".location-tab");
        if (btn) switchAcctLocationTab(btn.dataset.location);
      });
      switchAcctLocationTab("atlanta");
    }
    if ($("#modal-location-notes")) {
      on("btn-location-info", "click", () => {
        const loc = state.acctLocationTab || "atlanta";
        const label = { atlanta: "Atlanta", buildingc: "Building C", delaware: "Delaware", houston: "Houston" }[loc] || loc;
        // Namespaced so this never collides with the real board pages' own
        // notes (which use the bare location key, e.g. "atlanta") — this
        // page gets its own separate row per location instead.
        openLocationNotesModal(`accounting-${loc}`, `Accounting — ${label}`);
      });
      on("ln-close", "click", closeLocationNotesModal);
      on("ln-cancel", "click", closeLocationNotesModal);
      on("ln-save", "click", saveLocationNotes);
      $("#modal-location-notes").addEventListener("click", (e) => { if (e.target.id === "modal-location-notes") closeLocationNotesModal(); });
    }
    if ($("#acct-view-toggle")) {
      $("#acct-view-toggle").addEventListener("click", (e) => {
        const btn = e.target.closest(".location-tab");
        if (!btn) return;
        $all(".location-tab", $("#acct-view-toggle")).forEach((b) => b.classList.toggle("is-active", b === btn));
        $("#acct-byload-view").classList.toggle("hidden", btn.dataset.view !== "byload");
        $("#acct-bydriver-view").classList.toggle("hidden", btn.dataset.view !== "bydriver");
      });
    }
    on("acct-show-all", "click", () => setAcctDateFilter(null));
    if ($("#btn-show-hidden")) {
      $("#btn-show-hidden").addEventListener("click", () => {
        state.acctShowHidden = !state.acctShowHidden;
        renderAccountingTable();
      });
    }
    $("#date-prev").addEventListener("click", () => setAcctDateFilter(dateKey(addDays(keyToDate(state.activeDate || state.todayKey), -1))));
    $("#date-next").addEventListener("click", () => setAcctDateFilter(dateKey(addDays(keyToDate(state.activeDate || state.todayKey), 1))));
    $("#date-input").addEventListener("change", (e) => setAcctDateFilter(e.target.value));
    $("#date-input").addEventListener("click", (e) => { e.preventDefault(); state.datesWithData = new Set(accountingRecords.filter((r) => r.location === state.acctLocationTab).map((r) => r.shift_date)); openDateDropdown(); });
    $("#date-dropdown").addEventListener("click", (e) => {
      const btn = e.target.closest(".cal-cell[data-date]:not(:disabled)");
      if (btn) { setAcctDateFilter(btn.dataset.date); closeDateDropdown(); }
    });
    document.addEventListener("click", (e) => {
      if (!e.target.closest("#date-dropdown") && !e.target.closest("#date-input")) closeDateDropdown();
    });
    if (!state.activeDate) state.activeDate = state.todayKey;
    renderAcctDateChrome();
    on("btn-save-fsc", "click", async () => {
      const val = Number($("#fsc-rate-input").value);
      if (!val || val <= 0) { setDriverSyncStatus("Enter a valid FSC rate first.", "error"); return; }
      try {
        await supabaseClient.from("pricing_settings").update({ value: val }).eq("key", "fsc_rate");
        const settings = getPricingSettings();
        if (settings) settings.fsc_rate = val;
        setDriverSyncStatus("FSC rate saved — used for every load completed from now on.", "success");
      } catch (e) {
        setDriverSyncStatus(`Couldn't save FSC rate (${e.message || e}).`, "error");
      }
    });
    const table = $("#accounting-table");
    if (table) {
      table.addEventListener("change", (e) => {
        const t = e.target;
        if (t.dataset.action === "acct-cost-level") recalcAccountingRecord(t.dataset.id, { cost_level: Number(t.value) });
        else if (t.dataset.action === "acct-revenue-level") recalcAccountingRecord(t.dataset.id, { revenue_level: Number(t.value) });
        else if (t.dataset.action === "acct-hidden") {
          const rec = accountingRecords.find((r) => r.id == t.dataset.id);
          if (!rec) return;
          const wasHidden = rec.hidden;
          rec.hidden = t.checked;
          renderAccountingTable(); // the row disappears immediately unless Show Hidden is already on
          supabaseClient.from(ACCOUNTING_TABLE).update({ hidden: t.checked }).eq("id", rec.id).select()
            .then(({ data, error }) => {
              if (error) throw error;
              if (!data || data.length === 0) {
                // Same silent failure mode already hit once with the drivers
                // table: Supabase returns success with zero rows touched
                // when a table has no UPDATE policy in Row Level Security —
                // no error, but nothing actually saved. Revert the checkbox
                // rather than let the UI keep showing a state that never
                // made it to the database.
                rec.hidden = wasHidden;
                renderAccountingTable();
                setDriverSyncStatus('Hidden didn\'t save — 0 rows were updated. loads_accounting needs an "update" Row Level Security policy.', "error");
              }
            })
            .catch((err) => {
              rec.hidden = wasHidden;
              renderAccountingTable();
              setDriverSyncStatus(`Couldn't save Hidden (${err.message || err}).`, "error");
            });
        }
        else if (t.dataset.action === "acct-sent") {
          const rec = accountingRecords.find((r) => r.id == t.dataset.id);
          if (!rec) return;
          rec.sent = t.checked;
          supabaseClient.from(ACCOUNTING_TABLE).update({ sent: t.checked }).eq("id", rec.id)
            .catch((err) => setDriverSyncStatus(`Couldn't save Sent (${err.message || err}).`, "error"));
        }
        else if (t.dataset.action === "acct-released") {
          const rec = accountingRecords.find((r) => r.id == t.dataset.id);
          if (!rec) return;
          rec.status = t.checked ? "released" : "active";
          accountingRecords.sort(acctSortCompare);
          renderAccountingTable();
          supabaseClient.from(ACCOUNTING_TABLE).update({ status: rec.status }).eq("id", rec.id)
            .catch((err) => setDriverSyncStatus(`Couldn't save status (${err.message || err}).`, "error"));
        }
        else if (t.dataset.action === "acct-day-type") {
          const rec = accountingRecords.find((r) => r.id == t.dataset.id);
          if (!rec) return;
          rec.day_type = t.value;
          supabaseClient.from(ACCOUNTING_TABLE).update({ day_type: t.value }).eq("id", rec.id)
            .catch((err) => setDriverSyncStatus(`Couldn't save day type (${err.message || err}).`, "error"));
        }
      });
      table.addEventListener("input", (e) => {
        const t = e.target;
        if (t.dataset.action === "acct-carrier-pay") {
          const rec = accountingRecords.find((r) => r.id == t.dataset.id);
          if (!rec) return;
          const val = t.value === "" ? null : Number(t.value);
          rec.total_carrier_pay = val;
          clearTimeout(t._saveTimer);
          t._saveTimer = setTimeout(() => {
            supabaseClient.from(ACCOUNTING_TABLE).update({ total_carrier_pay: val }).eq("id", rec.id)
              .catch((err) => setDriverSyncStatus(`Couldn't save carrier pay (${err.message || err}).`, "error"));
          }, SAVE_DEBOUNCE_MS);
        }
        if (t.dataset.action === "acct-customer-rate") {
          const rec = accountingRecords.find((r) => r.id == t.dataset.id);
          if (!rec) return;
          const val = t.value === "" ? null : Number(t.value);
          rec.total_revenue = val;
          clearTimeout(t._saveTimer);
          t._saveTimer = setTimeout(() => {
            supabaseClient.from(ACCOUNTING_TABLE).update({ total_revenue: val }).eq("id", rec.id)
              .catch((err) => setDriverSyncStatus(`Couldn't save customer rate (${err.message || err}).`, "error"));
          }, SAVE_DEBOUNCE_MS);
        }
      });
        table.addEventListener("focusout", (e) => {
        const t = e.target;
        if ((t.dataset.action === "acct-carrier-pay" || t.dataset.action === "acct-customer-rate") && t.value !== "") {
          const num = Number(t.value);
          if (!isNaN(num)) t.value = num.toFixed(2);
        }
      });
      table.addEventListener("click", (e) => {
        const openBtn = e.target.closest("[data-open-acct-load]");
        if (!openBtn) return;
        const openArgs = [openBtn.dataset.openAcctLoad, openBtn.dataset.openAcctTrip || null, openBtn.dataset.openAcctRouteText || null];
        const rec = accountingRecords.find((r) => r.id == openBtn.dataset.openAcctLoad);
        const shiftIncomplete = rec && rec.source_shift_id && acctShiftCompleteById[rec.source_shift_id] === false;
        if (shiftIncomplete) {
          showDriverAssignmentWarning(
            "Shift Not Marked Complete",
            ["This load reached Accounting automatically, but the shift itself hasn't been marked complete on the board yet.",
             "Make sure the driver has actually finished the shift before proceeding."],
            () => openLoadDetailsFromAccounting(...openArgs)
          );
        } else {
          openLoadDetailsFromAccounting(...openArgs);
        }
      });
    }
    if ($("#modal-load-details")) {
      on("ld-close", "click", closeLoadDetailsModal);
      on("ld-close-btn", "click", closeLoadDetailsModal);
      $("#modal-load-details").addEventListener("click", (e) => { if (e.target.id === "modal-load-details") closeLoadDetailsModal(); });
      $("#ld-tabs").addEventListener("click", (e) => {
        const tabBtn = e.target.closest(".ld-tab");
        if (tabBtn && loadDetailsState) { loadDetailsState.activeTab = tabBtn.dataset.tab; loadDetailsState.editMode = null; renderLoadDetailsTabs(); }
      });
      $("#ld-tab-content").addEventListener("change", (e) => {
        if (e.target.id === "ld-file-input" && e.target.files.length) uploadTripSheetImages(Array.from(e.target.files));
        if (e.target.id === "ld-rate-total") commitRateOverride(e.target.value);
        if (e.target.id === "ld-route-type-select" && loadDetailsState) changeRouteType(loadDetailsState.rowId, e.target.value);
        if (e.target.id === "ld-hostler-hours" && loadDetailsState) setHostlerHours(loadDetailsState.rowId, e.target.value);
        if (e.target.dataset.rateTierId != null && e.target.dataset.rateTierId !== "") commitRateBoxOverride("tier", Number(e.target.dataset.rateTierId), e.target.value);
        if (e.target.dataset.rateSettingKey) commitRateBoxOverride("setting", e.target.dataset.rateSettingKey, e.target.value);
      });
      $("#ld-tab-content").addEventListener("click", (e) => {
        const rmBtn = e.target.closest("[data-remove-attachment]");
        if (rmBtn) removeTripSheetImage(rmBtn.dataset.removeAttachment);
        const editBtn = e.target.closest("[data-ld-edit]");
        if (editBtn) startLoadDetailsEdit(editBtn.dataset.ldEdit);
        const cancelBtn = e.target.closest("[data-ld-cancel]");
        if (cancelBtn) cancelLoadDetailsEdit();
        const saveBtn = e.target.closest("[data-ld-save]");
        if (saveBtn) saveLoadDetailsEdit(saveBtn.dataset.ldSave);
        if (e.target.id === "ld-rate-reset") resetRateToCalculated();
        const profileBtn = e.target.closest('[data-action="edit-driver"]');
        if (profileBtn) openEditDriverModal(profileBtn.dataset.driverId);
      });
      $("#ld-tab-content").addEventListener("input", (e) => {
        if (e.target.id === "ld-tr-stopCount" && loadDetailsState && loadDetailsState.editDraft) {
          loadDetailsState.editDraft.stopCount = e.target.value;
          const container = $("#ld-stop-fields");
          if (container) container.innerHTML = stopFieldsHtml(Math.max(0, parseInt(e.target.value, 10) || 0), loadDetailsState.editDraft.stops);
        }
      });
    }
  }
  export function setupAccountingRealtimeSync() {
    if (!supabaseClient) return;
    const channel = supabaseClient.channel("accounting");
    channel.on("postgres_changes", { event: "*", schema: "public", table: "loads_accounting" }, async (payload) => {
      if (payload.eventType === "DELETE") return;
      const idx = accountingRecords.findIndex((r) => r.id === payload.new.id);
      if (idx !== -1) accountingRecords[idx] = payload.new; else accountingRecords.push(payload.new);
      accountingRecords.sort(acctSortCompare);
      // A record that just arrived via realtime was never part of the
      // original bulk fetch in loadAccountingRecordsForRange — its routes
      // and shift-complete status need to be pulled in separately, or the
      // Routes column renders "—" for it forever even though the routes
      // genuinely exist (this is exactly why the Accounting page's Routes
      // column could disagree with what the Load Details modal shows for
      // the same load — the modal always fetches fresh, this cache didn't).
      if (!acctRoutesByAccountingId[payload.new.id]) {
        const { data: routes } = await supabaseClient.from(ACCOUNTING_ROUTES_TABLE).select("*").eq("accounting_id", payload.new.id);
        if (routes && routes.length) {
          acctRoutesByAccountingId[payload.new.id] = routes.sort((a, b) => (a.route_number || 0) - (b.route_number || 0));
        }
      }
      if (payload.new.source_shift_id && acctShiftCompleteById[payload.new.source_shift_id] === undefined) {
        const { data: shiftRows } = await supabaseClient.from(SHIFTS_TABLE).select("shift_complete").eq("id", payload.new.source_shift_id);
        if (shiftRows && shiftRows[0]) acctShiftCompleteById[payload.new.source_shift_id] = !!shiftRows[0].shift_complete;
      }
      renderAccountingTable();
    });
    channel.subscribe();
  }