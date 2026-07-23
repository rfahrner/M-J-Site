/* ================================================================
   Mondelez board — flat table like Houston (one row per route, no
   shift/trip split), but spanning several origin DCs shown as
   sub-tabs on a single page, plus a "combined" tab showing every
   location's activity for the day at once (fully editable — each
   row still saves back to its own location, the combined view is
   just a different lens on the same data).

   Revenue (what Mondelez pays D&L) is calculated from a per-DC rate
   table: Daily Rate + (Stops x Stop Rate) + (Miles over threshold x
   Over-Mileage Rate) + FSC (entered per load — it tracks a live
   diesel-price index there's no way to pull automatically). This
   formula was reverse-engineered from the rate card and verified
   against Addison/West Chester/Indianapolis exactly; only 4 of the
   11 locations have real seeded numbers today — the rest default to
   0 and need filling in via the same editable rate boxes.

   Driver pay is NOT auto-calculated here on purpose — there's no
   standard rate for it (confirmed), so it's just a plain editable
   field, same as Houston's.
   ================================================================ */
import {
  state, supabaseClient, uid, findDriver, driversForLocation, setDriverSyncStatus,
  SAVE_DEBOUNCE_MS, escapeHtml, $, keyToDate, addDays, dateKey,
  refreshDriverDatalist, closeDateDropdown, renderCalendarGrid, resetCalendarViewMonth,
  closeContextMenu, handleRealtimeDriverChange, pick, textDriverPhone,
} from './loadboard.js';

export const MONDELEZ_TABLE = "mondelez_loads";
export const MONDELEZ_RATE_SETTINGS_TABLE = "mondelez_rate_settings";
export const MONDELEZ_IMAGE_BUCKET = "mondelez-routes";

// Best-cleanup pass of the locations in your spreadsheet — combined
// "shuttle" entries like "Morris/Franksville" get filed under the
// origin DC that dispatches them (Morris), since a load only lives on
// one tab. Say the word if any of these should split further.
export const MONDELEZ_LOCATIONS = [
  { key: "morris", label: "Morris" },
  { key: "addison", label: "Addison" },
  { key: "westchester", label: "West Chester" },
  { key: "indianapolis", label: "Indianapolis" },
  { key: "louisville", label: "Louisville" },
  { key: "spokane", label: "Spokane" },
  { key: "lasvegas", label: "Las Vegas" },
  { key: "boise", label: "Boise" },
  { key: "kent", label: "Kent" },
  { key: "saltlakecity", label: "Salt Lake City" },
  { key: "newberlin", label: "New Berlin" },
];
const MONDELEZ_LOCATION_KEYS = new Set(MONDELEZ_LOCATIONS.map((l) => l.key));

export const mondelezState = {
  rowsByDate: {},          // dateKey -> Row[] (every location, filtered client-side for display)
  datesWithData: new Set(),
  activeTab: "morris",     // a location key, or "combined"
};

let mondelezRateSettings = null; // { [locationKey]: { daily_rate, stop_rate, over_mileage_threshold, over_mileage_rate } }

/* ---------------- data model ---------------- */

function blankMondelezRow(locationKey) {
  return {
    id: uid("mdz"), dbId: null,
    location: locationKey || mondelezState.activeTab,
    aljexNumber: "", deliveryGroup: "", startTime: "",
    driverAppId: "", trailerNumber: "", returnTrailerNumber: "",
    stopCount: "", notes: "",
    driverId: null, driverName: "",
    miles: "", carrierRpm: "", carrierPayPerStop: "", carrierPay: "",
    fsc: "", additionalCharges: "", revenueTotal: "", revenueManual: false,
    routeImagePath: "", routeImageUrl: "",
    tonu: false, highlighted: false, shiftComplete: false, selected: false,
    createdAt: null, updatedAt: null, addedAt: null,
  };
}

