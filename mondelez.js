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
  SAVE_DEBOUNCE_MS, escapeHtml, $, $all, keyToDate, addDays, dateKey, on,
  refreshDriverDatalist, closeDateDropdown, renderCalendarGrid, resetCalendarViewMonth,
  closeContextMenu, handleRealtimeDriverChange, pick, textDriverPhone, openAddDriverModal,
  openDriverAutocomplete, updateDriverAutocomplete, closeDriverAutocomplete, captureFocusForRerender,
  handleRowAwareTab, openEditDriverModal, batchSignImageUrls,
  openLocationNotesModal, closeLocationNotesModal, saveLocationNotes,
} from './loadboard.js';

export const MONDELEZ_TABLE = "mondelez_loads";
export const MONDELEZ_RATE_SETTINGS_TABLE = "mondelez_rate_settings";
export const MONDELEZ_IMAGE_BUCKET = "mondelez-routes";

// Best-cleanup pass of the locations in your spreadsheet — combined
// "shuttle" entries like "Morris/Franksville" get filed under the
// origin DC that dispatches them (Morris), since a load only lives on
// one tab. Say the word if any of these should split further.
export const MONDELEZ_LOCATIONS = [
  { key: "westchester", label: "West Chester" },
  { key: "morris", label: "Morris" },
  { key: "addison", label: "Addison" },
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
  activeTab: "westchester", // a location key, or "combined"
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
    routeImageUrl: "", // filled in by batchSignImageUrls after loading — see ensureMondelezDateLoaded
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
  const rows = (data || []).map(mondelezRowFromDbRow);
  const imagePaths = [];
  const imageTargets = [];
  rows.forEach((row) => { if (row.routeImagePath) { imagePaths.push(row.routeImagePath); imageTargets.push(row); } });
  await batchSignImageUrls(MONDELEZ_IMAGE_BUCKET, imagePaths, imageTargets);
  mondelezState.rowsByDate[dKey] = rows;
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

// Right-click a row to move it to a different Mondelez location tab (e.g. a
// load built under the wrong tab by mistake) without having to delete and
// recreate it — everything on the row carries over, only the location changes.
function openMondelezRowContextMenu(rowId, x, y) {
  closeContextMenu();
  const row = getMondelezRowsForDate(state.activeDate).find((r) => r.id === rowId);
  if (!row) return;
  const items = [
    { label: row.tonu ? "Un-TONU" : "TONU", action: () => toggleMondelezTonu(rowId) },
    { label: row.highlighted ? "Remove Highlight" : "Highlight", action: () => toggleMondelezHighlight(rowId) },
    { label: row.shiftComplete ? "Mark Shift Incomplete" : "Shift Complete", action: () => toggleMondelezShiftComplete(rowId) },
    { label: "Load Details", action: () => openMondelezLoadDetailsModal(rowId) },
    { label: "Text Now", action: () => textMondelezDriverForRow(rowId) },
    { label: "Email Now", action: () => emailMondelezRouteInfo(rowId) },
    { label: "Delete", action: () => deleteMondelezRow(rowId), danger: true },
  ];
  const menu = document.createElement("div");
  menu.className = "row-context-menu";
  menu.id = "row-context-menu";
  menu.innerHTML = items.map((it, i) => `<button class="context-menu-item${it.danger ? " context-menu-item-danger" : ""}" data-idx="${i}">${it.label}</button>`).join("");
  document.body.appendChild(menu);
  menu.style.left = x + "px";
  menu.style.top = y + "px";
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = Math.max(4, window.innerWidth - rect.width - 8) + "px";
  if (rect.bottom > window.innerHeight) menu.style.top = Math.max(4, window.innerHeight - rect.height - 8) + "px";
  $all(".context-menu-item", menu).forEach((btn, i) => {
    btn.addEventListener("click", () => { items[i].action(); closeContextMenu(); });
  });
}

function moveMondelezRowToLocation(rowId, newLocationKey) {
  const row = getMondelezRowsForDate(state.activeDate).find((r) => r.id === rowId);
  if (!row) return;
  row.location = newLocationKey;
  saveMondelezRowNow(row);
  renderMondelezTable(); // the row now belongs to a different tab, so it drops out of the current view
}

function toggleMondelezTonu(rowId) {
  const row = getMondelezRowsForDate(state.activeDate).find((r) => r.id === rowId);
  if (!row) return;
  row.tonu = !row.tonu;
  const tr = document.getElementById(rowId);
  if (tr) tr.classList.toggle("is-tonu", row.tonu);
  saveMondelezRowNow(row);
}
function toggleMondelezHighlight(rowId) {
  const row = getMondelezRowsForDate(state.activeDate).find((r) => r.id === rowId);
  if (!row) return;
  row.highlighted = !row.highlighted;
  const tr = document.getElementById(rowId);
  if (tr) tr.classList.toggle("is-row-pinned", row.highlighted);
  saveMondelezRowNow(row);
}
function toggleMondelezShiftComplete(rowId) {
  const row = getMondelezRowsForDate(state.activeDate).find((r) => r.id === rowId);
  if (!row) return;
  row.shiftComplete = !row.shiftComplete;
  saveMondelezRowNow(row);
  renderMondelezTable(); // completed rows sort to the bottom
}

function mondelezRowHtml(row) {
  const drv = row.driverId ? findDriver(row.driverId) : null;
  const displayName = drv ? drv.name : row.driverName;
  const showLocationCol = mondelezState.activeTab === "combined";
  const rowClasses = [row.tonu ? "is-tonu" : "", row.highlighted ? "is-row-pinned" : "", row.addedAt ? "is-new" : ""].join(" ");
  return `<tr id="${row.id}" class="${rowClasses}">
    <td class="pin pin-select"><input type="checkbox" class="chk" data-action="toggle-mdz-select" data-mdz-row="${row.id}" ${row.selected ? "checked" : ""} title="Select"></td>
    <td class="pin pin-text">
      <button class="text-btn" data-action="text-mdz-driver" data-mdz-row="${row.id}" title="Text this driver">Text</button>
      ${MDZ_EMAIL_LOCATIONS.has(row.location) ? `<button class="text-btn" data-action="email-mdz-driver" data-mdz-row="${row.id}" title="Email route info">Email</button>` : ""}
    </td>
    ${showLocationCol ? `<td class="col-mdz-location"><span class="static-text">${escapeHtml(mondelezLocationLabel(row.location))}</span></td>` : ""}
    <td class="pin pin-pro${row.shiftComplete ? " shift-complete-tint" : ""}"><div class="cell-with-link"><input class="cell-input" placeholder="Aljex#" data-mdz-row="${row.id}" data-mdz-field="aljexNumber" value="${escapeHtml(row.aljexNumber)}">${row.aljexNumber ? `<button type="button" class="cell-link-btn" data-open-mdz-load="${row.id}" title="Open load details">↗</button>` : ""}</div></td>
    <td class="pin pin-driver">
      <div class="driver-name-wrap"><input class="cell-input" data-driver-ac="true" placeholder="Type driver name…" data-mdz-row="${row.id}" data-mdz-field="driverName" value="${escapeHtml(displayName)}"></div>
    </td>
    <td class="col-cell"><span class="static-text">${escapeHtml(pick(drv && drv.phone, ""))}</span></td>
    <td class="col-shiftStart"><input class="cell-input small" style="width:52px;" placeholder="--:--" data-mdz-row="${row.id}" data-mdz-field="startTime" value="${escapeHtml(row.startTime)}"></td>
    <td class="col-mdz-group"><input class="cell-input small" style="width:88px;" placeholder="DG#" data-mdz-row="${row.id}" data-mdz-field="deliveryGroup" value="${escapeHtml(row.deliveryGroup)}"></td>
    <td class="col-mdz-driverapp"><input class="cell-input small" data-mdz-row="${row.id}" data-mdz-field="driverAppId" inputmode="numeric" maxlength="9" placeholder="9-digit ID" value="${escapeHtml(row.driverAppId)}"></td>
    <td class="col-mdz-trailer"><input class="cell-input small" data-mdz-row="${row.id}" data-mdz-field="trailerNumber" value="${escapeHtml(row.trailerNumber)}"></td>
    <td class="col-mdz-trailer"><input class="cell-input small" placeholder="Return #" data-mdz-row="${row.id}" data-mdz-field="returnTrailerNumber" value="${escapeHtml(row.returnTrailerNumber)}"></td>
    <td class="col-mdz-miles"><input class="cell-input small" style="width:52px;" inputmode="decimal" data-mdz-row="${row.id}" data-mdz-field="miles" value="${escapeHtml(row.miles)}"></td>
    <td class="col-mdz-stops"><input class="cell-input small" style="width:40px;" inputmode="numeric" data-mdz-row="${row.id}" data-mdz-field="stopCount" value="${escapeHtml(row.stopCount)}"></td>
    <td class="col-mdz-fsc"><input class="cell-input small" style="width:52px;" placeholder="FSC" data-mdz-row="${row.id}" data-mdz-field="fsc" value="${escapeHtml(row.fsc)}"></td>
    <td class="col-mdz-revenue"><input class="cell-input small" style="width:70px; font-weight:800;" data-mdz-row="${row.id}" data-mdz-field="revenueTotal" value="${escapeHtml(row.revenueTotal)}" title="${row.revenueManual ? "Manually overridden" : "Auto-calculated"}"></td>
    <td class="col-mdz-carrierpay"><input class="cell-input small" style="width:64px;" placeholder="Carrier Pay" data-mdz-row="${row.id}" data-mdz-field="carrierPay" value="${escapeHtml(row.carrierPay)}"></td>
    <td class="col-mdz-notes"><input class="cell-input" placeholder="Status / Notes" data-mdz-row="${row.id}" data-mdz-field="notes" value="${escapeHtml(row.notes)}"></td>
    <td class="col-mdz-image">
      <div class="mdz-image-dropzone" tabindex="0" data-action="image-dropzone" data-mdz-row="${row.id}" title="Click to browse, or drag/paste an image here">
        ${row.routeImageUrl
          ? `<div class="mdz-thumb-wrap">
               <img src="${escapeHtml(row.routeImageUrl)}" class="mdz-route-thumb" data-action="view-route-image" data-mdz-row="${row.id}" alt="Route image" title="Click to view full size">
               <button type="button" class="mdz-thumb-delete" data-action="delete-route-image" data-mdz-row="${row.id}" title="Delete image">&times;</button>
             </div>`
          : `<span class="mdz-upload-hint">Drop / paste / click</span>`}
        <input type="file" accept="image/*" data-action="upload-route-image" data-mdz-row="${row.id}" class="mdz-hidden-file-input">
      </div>
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
    <th class="pin pin-select"><div id="mdz-select-count" class="board-select-count"></div><input type="checkbox" class="chk" id="mdz-select-all" title="Select all"></th>
    <th class="pin pin-text"></th>
    ${showLocationCol ? `<th class="col-mdz-location">Location</th>` : ""}
    <th class="pin pin-pro">Aljex #</th>
    <th class="pin pin-driver">Driver</th>
    <th class="col-cell">Cell</th>
    <th class="col-shiftStart">Start</th>
    <th class="col-mdz-group">DG#</th>
    <th class="col-mdz-driverapp">Driver App ID</th>
    <th class="col-mdz-trailer">Trailer #</th>
    <th class="col-mdz-trailer">Return Trailer #</th>
    <th class="col-mdz-miles">Miles</th>
    <th class="col-mdz-stops">Stops</th>
    <th class="col-mdz-fsc">FSC</th>
    <th class="col-mdz-revenue">Revenue</th>
    <th class="col-mdz-carrierpay">Carrier Pay</th>
    <th class="col-mdz-notes">Status / Notes</th>
    <th class="col-mdz-image">Route Image</th>
    <th class="col-availRemove"></th>
  </tr></thead>`;
  const addRowHtml = `<tr class="quick-add-row"><td colspan="${showLocationCol ? 19 : 18}"><button type="button" class="quick-add-btn" id="btn-mdz-add-row"><span class="quick-add-btn-label">+ Add Row</span></button></td></tr>`;
  $("#mondelez-table").innerHTML = thead + `<tbody>${displayRows.map(mondelezRowHtml).join("")}${addRowHtml}</tbody>`;
  const emptyState = $("#mondelez-empty-state");
  if (emptyState) emptyState.classList.toggle("hidden", rows.length > 0);
  refreshDriverDatalist();
  updateMondelezSelectCount();
}

function updateMondelezSelectCount() {
  const el = $("#mdz-select-count");
  if (!el) return;
  const rows = getMondelezDisplayRows(state.activeDate);
  const selectedCount = rows.filter((r) => r.selected).length;
  el.textContent = `Count ${rows.length} (${selectedCount} selected)`;
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
    const { data: signed, error: signErr } = await supabaseClient.storage.from(MONDELEZ_IMAGE_BUCKET).createSignedUrl(path, 3600);
    if (signErr) throw signErr;
    row.routeImageUrl = signed.signedUrl;
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
  overlay.className = "overlay image-lightbox-overlay";
  overlay.id = "mdz-image-overlay";
  overlay.innerHTML = `
    <div class="modal image-lightbox-content">
      <div class="modal-header"><h3>Route — ${escapeHtml(row.aljexNumber || "")}</h3><button class="modal-close" id="mdz-image-close">&times;</button></div>
      <div class="modal-body" style="text-align:center; padding:12px;"><img src="${escapeHtml(row.routeImageUrl)}" alt="Route image"></div>
      <div class="modal-footer"><button type="button" class="btn btn-ghost" id="mdz-image-delete" style="color:#b91c1c; border-color:#b91c1c;">Delete Image</button></div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  $("#mdz-image-close").addEventListener("click", close);
  $("#mdz-image-delete").addEventListener("click", async () => {
    if (!confirm("Delete this route image? This can't be undone.")) return;
    close();
    await deleteRouteImage(rowId);
  });
  document.addEventListener("keydown", function escHandler(e) {
    if (e.key === "Escape") { close(); document.removeEventListener("keydown", escHandler); }
  });
}

async function deleteRouteImage(rowId) {
  const row = getMondelezRowsForDate(state.activeDate).find((r) => r.id === rowId);
  if (!row || !row.routeImageUrl) return;
  const oldPath = row.routeImagePath;
  row.routeImagePath = "";
  row.routeImageUrl = "";
  renderMondelezTable();
  try {
    if (oldPath && supabaseClient) {
      const { error } = await supabaseClient.storage.from(MONDELEZ_IMAGE_BUCKET).remove([oldPath]);
      if (error) throw error;
    }
    await saveMondelezRowNow(row);
  } catch (e) {
    console.error("deleteRouteImage failed:", e);
    setDriverSyncStatus(`Image removed here, but couldn't delete it from storage (${e.message || e}).`, "error");
  }
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

/* ---------------- Load Details modal ---------------- */

let mdzLoadDetailsRowId = null;

function openMondelezLoadDetailsModal(rowId) {
  const row = getMondelezRowsForDate(state.activeDate).find((r) => r.id === rowId);
  if (!row) return;
  const modal = $("#modal-mdz-load-details");
  if (!modal) { console.error("Mondelez Load Details modal HTML isn't on this page yet."); return; }
  mdzLoadDetailsRowId = rowId;

  const setVal = (id, val) => { const el = $("#" + id); if (el) el.value = val == null ? "" : val; };
  const locSelect = $("#mdz-ld-location");
  if (locSelect) {
    locSelect.innerHTML = MONDELEZ_LOCATIONS.map((l) => `<option value="${l.key}">${escapeHtml(l.label)}</option>`).join("");
    locSelect.value = row.location;
  }
  const drv = row.driverId ? findDriver(row.driverId) : null;
  setVal("mdz-ld-driver", drv ? drv.name : row.driverName);
  $("#mdz-ld-driver").dataset.driverId = row.driverId || "";
  const profileLink = $("#mdz-ld-view-profile");
  if (profileLink) {
    profileLink.classList.toggle("hidden", !row.driverId);
    profileLink.dataset.driverId = row.driverId || "";
  }
  setVal("mdz-ld-aljex", row.aljexNumber);
  setVal("mdz-ld-group", row.deliveryGroup);
  setVal("mdz-ld-start", row.startTime);
  setVal("mdz-ld-driverapp", row.driverAppId);
  setVal("mdz-ld-trailer", row.trailerNumber);
  setVal("mdz-ld-returntrailer", row.returnTrailerNumber);
  setVal("mdz-ld-stops", row.stopCount);
  setVal("mdz-ld-miles", row.miles);
  setVal("mdz-ld-carrierpay", row.carrierPay);
  setVal("mdz-ld-fsc", row.fsc);
  setVal("mdz-ld-additional", row.additionalCharges);
  setVal("mdz-ld-revenue", row.revenueTotal);
  setVal("mdz-ld-notes", row.notes);
  modal.classList.remove("hidden");
}

function closeMondelezLoadDetailsModal() {
  const modal = $("#modal-mdz-load-details");
  if (modal) modal.classList.add("hidden");
  closeDriverAutocomplete();
  mdzLoadDetailsRowId = null;
}

function saveMondelezLoadDetailsModal() {
  if (!mdzLoadDetailsRowId) return;
  const row = getMondelezRowsForDate(state.activeDate).find((r) => r.id === mdzLoadDetailsRowId);
  if (!row) { closeMondelezLoadDetailsModal(); return; }
  const getVal = (id) => { const el = $("#" + id); return el ? el.value : ""; };

  const newLocation = getVal("mdz-ld-location") || row.location;
  const locationChanged = newLocation !== row.location;

  const driverInput = $("#mdz-ld-driver");
  const driverNameTyped = driverInput ? driverInput.value.trim() : row.driverName;
  const explicitDriverId = driverInput ? driverInput.dataset.driverId : "";
  let driverId = explicitDriverId || null;
  if (!driverId) {
    const match = driversForLocation("mondelez").find((d) => d.name.toLowerCase() === driverNameTyped.toLowerCase());
    driverId = match ? match.id : null;
  }

  row.location = newLocation;
  row.driverName = driverNameTyped;
  row.driverId = driverId;
  row.aljexNumber = getVal("mdz-ld-aljex").trim();
  row.deliveryGroup = getVal("mdz-ld-group").trim();
  row.startTime = getVal("mdz-ld-start").trim();
  row.driverAppId = getVal("mdz-ld-driverapp").replace(/\D/g, "").slice(0, 9);
  row.trailerNumber = getVal("mdz-ld-trailer").trim();
  row.returnTrailerNumber = getVal("mdz-ld-returntrailer").trim();
  row.stopCount = getVal("mdz-ld-stops").trim();
  row.miles = getVal("mdz-ld-miles").trim();
  row.carrierPay = getVal("mdz-ld-carrierpay").trim();
  row.fsc = getVal("mdz-ld-fsc").trim();
  row.additionalCharges = getVal("mdz-ld-additional").trim();
  row.revenueTotal = getVal("mdz-ld-revenue").trim();
  row.revenueManual = row.revenueTotal !== "";
  row.notes = getVal("mdz-ld-notes").trim();

  saveMondelezRowNow(row);
  closeMondelezLoadDetailsModal();
  renderMondelezTable(); // if location changed, this drops the row out of the current tab's view
}

function textMondelezDriverForRow(rowId) {
  const row = getMondelezRowsForDate(state.activeDate).find((r) => r.id === rowId);
  if (!row) return;
  const drv = row.driverId ? findDriver(row.driverId) : null;
  textDriverPhone(drv ? drv.phone : null);
}

// Only these three locations use this template — the Activation Keys
// block is a fixed reference list for all three regardless of which one
// the row itself is at, since it's about which mobile-app organization
// the driver logs into, not something that varies load to load.
const MDZ_EMAIL_LOCATIONS = new Set(["morris", "addison", "indianapolis", "westchester"]);

function buildMondelezRouteEmailBody(row, driverName) {
  const line = (label, val) => `${label} ${val || ""}`.trimEnd();
  const screenshotNote = row.routeImageUrl
    ? "[Route screenshot opened in a separate tab — drag or paste it in here]"
    : "[No route screenshot uploaded on this load yet]";
  return [
    "Good evening, you are scheduled to take the following route tonight (See screenshot of the route below app info):",
    "",
    screenshotNote,
    "",
    line("Pickup Location:", mondelezLocationLabel(row.location)),
    line("DG#:", row.deliveryGroup),
    line("Trailer #:", row.trailerNumber),
    line("Start Time:", row.startTime),
    line("Miles:", row.miles),
    line("Stops:", row.stopCount),
    "",
    "Mobile Link Info:",
    "Organization ID: 078605713",
    "Activation Keys",
    "Morris IL - 6104",
    "Addison IL - 6136",
    "Indianapolis - 6116",
    "West Chester OH - 6104",
    line("Your user ID:", row.driverAppId),
    "iOS: https://apps.apple.com/app/id1008328213",
    "Android: https://play.google.com/store/apps/details?id=com.descartes.mobilelink&pcampaignid=web_share",
    "",
    "If you are having an issue accessing your route, please click to the top right-hand corner of the app that says \"more\".  From the pop-up menu, choose \"Reactivate Device\".  A warning will pop up that says \"Possible data loss!\".  This is fine.  Enter the code that is provided and click \"Reactivate\".  You will then be taken back to the menu to insert the above information.  If you still cannot access your route after entering all the pertinent information, please call night dispatch immediately.  It is critical that we use the app correctly when delivering stops.",
    "",
    "The delivery app is not used when making shuttle runs.",
  ].join("\n");
}

// mailto: can prefill a subject and body, but there's no way for a URL
// scheme to attach a file to the draft it opens — that's a hard browser/
// OS restriction, not something to work around. The closest practical
// substitute: open the uploaded screenshot in its own tab at the same
// time, so it's one drag-and-drop (or copy/paste) away from landing in
// the email that's about to open, rather than the dispatcher having to
// go hunt for it separately.
function emailMondelezRouteInfo(rowId) {
  const row = getMondelezRowsForDate(state.activeDate).find((r) => r.id === rowId);
  if (!row) return;
  const drv = row.driverId ? findDriver(row.driverId) : null;
  const driverName = drv ? drv.name : (row.driverName || "");
  const driverEmail = drv && drv.email ? drv.email : "";

  if (row.routeImageUrl) window.open(row.routeImageUrl, "_blank");

  const subject = `Tonight's Route — ${mondelezLocationLabel(row.location)}${row.deliveryGroup ? " — " + row.deliveryGroup : ""}`;
  const body = buildMondelezRouteEmailBody(row, driverName);
  const a = document.createElement("a");
  a.href = `mailto:${encodeURIComponent(driverEmail)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  a.click();
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
  if (!existing) {
    const restoreFocus = captureFocusForRerender();
    rows.push(mondelezRowFromDbRow(dbRow));
    renderMondelezTable();
    restoreFocus();
    return;
  }
  const tr = document.getElementById(existing.id);
  const activeEl = document.activeElement;
  const domField = (tr && tr.contains(activeEl)) ? activeEl.dataset.mdzField : null;
  const preserved = domField ? existing[domField] : undefined;
  Object.assign(existing, mondelezRowFromDbRow(dbRow), { id: existing.id, selected: existing.selected });
  if (domField) existing[domField] = preserved;
  const restoreFocus = captureFocusForRerender();
  renderMondelezTable();
  restoreFocus();
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

  if ($("#modal-location-notes")) {
    on("btn-page-info", "click", () => openLocationNotesModal("mondelez", "Mondelez"));
    on("ln-close", "click", closeLocationNotesModal);
    on("ln-cancel", "click", closeLocationNotesModal);
    on("ln-save", "click", saveLocationNotes);
    $("#modal-location-notes").addEventListener("click", (e) => { if (e.target.id === "modal-location-notes") closeLocationNotesModal(); });
  }

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

  if ($("#btn-add-driver")) $("#btn-add-driver").addEventListener("click", () => openAddDriverModal(false));

  const mdzLdModal = $("#modal-mdz-load-details");
  if (mdzLdModal) {
    const closeBtn = $("#mdz-ld-close"); if (closeBtn) closeBtn.addEventListener("click", closeMondelezLoadDetailsModal);
    const cancelBtn = $("#mdz-ld-cancel"); if (cancelBtn) cancelBtn.addEventListener("click", closeMondelezLoadDetailsModal);
    const saveBtn = $("#mdz-ld-save"); if (saveBtn) saveBtn.addEventListener("click", saveMondelezLoadDetailsModal);
    mdzLdModal.addEventListener("click", (e) => { if (e.target.id === "modal-mdz-load-details") closeMondelezLoadDetailsModal(); });
    const driverField = $("#mdz-ld-driver");
    if (driverField) {
      driverField.addEventListener("focus", () => {
        openDriverAutocomplete(driverField, "mondelez", (drv) => {
          driverField.value = drv.name;
          driverField.dataset.driverId = drv.id;
          const profileLink = $("#mdz-ld-view-profile");
          if (profileLink) { profileLink.classList.remove("hidden"); profileLink.dataset.driverId = drv.id; }
        });
      });
      driverField.addEventListener("input", () => {
        driverField.dataset.driverId = "";
        const profileLink = $("#mdz-ld-view-profile");
        if (profileLink) profileLink.classList.add("hidden");
        updateDriverAutocomplete(driverField, "mondelez");
      });
      driverField.addEventListener("blur", () => closeDriverAutocomplete());
    }
    const profileLink = $("#mdz-ld-view-profile");
    if (profileLink) profileLink.addEventListener("click", (e) => {
      if (profileLink.dataset.driverId) openEditDriverModal(profileLink.dataset.driverId);
    });
  }

  $("#mondelez-rate-panel").addEventListener("change", (e) => {
    const key = e.target.dataset.mdzSetting;
    if (!key) return;
    const val = Number(e.target.value) || 0;
    saveMondelezRateSetting(mondelezState.activeTab, key, val).then(() => {
      getMondelezRowsForDate(state.activeDate).forEach((r) => { if (r.location === mondelezState.activeTab) recomputeMondelezRevenue(r); });
    });
  });

  const table = $("#mondelez-table");
  table.addEventListener("keydown", (e) => handleRowAwareTab(e, "#mondelez-table"));
  table.addEventListener("contextmenu", (e) => {
    const tr = e.target.closest("tr");
    if (!tr || !tr.id) return;
    e.preventDefault();
    openMondelezRowContextMenu(tr.id, e.clientX, e.clientY);
  });
  table.addEventListener("click", (e) => {
    if (e.target.closest("#btn-mdz-add-row")) quickAddMondelezRow();
    const openBtn = e.target.closest("[data-open-mdz-load]");
    if (openBtn) openMondelezLoadDetailsModal(openBtn.dataset.openMdzLoad);
    const delBtn = e.target.closest("[data-action='delete-mdz-row']");
    if (delBtn) deleteMondelezRow(delBtn.dataset.mdzRow);
    const viewBtn = e.target.closest("[data-action='view-route-image']");
    if (viewBtn) viewRouteImage(viewBtn.dataset.mdzRow);
    const deleteImgBtn = e.target.closest("[data-action='delete-route-image']");
    if (deleteImgBtn) {
      if (confirm("Delete this route image? This can't be undone.")) deleteRouteImage(deleteImgBtn.dataset.mdzRow);
    }
    // clicking the empty dropzone (no image yet) opens the file picker --
    // if there's already a thumbnail, the view/delete handlers above catch
    // those clicks first and this never fires for them
    const dropzone = e.target.closest("[data-action='image-dropzone']");
    if (dropzone && !viewBtn && !deleteImgBtn) {
      const fileInput = dropzone.querySelector('input[type="file"]');
      if (fileInput) fileInput.click();
    }
    const textBtn = e.target.closest("[data-action='text-mdz-driver']");
    if (textBtn) textMondelezDriverForRow(textBtn.dataset.mdzRow);
    const emailBtn = e.target.closest("[data-action='email-mdz-driver']");
    if (emailBtn) emailMondelezRouteInfo(emailBtn.dataset.mdzRow);
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
      updateMondelezSelectCount();
      return;
    }
    if (t.dataset.action === "upload-route-image" && t.files && t.files[0]) {
      uploadRouteImage(t.dataset.mdzRow, t.files[0]);
    }
  });
  // Drag-and-drop and paste for route images -- the point of both is
  // skipping the "save the image to disk, then browse for it" round trip.
  // A file dragged in, or an image copied to the clipboard (e.g. a
  // screenshot, or "copy image" from wherever the route photo showed up),
  // uploads directly. The existing file-picker click still works too.
  table.addEventListener("dragover", (e) => {
    const dropzone = e.target.closest("[data-action='image-dropzone']");
    if (!dropzone) return;
    e.preventDefault(); // required or the browser refuses to allow a drop at all
    dropzone.classList.add("mdz-dropzone-active");
  });
  table.addEventListener("dragleave", (e) => {
    const dropzone = e.target.closest("[data-action='image-dropzone']");
    if (dropzone) dropzone.classList.remove("mdz-dropzone-active");
  });
  table.addEventListener("drop", (e) => {
    const dropzone = e.target.closest("[data-action='image-dropzone']");
    if (!dropzone) return;
    e.preventDefault();
    dropzone.classList.remove("mdz-dropzone-active");
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file && file.type.startsWith("image/")) uploadRouteImage(dropzone.dataset.mdzRow, file);
  });
  table.addEventListener("paste", (e) => {
    const dropzone = e.target.closest("[data-action='image-dropzone']");
    if (!dropzone) return;
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) uploadRouteImage(dropzone.dataset.mdzRow, file);
        break;
      }
    }
  });

  table.addEventListener("focusin", (e) => {
    const t = e.target;
    if (!(t.dataset && t.dataset.mdzRow && t.dataset.driverAc === "true")) return;
    const rowId = t.dataset.mdzRow;
    openDriverAutocomplete(t, "mondelez", (drv) => {
      t.value = drv.name;
      const row = getMondelezRowsForDate(state.activeDate).find((r) => r.id === rowId);
      if (row) {
        row.driverName = drv.name;
        row.driverId = drv.id;
        scheduleMondelezRowSave(row);
      }
    });
  });
  table.addEventListener("focusout", (e) => {
    if (e.target.dataset && e.target.dataset.driverAc === "true") closeDriverAutocomplete();
  });
  table.addEventListener("input", (e) => {
    const t = e.target;
    const rowId = t.dataset.mdzRow;
    const field = t.dataset.mdzField;
    if (!rowId || !field) return;
    const row = getMondelezRowsForDate(state.activeDate).find((r) => r.id === rowId);
    if (!row) return;

    if (field === "driverAppId") {
      const digitsOnly = t.value.replace(/\D/g, "").slice(0, 9);
      if (digitsOnly !== t.value) t.value = digitsOnly;
      row.driverAppId = digitsOnly;
      scheduleMondelezRowSave(row);
      return;
    }
    if (field === "driverName") {
      row.driverName = t.value;
      row.driverId = null;
      const match = driversForLocation("mondelez").find((d) => d.name.toLowerCase() === t.value.trim().toLowerCase());
      if (match) row.driverId = match.id;
      scheduleMondelezRowSave(row);
      if (t.dataset.driverAc === "true") updateDriverAutocomplete(t, "mondelez");
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
  document.addEventListener("click", (e) => { if (!e.target.closest("#row-context-menu")) closeContextMenu(); });
  document.addEventListener("scroll", closeContextMenu, true);
}