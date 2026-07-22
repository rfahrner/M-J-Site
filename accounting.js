/* ---------------- Accounting page ---------------- */
import {
  supabaseClient, TRIPS_TABLE, escapeHtml, $, $all, on, setDriverSyncStatus,
  state, dateKey, addDays, todayDate, keyToDate, openDateDropdown, closeDateDropdown,
  SAVE_DEBOUNCE_MS, closeLoadDetailsModal, loadDetailsState, renderLoadDetailsTabs,
  uploadTripSheetImages, removeTripSheetImage, startLoadDetailsEdit, cancelLoadDetailsEdit,
  saveLoadDetailsEdit, stopFieldsHtml, openLoadDetailsFromAccounting,
  commitRateOverride, resetRateToCalculated, toggleBirm, commitRateBoxOverride,
} from './loadboard.js';
import { ACCOUNTING_TABLE, ACCOUNTING_ROUTES_TABLE, loadPricingData, calcRoute, getPricingTiers, getPricingSettings } from './accountingcalc.js';

let accountingRecords = [];

  let acctTripsByShiftId = {}; // source_shift_id -> [trips], used for the Delaware "Routes" column

  // loadboard.js's openLoadDetailsFromAccounting() needs to look up a
  // record from this module-private array — this is the sanctioned way
  // in, rather than exporting the array itself.
  export function getAccountingRecordById(id) {
    return accountingRecords.find((r) => r.id == id) || null;
  }

  export async function loadAccountingRecords() {
    if (!supabaseClient) return;
    const { data, error } = await supabaseClient.from(ACCOUNTING_TABLE).select("*");
    if (error) { console.error("Failed to load accounting records:", error); setDriverSyncStatus(`Couldn't load Accounting (${error.message}).`, "error"); return; }
    accountingRecords = (data || []).sort((a, b) => (a.shift_date < b.shift_date ? 1 : -1));

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
  export function fmtMoney(n) { return n == null ? "—" : `$${Number(n).toFixed(2)}`; }

  const LOCATIONS_WITH_LEVELS = ["atlanta"]; // only these use Cost/Revenue Level tiers — everyone else has a set rate
  const LOCATIONS_WITH_ROUTES_INSTEAD_OF_COST = ["delaware"]; // flat-rate locations: show Routes, hide Total Cost/Revenue/FSC

  export function acctTableHeaderHtml() {
    const loc = state.acctLocationTab || "atlanta";
    const showLevels = LOCATIONS_WITH_LEVELS.includes(loc);
    const showRoutesInstead = LOCATIONS_WITH_ROUTES_INSTEAD_OF_COST.includes(loc);
    return `<tr>
      <th>Date</th>
      <th>Aljex #</th>
      <th>Driver</th>
      <th>MC</th>
      ${showLevels ? `<th>Cost Level</th><th>Revenue Level</th>` : ""}
      ${showRoutesInstead ? `<th>Routes</th>` : ""}
      <th>Total Miles</th>
      <th>Total Stops</th>
      ${showRoutesInstead ? "" : `<th>Total Cost</th><th>Total Revenue</th><th>FSC Payment</th>`}
      <th>Total Carrier Pay</th>
      <th>Status</th>
    </tr>`;
  }

  export function accountingRowHtml(rec) {
    const showLevels = LOCATIONS_WITH_LEVELS.includes(rec.location);
    const showRoutesInstead = LOCATIONS_WITH_ROUTES_INSTEAD_OF_COST.includes(rec.location);
    const levelOptions = (selected) => [1, 2, 3, 4].map((n) => `<option value="${n}" ${n === selected ? "selected" : ""}>${n}${n === 4 ? " (Market)" : ""}</option>`).join("");
    const statusOptions = ["active", "released"].map((s) => `<option value="${s}" ${s === rec.status ? "selected" : ""}>${s[0].toUpperCase() + s.slice(1)}</option>`).join("");
    return `<tr id="acct-${rec.id}">
      <td>${escapeHtml(rec.shift_date)}</td>
      <td>${rec.aljex_load_number ? `<button type="button" class="cell-link-btn" style="width:auto; padding:2px 10px;" data-open-acct-load="${rec.id}">${escapeHtml(rec.aljex_load_number)} ↗</button>` : "—"}</td>
      <td>${escapeHtml(rec.driver_name_text || "—")}</td>
      <td>${escapeHtml(rec.mc_dot || "—")}</td>
      ${showLevels ? `
      <td><select class="cell-input" data-action="acct-cost-level" data-id="${rec.id}">${levelOptions(rec.cost_level)}</select></td>
      <td><select class="cell-input" data-action="acct-revenue-level" data-id="${rec.id}">${levelOptions(rec.revenue_level)}</select></td>` : ""}
      ${showRoutesInstead ? `<td>${acctRoutesChipsHtml(rec)}</td>` : ""}
      <td>${escapeHtml(rec.total_miles != null ? String(rec.total_miles) : "—")}</td>
      <td>${escapeHtml(rec.total_stops != null ? String(rec.total_stops) : "—")}</td>
      ${showRoutesInstead ? "" : `<td>${fmtMoney(rec.total_cost)}</td><td>${fmtMoney(rec.total_revenue)}</td><td>${fmtMoney(rec.fsc_payment)}</td>`}
      <td><input class="cell-input" style="width:90px;" data-action="acct-carrier-pay" data-id="${rec.id}" value="${rec.total_carrier_pay != null ? rec.total_carrier_pay : ""}"></td>
      <td><select class="cell-input" data-action="acct-status" data-id="${rec.id}">${statusOptions}</select></td>
    </tr>`;
  }

  export function getFilteredAccountingRecords() {
    const loc = state.acctLocationTab || "atlanta";
    let filtered = accountingRecords.filter((r) => r.location === loc);
    if (state.acctDateFilter) filtered = filtered.filter((r) => r.shift_date === state.acctDateFilter);
    return filtered;
  }

  export function renderAccountingTable() {
    const body = $("#accounting-table-body");
    if (!body) return;
    const filtered = getFilteredAccountingRecords();
    const loc = state.acctLocationTab || "atlanta";
    if ($("#accounting-table-head")) $("#accounting-table-head").innerHTML = acctTableHeaderHtml();
    const showLevels = LOCATIONS_WITH_LEVELS.includes(loc);
    const showRoutesInstead = LOCATIONS_WITH_ROUTES_INSTEAD_OF_COST.includes(loc);
    const colspan = showLevels ? 13 : (showRoutesInstead ? 9 : 11);
    body.innerHTML = filtered.length
      ? filtered.map(accountingRowHtml).join("")
      : `<tr><td colspan="${colspan}" class="subtext" style="padding:16px;">No completed loads ${state.acctDateFilter ? "for this day" : ""} here yet — mark a shift complete on the ${loc} board and it'll show up here.</td></tr>`;
    renderDriverStatsTable();
  }

  export function renderDriverStatsTable() {
    const body = $("#accounting-driver-table-body");
    if (!body) return;
    const filtered = getFilteredAccountingRecords();
    const byDriver = {};
    filtered.forEach((r) => {
      const key = r.driver_name_text || "(no driver on file)";
      if (!byDriver[key]) byDriver[key] = { name: key, loads: 0, miles: 0, stops: 0, cost: 0, revenue: 0, carrierPay: 0 };
      const d = byDriver[key];
      d.loads += 1;
      d.miles += Number(r.total_miles) || 0;
      d.stops += Number(r.total_stops) || 0;
      d.cost += Number(r.total_cost) || 0;
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
          <td>${fmtMoney(d.cost)}</td>
          <td>${fmtMoney(d.revenue)}</td>
          <td>${fmtMoney(d.carrierPay)}</td>
          <td>${fmtMoney(d.loads ? d.carrierPay / d.loads : 0)}</td>
        </tr>`).join("")
      : `<tr><td colspan="8" class="subtext" style="padding:16px;">No completed loads here yet.</td></tr>`;
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
    // Accounting looks back further than the boards do — override the
    // shared min/max just for this page's calendar.
    state.minDate = dateKey(addDays(todayDate(), -60));
    state.maxDate = state.todayKey;
    state.acctLocationTab = "atlanta";
    state.acctDateFilter = null;

    await loadPricingData();
    const initialSettings = getPricingSettings();
    if (initialSettings && $("#fsc-rate-input")) $("#fsc-rate-input").value = initialSettings.fsc_rate || "";
    await loadAccountingRecords();
    renderAccountingTable();
    setupAccountingRealtimeSync();

    if ($("#acct-location-tabs")) {
      $("#acct-location-tabs").addEventListener("click", (e) => {
        const btn = e.target.closest(".location-tab");
        if (btn) switchAcctLocationTab(btn.dataset.location);
      });
      switchAcctLocationTab("atlanta");
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
    $("#date-prev").addEventListener("click", () => setAcctDateFilter(dateKey(addDays(keyToDate(state.activeDate || state.todayKey), -1))));
    $("#date-next").addEventListener("click", () => setAcctDateFilter(dateKey(addDays(keyToDate(state.activeDate || state.todayKey), 1))));
    $("#date-input").addEventListener("change", (e) => setAcctDateFilter(e.target.value));
    $("#date-input").addEventListener("click", (e) => { e.preventDefault(); state.datesWithData = new Set(accountingRecords.filter((r) => r.location === state.acctLocationTab).map((r) => r.shift_date)); openDateDropdown(); });
    $("#date-today").addEventListener("click", () => setAcctDateFilter(state.todayKey));
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
        else if (t.dataset.action === "acct-status") {
          const rec = accountingRecords.find((r) => r.id == t.dataset.id);
          if (!rec) return;
          rec.status = t.value;
          supabaseClient.from(ACCOUNTING_TABLE).update({ status: t.value }).eq("id", rec.id)
            .catch((err) => setDriverSyncStatus(`Couldn't save status (${err.message || err}).`, "error"));
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
      });
      table.addEventListener("click", (e) => {
        const openBtn = e.target.closest("[data-open-acct-load]");
        if (openBtn) openLoadDetailsFromAccounting(openBtn.dataset.openAcctLoad, openBtn.dataset.openAcctTrip || null);
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
        if (e.target.id === "ld-birm-toggle" && loadDetailsState) toggleBirm(loadDetailsState.rowId);
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
    channel.on("postgres_changes", { event: "*", schema: "public", table: "loads_accounting" }, (payload) => {
      if (payload.eventType === "DELETE") return;
      const idx = accountingRecords.findIndex((r) => r.id === payload.new.id);
      if (idx !== -1) accountingRecords[idx] = payload.new; else accountingRecords.push(payload.new);
      accountingRecords.sort((a, b) => (a.shift_date < b.shift_date ? 1 : -1));
      renderAccountingTable();
    });
    channel.subscribe();
  }