function mondelezRowToDbRow(row, dKey) {
  return {
    location: row.location,
    shift_date: dKey,
    aljex_number: row.aljexNumber || null,
    delivery_group: row.deliveryGroup || null,
    start_time: row.startTime || null,
    driver_app_id: row.driverAppId || null,
    trailer_number: row.trailerNumber || null,
    return_trailer_number: row.returnTrailerNumber || null,
    stop_count: row.stopCount !== "" && row.stopCount != null ? Number(row.stopCount) : null,
    notes: row.notes || null,
    driver_id: row.driverId ? Number(row.driverId) : null,
    driver_name: row.driverName || null,
    miles: row.miles !== "" && row.miles != null ? Number(row.miles) : null,
    carrier_rpm: row.carrierRpm !== "" && row.carrierRpm != null ? Number(row.carrierRpm) : null,
    carrier_pay_per_stop: row.carrierPayPerStop !== "" && row.carrierPayPerStop != null ? Number(row.carrierPayPerStop) : null,
    carrier_pay: row.carrierPay !== "" && row.carrierPay != null ? Number(row.carrierPay) : null,
    fsc: row.fsc !== "" && row.fsc != null ? Number(row.fsc) : null,
    additional_charges: row.additionalCharges !== "" && row.additionalCharges != null ? Number(row.additionalCharges) : null,
    revenue_total: row.revenueTotal !== "" && row.revenueTotal != null ? Number(row.revenueTotal) : null,
    revenue_manual: !!row.revenueManual,
    route_image_path: row.routeImagePath || null,
    tonu: !!row.tonu,
    highlighted: !!row.highlighted,
    shift_complete: !!row.shiftComplete,
  };
}

function mondelezRowFromDbRow(r) {
  return {
    id: uid("mdz"), dbId: r.id,
    location: r.location,
    aljexNumber: r.aljex_number || "", deliveryGroup: r.delivery_group || "", startTime: r.start_time || "",
    driverAppId: r.driver_app_id || "", trailerNumber: r.trailer_number || "", returnTrailerNumber: r.return_trailer_number || "",
    stopCount: r.stop_count != null ? String(r.stop_count) : "", notes: r.notes || "",
    driverId: r.driver_id != null ? String(r.driver_id) : null, driverName: r.driver_name || "",
    miles: r.miles != null ? String(r.miles) : "",
    carrierRpm: r.carrier_rpm != null ? String(r.carrier_rpm) : "",
    carrierPayPerStop: r.carrier_pay_per_stop != null ? String(r.carrier_pay_per_stop) : "",
    carrierPay: r.carrier_pay != null ? String(r.carrier_pay) : "",
    fsc: r.fsc != null ? String(r.fsc) : "",
    additionalCharges: r.additional_charges != null ? String(r.additional_charges) : "",
    revenueTotal: r.revenue_total != null ? String(r.revenue_total) : "",
    revenueManual: !!r.revenue_manual,
    routeImagePath: r.route_image_path || "",
    routeImageUrl: r.route_image_path && supabaseClient ? supabaseClient.storage.from(MONDELEZ_IMAGE_BUCKET).getPublicUrl(r.route_image_path).data.publicUrl : "",
    tonu: !!r.tonu, highlighted: !!r.highlighted, shiftComplete: !!r.shift_complete, selected: false,
    createdAt: r.created_at || null, updatedAt: r.updated_at || null, addedAt: null,
  };
}

/* ---------------- rate settings + revenue calc ---------------- */

export async function loadMondelezRateSettings() {
  if (!supabaseClient) return;
  const { data, error } = await supabaseClient.from(MONDELEZ_RATE_SETTINGS_TABLE).select("*");
  if (error) { console.error("Failed to load Mondelez rate settings:", error); return; }
  mondelezRateSettings = {};
  (data || []).forEach((r) => { mondelezRateSettings[r.location] = r; });
}
export function getMondelezRateSettings(locationKey) {
  return (mondelezRateSettings && mondelezRateSettings[locationKey]) || {
    daily_rate: 0, stop_rate: 0, over_mileage_threshold: 0, over_mileage_rate: 0,
  };
}
export async function saveMondelezRateSetting(locationKey, field, value) {
  if (!supabaseClient) return false;
  const payload = { location: locationKey, [field]: value };
  const { data: existing } = await supabaseClient.from(MONDELEZ_RATE_SETTINGS_TABLE).select("id").eq("location", locationKey);
  let error;
  if (existing && existing.length) {
    ({ error } = await supabaseClient.from(MONDELEZ_RATE_SETTINGS_TABLE).update(payload).eq("id", existing[0].id));
  } else {
    ({ error } = await supabaseClient.from(MONDELEZ_RATE_SETTINGS_TABLE).insert(payload));
  }
  if (error) { console.error("Failed to save Mondelez rate setting:", error); return false; }
  if (!mondelezRateSettings) mondelezRateSettings = {};
  mondelezRateSettings[locationKey] = { ...(mondelezRateSettings[locationKey] || {}), [field]: value };
  return true;
}

// Verified against your rate card: Daily Rate + (Stops x Stop Rate) +
// (Miles over threshold x Over-Mileage Rate) + FSC (+ any Additional
// Charges you note for Detention/Layover/TONU, which aren't part of
// the formula above since I couldn't confirm those from the card).
export function calcMondelezRevenue(row) {
  const s = getMondelezRateSettings(row.location);
  const dailyRate = Number(s.daily_rate) || 0;
  const stopRate = Number(s.stop_rate) || 0;
  const overThreshold = Number(s.over_mileage_threshold) || 0;
  const overRate = Number(s.over_mileage_rate) || 0;
  const miles = parseFloat(row.miles) || 0;
  const stops = parseInt(row.stopCount, 10) || 0;
  const fsc = parseFloat(row.fsc) || 0;
  const additional = parseFloat(row.additionalCharges) || 0;

  const stopCharge = Math.round(stops * stopRate * 100) / 100;
  const overMiles = Math.max(0, miles - overThreshold);
  const overCharge = Math.round(overMiles * overRate * 100) / 100;
  const total = Math.round((dailyRate + stopCharge + overCharge + fsc + additional) * 100) / 100;

  return {
    total,
    lines: [
      { label: "Daily Rate", amount: dailyRate },
      { label: `Stops (${stops} × $${stopRate})`, amount: stopCharge },
      { label: overMiles > 0 ? `Over Mileage (${overMiles.toFixed(1)}mi × $${overRate})` : "Over Mileage (within threshold)", amount: overCharge },
      { label: "FSC", amount: fsc },
      { label: "Additional Charges", amount: additional },
    ],
  };
}

function recomputeMondelezRevenue(row) {
  if (row.revenueManual) return;
  const { total } = calcMondelezRevenue(row);
  const next = total ? String(total) : "";
  if (row.revenueTotal === next) return;
  row.revenueTotal = next;
  scheduleMondelezRowSave(row);
  const el = document.querySelector(`input[data-mdz-row="${row.id}"][data-mdz-field="revenueTotal"]`);
  if (el && document.activeElement !== el) el.value = next;
}

/* ---------------- fetch / cache ---------------- */

function getMondelezRowsForDate(dKey) {
  if (!mondelezState.rowsByDate[dKey]) mondelezState.rowsByDate[dKey] = [];
  return mondelezState.rowsByDate[dKey];
}
function getMondelezDisplayRows(dKey) {
  const rows = getMondelezRowsForDate(dKey);
  if (mondelezState.activeTab === "combined") return rows;
  return rows.filter((r) => r.location === mondelezState.activeTab);
}

async function ensureMondelezDateLoaded(dKey) {
  if (mondelezState.rowsByDate[dKey]) return;
  if (!supabaseClient) { mondelezState.rowsByDate[dKey] = []; return; }
  const { data, error } = await supabaseClient.from(MONDELEZ_TABLE).select("*").eq("shift_date", dKey);
  if (error) {
    console.error("Failed to load Mondelez loads:", error);
    setDriverSyncStatus(`Couldn't load Mondelez loads for this day (${error.message}).`, "error");
    mondelezState.rowsByDate[dKey] = [];
    return;
  }
  mondelezState.rowsByDate[dKey] = (data || []).map(mondelezRowFromDbRow);
}

export async function loadMondelezDatesWithData() {
  if (!supabaseClient) return;
  const { data, error } = await supabaseClient
    .from(MONDELEZ_TABLE).select("shift_date")
    .gte("shift_date", state.minDate).lte("shift_date", state.maxDate);
  if (error) { console.error("Failed to load Mondelez date-availability info:", error); return; }
  mondelezState.datesWithData = new Set((data || []).map((r) => r.shift_date));
}

async function saveMondelezRowNow(row) {
  if (!supabaseClient) return null;
  try {
    const payload = mondelezRowToDbRow(row, state.activeDate);
    if (row.dbId) {
      const { error } = await supabaseClient.from(MONDELEZ_TABLE).update(payload).eq("id", row.dbId);
      if (error) { console.error("Failed to save Mondelez row:", error); setDriverSyncStatus(`Couldn't save this load (${error.message}).`, "error"); return null; }
      return row.dbId;
    }
    const { data, error } = await supabaseClient.from(MONDELEZ_TABLE).insert(payload).select();
    if (error) { console.error("Failed to create Mondelez row:", error); setDriverSyncStatus(`Couldn't save this load (${error.message}).`, "error"); return null; }
    row.dbId = data[0].id;
    return row.dbId;
  } catch (e) {
    console.error("saveMondelezRowNow threw:", e);
    return null;
  }
}
const mondelezSaveTimers = new Map();
function scheduleMondelezRowSave(row) {
  clearTimeout(mondelezSaveTimers.get(row.id));
  mondelezSaveTimers.set(row.id, setTimeout(() => saveMondelezRowNow(row), SAVE_DEBOUNCE_MS));
}

/* ---------------- rendering ---------------- */

function mondelezLocationLabel(key) {
  const loc = MONDELEZ_LOCATIONS.find((l) => l.key === key);
  return loc ? loc.label : key;
}

function mondelezRowHtml(row) {
  const drv = row.driverId ? findDriver(row.driverId) : null;
  const displayName = drv ? drv.name : row.driverName;
  const showLocationCol = mondelezState.activeTab === "combined";
  const rowClasses = [row.tonu ? "is-tonu" : "", row.highlighted ? "is-row-pinned" : "", row.addedAt ? "is-new" : ""].join(" ");
  return `<tr id="${row.id}" class="${rowClasses}">
    <td class="pin pin-select"><input type="checkbox" class="chk" data-action="toggle-mdz-select" data-mdz-row="${row.id}" ${row.selected ? "checked" : ""} title="Select"></td>
    <td class="pin pin-text"><button class="text-btn" data-action="text-mdz-driver" data-mdz-row="${row.id}" title="Text this driver">Text</button></td>
    ${showLocationCol ? `<td class="col-mdz-location"><span class="static-text">${escapeHtml(mondelezLocationLabel(row.location))}</span></td>` : ""}
    <td class="pin pin-pro${row.shiftComplete ? " shift-complete-tint" : ""}"><input class="cell-input" placeholder="Aljex#" data-mdz-row="${row.id}" data-mdz-field="aljexNumber" value="${escapeHtml(row.aljexNumber)}"></td>
    <td class="col-mdz-group"><input class="cell-input" placeholder="Delivery Group" data-mdz-row="${row.id}" data-mdz-field="deliveryGroup" value="${escapeHtml(row.deliveryGroup)}"></td>
    <td class="pin pin-driver">
      <div class="driver-name-wrap"><input class="cell-input" list="driverNamesList" placeholder="Type driver name…" data-mdz-row="${row.id}" data-mdz-field="driverName" value="${escapeHtml(displayName)}"></div>
    </td>
    <td class="col-cell"><span class="static-text">${escapeHtml(pick(drv && drv.phone, ""))}</span></td>
    <td class="col-shiftStart"><input class="cell-input small" style="width:52px;" placeholder="--:--" data-mdz-row="${row.id}" data-mdz-field="startTime" value="${escapeHtml(row.startTime)}"></td>
    <td class="col-mdz-driverapp"><input class="cell-input small" data-mdz-row="${row.id}" data-mdz-field="driverAppId" value="${escapeHtml(row.driverAppId)}"></td>
    <td class="col-mdz-trailer"><input class="cell-input small" data-mdz-row="${row.id}" data-mdz-field="trailerNumber" value="${escapeHtml(row.trailerNumber)}"></td>
    <td class="col-mdz-trailer"><input class="cell-input small" placeholder="Return #" data-mdz-row="${row.id}" data-mdz-field="returnTrailerNumber" value="${escapeHtml(row.returnTrailerNumber)}"></td>
    <td class="col-mdz-miles"><input class="cell-input small" style="width:52px;" inputmode="decimal" data-mdz-row="${row.id}" data-mdz-field="miles" value="${escapeHtml(row.miles)}"></td>
    <td class="col-mdz-stops"><input class="cell-input small" style="width:40px;" inputmode="numeric" data-mdz-row="${row.id}" data-mdz-field="stopCount" value="${escapeHtml(row.stopCount)}"></td>
    <td class="col-mdz-carrierpay"><input class="cell-input small" style="width:64px;" placeholder="Carrier Pay" data-mdz-row="${row.id}" data-mdz-field="carrierPay" value="${escapeHtml(row.carrierPay)}"></td>
    <td class="col-mdz-fsc"><input class="cell-input small" style="width:52px;" placeholder="FSC" data-mdz-row="${row.id}" data-mdz-field="fsc" value="${escapeHtml(row.fsc)}"></td>
    <td class="col-mdz-additional"><input class="cell-input small" style="width:60px;" placeholder="Detention/etc" data-mdz-row="${row.id}" data-mdz-field="additionalCharges" value="${escapeHtml(row.additionalCharges)}"></td>
    <td class="col-mdz-revenue"><input class="cell-input small" style="width:70px; font-weight:800;" data-mdz-row="${row.id}" data-mdz-field="revenueTotal" value="${escapeHtml(row.revenueTotal)}" title="${row.revenueManual ? "Manually overridden" : "Auto-calculated"}"></td>
    <td class="col-mdz-notes"><input class="cell-input" placeholder="Status / Notes" data-mdz-row="${row.id}" data-mdz-field="notes" value="${escapeHtml(row.notes)}"></td>
    <td class="col-mdz-image">
      ${row.routeImageUrl
        ? `<button type="button" class="btn btn-ghost" style="padding:3px 8px; font-size:10.5px;" data-action="view-route-image" data-mdz-row="${row.id}">View Route</button>`
        : `<label class="btn btn-ghost" style="padding:3px 8px; font-size:10.5px; cursor:pointer;">Upload<input type="file" accept="image/*" data-action="upload-route-image" data-mdz-row="${row.id}" style="display:none;"></label>`}
    </td>
    <td class="col-availRemove"><button type="button" class="available-remove-btn" data-action="delete-mdz-row" data-mdz-row="${row.id}" title="Delete">&times;</button></td>
  </tr>`;
}

function renderMondelezTable() {
  if (!$("#mondelez-table")) return;
  const rows = getMondelezDisplayRows(state.activeDate);
  const displayRows = [...rows].sort((a, b) => (a.shiftComplete ? 1 : 0) - (b.shiftComplete ? 1 : 0));
  const showLocationCol = mondelezState.activeTab === "combined";
  const thead = `<thead><tr>
    <th class="pin pin-select"><input type="checkbox" class="chk" id="mdz-select-all" title="Select all"></th>
    <th class="pin pin-text"></th>
    ${showLocationCol ? `<th class="col-mdz-location">Location</th>` : ""}
    <th class="pin pin-pro">Aljex #</th>
    <th class="col-mdz-group">Delivery Group</th>
    <th class="pin pin-driver">Driver</th>
    <th class="col-cell">Cell</th>
    <th class="col-shiftStart">Start</th>
    <th class="col-mdz-driverapp">Driver App ID</th>
    <th class="col-mdz-trailer">Trailer #</th>
    <th class="col-mdz-trailer">Return Trailer #</th>
    <th class="col-mdz-miles">Miles</th>
    <th class="col-mdz-stops">Stops</th>
    <th class="col-mdz-carrierpay">Carrier Pay</th>
    <th class="col-mdz-fsc">FSC</th>
    <th class="col-mdz-additional">Additional</th>
    <th class="col-mdz-revenue">Revenue</th>
    <th class="col-mdz-notes">Status / Notes</th>
    <th class="col-mdz-image">Route Image</th>
    <th class="col-availRemove"></th>
  </tr></thead>`;
  const addRowHtml = `<tr class="quick-add-row"><td colspan="${showLocationCol ? 20 : 19}"><button type="button" class="quick-add-btn" id="btn-mdz-add-row"><span class="quick-add-btn-label">+ Add Row</span></button></td></tr>`;
  $("#mondelez-table").innerHTML = thead + `<tbody>${displayRows.map(mondelezRowHtml).join("")}${addRowHtml}</tbody>`;
  const emptyState = $("#mondelez-empty-state");
  if (emptyState) emptyState.classList.toggle("hidden", rows.length > 0);
  refreshDriverDatalist();
}

function renderMondelezChrome() {
  const d = keyToDate(state.activeDate);
  const isToday = state.activeDate === state.todayKey;
  if ($("#mondelez-subtext")) $("#mondelez-subtext").textContent = d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" }) + (isToday ? " · today" : "");
  if ($("#date-input")) {
    $("#date-input").value = state.activeDate;
    $("#date-input").min = state.minDate;
    $("#date-input").max = state.maxDate;
    $("#date-next").disabled = state.activeDate >= state.maxDate;
    $("#date-prev").disabled = state.activeDate <= state.minDate;
  }
}

function renderMondelezTabs() {
  const wrap = $("#mondelez-location-tabs");
  if (!wrap) return;
  const allTabs = [...MONDELEZ_LOCATIONS, { key: "combined", label: "All Locations (combined)" }];
  wrap.innerHTML = allTabs.map((t) => `<button type="button" class="location-tab ${mondelezState.activeTab === t.key ? "is-active" : ""}" data-mdz-tab="${t.key}">${escapeHtml(t.label)}</button>`).join("");
}

function renderMondelezRateSettingsPanel() {
  const box = $("#mondelez-rate-panel");
  if (!box) return;
  if (mondelezState.activeTab === "combined") {
    box.innerHTML = `<div class="subtext">Pick a specific location tab to edit its rate card.</div>`;
    return;
  }
  const s = getMondelezRateSettings(mondelezState.activeTab);
  box.innerHTML = `
    <fieldset class="rate-section" style="display:inline-block; min-width:520px;">
      <legend class="rate-section-header">Rate — ${escapeHtml(mondelezLocationLabel(mondelezState.activeTab))}</legend>
      <div class="subtext" style="margin:-4px 0 10px;">Applies to every load at this location. FSC and Additional Charges are entered per load instead, since those vary.</div>
      <div class="rate-tier-grid" style="grid-template-columns: repeat(4, 1fr);">
        <fieldset class="rate-tier-box"><legend>Daily Rate</legend><input type="number" step="0.01" data-mdz-setting="daily_rate" value="${s.daily_rate || 0}"></fieldset>
        <fieldset class="rate-tier-box"><legend>$/Stop</legend><input type="number" step="0.01" data-mdz-setting="stop_rate" value="${s.stop_rate || 0}"></fieldset>
        <fieldset class="rate-tier-box"><legend>Mileage Threshold</legend><input type="number" step="1" data-mdz-setting="over_mileage_threshold" value="${s.over_mileage_threshold || 0}"></fieldset>
        <fieldset class="rate-tier-box"><legend>$/Mile Over</legend><input type="number" step="0.01" data-mdz-setting="over_mileage_rate" value="${s.over_mileage_rate || 0}"></fieldset>
      </div>
    </fieldset>`;
}

/* ---------------- image upload / view ---------------- */

async function uploadRouteImage(rowId, file) {
  const row = getMondelezRowsForDate(state.activeDate).find((r) => r.id === rowId);
  if (!row || !supabaseClient) return;
  if (!row.dbId) await saveMondelezRowNow(row); // needs a dbId before it can own a storage path
  if (!row.dbId) { setDriverSyncStatus("Couldn't save this load before uploading — try again.", "error"); return; }
  const path = `${row.dbId}/${Date.now()}_${file.name}`;
  try {
    const { error: upErr } = await supabaseClient.storage.from(MONDELEZ_IMAGE_BUCKET).upload(path, file);
    if (upErr) throw upErr;
    row.routeImagePath = path;
    row.routeImageUrl = supabaseClient.storage.from(MONDELEZ_IMAGE_BUCKET).getPublicUrl(path).data.publicUrl;
    await saveMondelezRowNow(row);
    renderMondelezTable();
  } catch (e) {
    console.error("uploadRouteImage failed:", e);
    setDriverSyncStatus(`Couldn't upload that image (${e.message || e}).`, "error");
  }
}

function viewRouteImage(rowId) {
  const row = getMondelezRowsForDate(state.activeDate).find((r) => r.id === rowId);
  if (!row || !row.routeImageUrl) return;
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  overlay.id = "mdz-image-overlay";
  overlay.innerHTML = `
    <div class="modal" style="width:auto; max-width:92vw;">
      <div class="modal-header"><h3>Route — ${escapeHtml(row.aljexNumber || "")}</h3><button class="modal-close" id="mdz-image-close">&times;</button></div>
      <div class="modal-body" style="text-align:center;"><img src="${escapeHtml(row.routeImageUrl)}" style="max-width:100%; max-height:75vh; border-radius:6px;"></div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  $("#mdz-image-close").addEventListener("click", close);
}

/* ---------------- row actions ---------------- */

function quickAddMondelezRow() {
  const row = blankMondelezRow(mondelezState.activeTab === "combined" ? MONDELEZ_LOCATIONS[0].key : mondelezState.activeTab);
  row.addedAt = Date.now();
  getMondelezRowsForDate(state.activeDate).push(row);
  renderMondelezTable();
}

async function deleteMondelezRow(rowId) {
  const rows = getMondelezRowsForDate(state.activeDate);
  const row = rows.find((r) => r.id === rowId);
  if (!row) return;
  if (!confirm(`Delete this Mondelez load${row.aljexNumber ? ` (${row.aljexNumber})` : ""}? This can't be undone.`)) return;
  const idx = rows.findIndex((r) => r.id === rowId);
  if (idx !== -1) rows.splice(idx, 1);
  renderMondelezTable();
  if (row.dbId && supabaseClient) {
    try { await supabaseClient.from(MONDELEZ_TABLE).delete().eq("id", row.dbId); }
    catch (e) { console.error("deleteMondelezRow failed:", e); }
  }
}

function textMondelezDriverForRow(rowId) {
  const row = getMondelezRowsForDate(state.activeDate).find((r) => r.id === rowId);
  if (!row) return;
  const drv = row.driverId ? findDriver(row.driverId) : null;
  textDriverPhone(drv ? drv.phone : null);
}

/* ---------------- tab + date switching ---------------- */

export function switchMondelezTab(tabKey) {
  mondelezState.activeTab = tabKey;
  renderMondelezTabs();
  renderMondelezRateSettingsPanel();
  renderMondelezTable();
}

export async function loadAndRenderMondelez() {
  renderMondelezChrome();
  await ensureMondelezDateLoaded(state.activeDate);
  renderMondelezTable();
}

export function setMondelezActiveDate(newKey) {
  if (newKey < state.minDate || newKey > state.maxDate) return;
  state.activeDate = newKey;
  loadAndRenderMondelez();
}

/* ---------------- realtime ---------------- */

function handleRealtimeMondelezChange(payload) {
  if (payload.eventType === "DELETE") return;
  const dbRow = payload.new;
  if (!dbRow) return;
  if (dbRow.shift_date >= state.minDate && dbRow.shift_date <= state.maxDate) mondelezState.datesWithData.add(dbRow.shift_date);
  if (dbRow.shift_date !== state.activeDate) return;
  const rows = mondelezState.rowsByDate[state.activeDate];
  if (!rows) return;
  const existing = rows.find((r) => r.dbId === dbRow.id);
  if (!existing) { rows.push(mondelezRowFromDbRow(dbRow)); renderMondelezTable(); return; }
  const tr = document.getElementById(existing.id);
  const activeEl = document.activeElement;
  const domField = (tr && tr.contains(activeEl)) ? activeEl.dataset.mdzField : null;
  const preserved = domField ? existing[domField] : undefined;
  Object.assign(existing, mondelezRowFromDbRow(dbRow), { id: existing.id, selected: existing.selected });
  if (domField) existing[domField] = preserved;
  renderMondelezTable();
}

function setupMondelezRealtimeSync() {
  if (!supabaseClient) return;
  const channel = supabaseClient.channel("mondelez");
  channel.on("postgres_changes", { event: "*", schema: "public", table: MONDELEZ_TABLE }, handleRealtimeMondelezChange);
  channel.on("postgres_changes", { event: "*", schema: "public", table: "atlanta_drivers" }, handleRealtimeDriverChange);
  channel.subscribe();
}

/* ---------------- init ---------------- */

export async function initMondelezPage() {
  state.activeLocation = "mondelez";
  await loadMondelezRateSettings();
  loadAndRenderMondelez();
  setupMondelezRealtimeSync();
  loadMondelezDatesWithData().catch((e) => console.error("loadMondelezDatesWithData() failed:", e));
  renderMondelezTabs();
  renderMondelezRateSettingsPanel();

  $("#mondelez-location-tabs").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-mdz-tab]");
    if (btn) switchMondelezTab(btn.dataset.mdzTab);
  });

  $("#date-prev").addEventListener("click", () => setMondelezActiveDate(dateKey(addDays(keyToDate(state.activeDate), -1))));
  $("#date-next").addEventListener("click", () => setMondelezActiveDate(dateKey(addDays(keyToDate(state.activeDate), 1))));
  $("#date-input").addEventListener("change", (e) => setMondelezActiveDate(e.target.value));
  $("#date-input").addEventListener("click", (e) => {
    e.preventDefault();
    resetCalendarViewMonth();
    renderCalendarGrid(mondelezState.datesWithData);
    $("#date-dropdown").classList.remove("hidden");
  });
  $("#date-today").addEventListener("click", () => setMondelezActiveDate(state.todayKey));
  $("#date-dropdown").addEventListener("click", (e) => {
    const btn = e.target.closest(".cal-cell[data-date]:not(:disabled)");
    if (btn) { setMondelezActiveDate(btn.dataset.date); closeDateDropdown(); }
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#date-dropdown") && !e.target.closest("#date-input")) closeDateDropdown();
  });

  $("#mondelez-rate-panel").addEventListener("change", (e) => {
    const key = e.target.dataset.mdzSetting;
    if (!key) return;
    const val = Number(e.target.value) || 0;
    saveMondelezRateSetting(mondelezState.activeTab, key, val).then(() => {
      getMondelezRowsForDate(state.activeDate).forEach((r) => { if (r.location === mondelezState.activeTab) recomputeMondelezRevenue(r); });
    });
  });

  const table = $("#mondelez-table");
  table.addEventListener("click", (e) => {
    if (e.target.closest("#btn-mdz-add-row")) quickAddMondelezRow();
    const delBtn = e.target.closest("[data-action='delete-mdz-row']");
    if (delBtn) deleteMondelezRow(delBtn.dataset.mdzRow);
    const viewBtn = e.target.closest("[data-action='view-route-image']");
    if (viewBtn) viewRouteImage(viewBtn.dataset.mdzRow);
    const textBtn = e.target.closest("[data-action='text-mdz-driver']");
    if (textBtn) textMondelezDriverForRow(textBtn.dataset.mdzRow);
  });
  table.addEventListener("change", (e) => {
    const t = e.target;
    if (t.id === "mdz-select-all") {
      getMondelezDisplayRows(state.activeDate).forEach((r) => { r.selected = t.checked; });
      renderMondelezTable();
      return;
    }
    if (t.dataset.action === "toggle-mdz-select") {
      const row = getMondelezRowsForDate(state.activeDate).find((r) => r.id === t.dataset.mdzRow);
      if (row) row.selected = t.checked;
      return;
    }
    if (t.dataset.action === "upload-route-image" && t.files && t.files[0]) {
      uploadRouteImage(t.dataset.mdzRow, t.files[0]);
    }
  });
  table.addEventListener("input", (e) => {
    const t = e.target;
    const rowId = t.dataset.mdzRow;
    const field = t.dataset.mdzField;
    if (!rowId || !field) return;
    const row = getMondelezRowsForDate(state.activeDate).find((r) => r.id === rowId);
    if (!row) return;

    if (field === "driverName") {
      row.driverName = t.value;
      row.driverId = null;
      const match = driversForLocation("atlanta").find((d) => d.name.toLowerCase() === t.value.trim().toLowerCase());
      if (match) row.driverId = match.id;
      scheduleMondelezRowSave(row);
      return;
    }
    if (field === "revenueTotal") {
      row.revenueTotal = t.value;
      row.revenueManual = t.value.trim() !== "";
      scheduleMondelezRowSave(row);
      return;
    }
    row[field] = t.value;
    scheduleMondelezRowSave(row);
    if (field === "miles" || field === "stopCount" || field === "fsc" || field === "additionalCharges") recomputeMondelezRevenue(row);
  });

  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeContextMenu(); });
}