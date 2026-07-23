/* ================================================================
     Houston board — separate implementation, not shared with the other
     three boards, since loads_houston is a flat table (no shift/trips
     split) with entirely different columns. See chat for why this
     isn't just another branch in the existing board code.
     ================================================================ */
import { state, supabaseClient, uid, findDriver, driversForLocation, setDriverSyncStatus, SAVE_DEBOUNCE_MS, escapeHtml, $, $all, addDays, keyToDate, dateKey, on, refreshDriverDatalist, renderBoardChrome, beginTextBatchFlow, textDriverPhone, openAddDriverModal, openAddLoadModal, closeAddLoadModal, closeDateDropdown, renderCalendarGrid, closeContextMenu, sendCurrentGroupBatchDirect, openCurrentGroupBatch, confirmGroupBatchSent, pick, handleRealtimeDriverChange, initAvailableSection, resetCalendarViewMonth, resetGroupTextState, refreshAvailableSection } from './loadboard.js';
import { getBoardRateSettings } from './boardrates.js';
export const HOUSTON_TABLE = "loads_houston";
  export const houstonState = { sheets: {}, datesWithData: new Set() };

  // Houston has no per-route breakdown (flat table, no trips concept), so
  // unlike the other three locations, this is just a starting default —
  // dispatchers can still freely overtype it, same as always.
  function defaultHoustonRate() {
    const settings = getBoardRateSettings();
    const flat = settings && settings.houston && settings.houston.flat_rate;
    return flat != null ? String(flat) : "";
  }

  export function blankHoustonRow(driverId, driverName) {
    return {
      id: uid("hrow"), dbId: null, driverId: driverId || null, driverName: driverName || "",
      aljexNumber: "", comments: "", ttc: "", ttt: "", rating: "", time: "",
      driverPhone: "", timeOutRemarks: "", dispatcherPhone: "", carrier: "", mc: "", normalRate: defaultHoustonRate(),
      tonu: false, highlighted: false, shiftComplete: false, selected: false,
      createdAt: null, updatedAt: null, addedAt: null,
    };
  }
  export function houstonRowFromDbRow(r) {
    return {
      id: uid("hrow"), dbId: r.id,
      driverId: r.driver_id != null ? String(r.driver_id) : null,
      driverName: r.driver_name || "",
      aljexNumber: r.aljex_number || "", comments: r.comments || "", ttc: r.ttc || "", ttt: r.ttt || "",
      rating: r.rating || "", time: r.time || "", driverPhone: r.driver_phone || "",
      timeOutRemarks: r.time_out_remarks || "", dispatcherPhone: r.dispatcher_phone || "",
      carrier: r.carrier || "", mc: r.mc || "",
      normalRate: r.normal_rate != null ? String(r.normal_rate) : "",
      tonu: !!r.tonu, highlighted: !!r.highlighted, shiftComplete: !!r.shift_complete, selected: false,
      createdAt: r.created_at || null, updatedAt: r.updated_at || null, addedAt: null,
    };
  }
  export function houstonRowToDbRow(row, dKey) {
    return {
      shift_date: dKey,
      driver_id: row.driverId ? Number(row.driverId) : null,
      driver_name: row.driverName || null,
      aljex_number: row.aljexNumber || null, comments: row.comments || null,
      ttc: row.ttc || null, ttt: row.ttt || null, rating: row.rating || null, time: row.time || null,
      driver_phone: row.driverPhone || null, time_out_remarks: row.timeOutRemarks || null,
      dispatcher_phone: row.dispatcherPhone || null, carrier: row.carrier || null, mc: row.mc || null,
      normal_rate: row.normalRate === "" || row.normalRate == null ? null : Number(row.normalRate),
      tonu: !!row.tonu, highlighted: !!row.highlighted, shift_complete: !!row.shiftComplete,
    };
  }
  export function findHoustonRowAnywhere(rowId) {
    for (const k in houstonState.sheets) {
      const r = houstonState.sheets[k].find((x) => x.id === rowId);
      if (r) return { row: r, sheetKey: k };
    }
    return null;
  }
  export function getHoustonSheet(dKey) { return houstonState.sheets[dKey] || []; }

  async function ensureHoustonSheetLoaded(dKey) {
    if (houstonState.sheets[dKey]) return;
    if (!supabaseClient) {
      houstonState.sheets[dKey] = Array.from({ length: 5 }, () => blankHoustonRow());
      setDriverSyncStatus("Supabase didn't load on this page — loads won't be saved until this is fixed.", "error");
      return;
    }
    const { data, error } = await supabaseClient.from(HOUSTON_TABLE).select("*").eq("shift_date", dKey);
    if (error) {
      console.error("Failed to load Houston loads:", error);
      setDriverSyncStatus(`Couldn't load loads for this day (${error.message}).`, "error");
      houstonState.sheets[dKey] = Array.from({ length: 5 }, () => blankHoustonRow());
      return;
    }
    const rows = (data || []).map(houstonRowFromDbRow);
    houstonState.sheets[dKey] = rows;
  }

  export async function loadHoustonDatesWithData() {
    if (!supabaseClient) return;
    const { data, error } = await supabaseClient
      .from(HOUSTON_TABLE).select("shift_date")
      .gte("shift_date", state.minDate).lte("shift_date", state.maxDate);
    if (error) { console.error("Failed to load Houston date-availability info:", error); return; }
    houstonState.datesWithData = new Set((data || []).map((r) => r.shift_date));
  }

  export async function saveHoustonRowNow(row) {
    if (!supabaseClient) return null;
    const payload = houstonRowToDbRow(row, state.activeDate);
    try {
      if (row.dbId) {
        const { error } = await supabaseClient.from(HOUSTON_TABLE).update(payload).eq("id", row.dbId);
        if (error) throw error;
      } else {
        const { data, error } = await supabaseClient.from(HOUSTON_TABLE).insert(payload).select();
        if (error) throw error;
        row.dbId = data[0].id;
        row.createdAt = data[0].created_at;
      }
    } catch (e) {
      console.error("saveHoustonRowNow threw:", e);
      setDriverSyncStatus(`Couldn't save this load (${e.message || e}).`, "error");
    }
    return row.dbId;
  }
  let houstonSaveTimers = {};
  export function scheduleHoustonRowSave(row) {
    clearTimeout(houstonSaveTimers[row.id]);
    houstonSaveTimers[row.id] = setTimeout(() => saveHoustonRowNow(row), SAVE_DEBOUNCE_MS);
  }

  export function houstonRowToHtml(row) {
    const drv = row.driverId ? findDriver(row.driverId) : null;
    const displayName = drv ? drv.name : row.driverName;
    const rowClasses = [
      row.tonu ? "is-tonu" : "", row.highlighted ? "is-row-pinned" : "",
      row.selected ? "is-row-selected" : "", row.addedAt ? "is-new" : "",
    ].join(" ");
    return `<tr id="${row.id}" class="${rowClasses}">
      <td class="pin pin-select"><input type="checkbox" class="chk" data-action="toggle-row-select" data-row="${row.id}" ${row.selected ? "checked" : ""} title="Select"></td>
      <td class="pin pin-text"><button class="text-btn" data-action="text-driver" data-row="${row.id}" title="Text this driver">Text</button></td>
      <td class="pin pin-rate">
        <input class="cell-input small" style="width:46px;" placeholder="Rate" data-row="${row.id}" data-field="normalRate" value="${escapeHtml(row.normalRate)}">
      </td>
      <td class="pin pin-pro${row.shiftComplete ? " shift-complete-tint" : ""}">
        <input class="cell-input" placeholder="Aljex#" data-row="${row.id}" data-field="aljexNumber" value="${escapeHtml(row.aljexNumber)}">
      </td>
      <td class="pin pin-driver">
        <div class="driver-name-wrap">
          <input class="cell-input" list="driverNamesList" placeholder="Type driver name…" data-row="${row.id}" data-field="driverName" value="${escapeHtml(displayName)}">
        </div>
      </td>
      <td class="col-cell"><span class="static-text">${escapeHtml(pick(drv && drv.phone, row.driverPhone))}</span></td>
      <td class="col-dispatcherPhone"><span class="static-text">${escapeHtml(pick(drv && drv.dispatcherPhone, row.dispatcherPhone))}</span></td>
      <td class="col-hou-carrier"><span class="static-text">${escapeHtml(pick(drv && drv.carrier, row.carrier))}</span></td>
      <td class="col-mc"><span class="static-text">${escapeHtml(pick(drv && drv.mc, row.mc))}</span></td>
      <td class="col-rating"><span class="static-text">${escapeHtml(pick(drv && drv.rating, row.rating))}</span></td>
      <td class="col-shiftStart"><input class="cell-input small" style="width:46px;" placeholder="--:--" data-row="${row.id}" data-field="time" value="${escapeHtml(row.time)}"></td>
      <td class="col-hou-ttc"><input class="cell-input small" style="width:46px;" data-row="${row.id}" data-field="ttc" value="${escapeHtml(row.ttc)}"></td>
      <td class="col-hou-ttt"><input class="cell-input small" style="width:46px;" data-row="${row.id}" data-field="ttt" value="${escapeHtml(row.ttt)}"></td>
      <td class="col-hou-comments"><input class="cell-input" data-row="${row.id}" data-field="comments" value="${escapeHtml(row.comments)}"></td>
      <td class="col-hou-timeout"><input class="cell-input" data-row="${row.id}" data-field="timeOutRemarks" value="${escapeHtml(row.timeOutRemarks)}"></td>
    </tr>`;
  }

  export function renderHoustonBoardTable() {
    const rows = getHoustonSheet(state.activeDate);
    const displayRows = [...rows].sort((a, b) => (a.shiftComplete ? 1 : 0) - (b.shiftComplete ? 1 : 0));
    const thead = `<thead><tr>
      <th class="pin pin-select"><input type="checkbox" class="chk" id="select-all-rows" title="Select all"></th>
      <th class="pin pin-text"></th>
      <th class="pin pin-rate">Rate</th>
      <th class="pin pin-pro">Aljex #</th>
      <th class="pin pin-driver">Driver</th>
      <th class="col-cell">Phone</th>
      <th class="col-dispatcherPhone">Dispatcher Phone</th>
      <th class="col-hou-carrier">Carrier</th>
      <th class="col-mc">MC #</th>
      <th class="col-rating">Rating</th>
      <th class="col-shiftStart">Time</th>
      <th class="col-hou-ttc">TTC</th>
      <th class="col-hou-ttt">TTT</th>
      <th class="col-hou-comments">Comments</th>
      <th class="col-hou-timeout">Time Out / Remarks</th>
    </tr></thead>`;
    const totalHoustonCols = 15;
    const addRowHtml = `<tr class="quick-add-row"><td colspan="${totalHoustonCols}"><button type="button" class="quick-add-btn" id="btn-quick-add-row"><span class="quick-add-btn-label">+ Add Row</span></button></td></tr>`;
    const tbody = `<tbody>${displayRows.map(houstonRowToHtml).join("")}${addRowHtml}</tbody>`;
    $("#board-table").innerHTML = thead + tbody;
    const emptyState = $("#board-empty-state");
    if (emptyState) emptyState.classList.toggle("hidden", rows.length > 0);
    refreshDriverDatalist();
  }

  export async function loadAndRenderHoustonBoard() {
    await ensureHoustonSheetLoaded(state.activeDate);
    renderBoardChrome();
    renderHoustonBoardTable();
    refreshAvailableSection();
  }

  export function toggleHoustonTonu(rowId) {
    const found = findHoustonRowAnywhere(rowId);
    if (!found) return;
    found.row.tonu = !found.row.tonu;
    const tr = document.getElementById(rowId);
    if (tr) {
      tr.classList.toggle("is-tonu", found.row.tonu);
      const btn = tr.querySelector('[data-action="toggle-tonu"]');
      if (btn) btn.classList.toggle("is-active", found.row.tonu);
    }
    saveHoustonRowNow(found.row);
  }
  export function toggleHoustonRowPin(rowId) {
    const found = findHoustonRowAnywhere(rowId);
    if (!found) return;
    found.row.highlighted = !found.row.highlighted;
    const tr = document.getElementById(rowId);
    if (tr) tr.classList.toggle("is-row-pinned", found.row.highlighted);
    saveHoustonRowNow(found.row);
  }
  export function toggleHoustonRowSelected(rowId) {
    const found = findHoustonRowAnywhere(rowId);
    if (!found) return;
    found.row.selected = !found.row.selected;
    const tr = document.getElementById(rowId);
    if (tr) tr.classList.toggle("is-row-selected", found.row.selected);
  }

  export function selectAllHoustonRows(checked) {
    const rows = getHoustonSheet(state.activeDate);
    rows.forEach((row) => {
      row.selected = checked;
      const tr = document.getElementById(row.id);
      if (tr) {
        tr.classList.toggle("is-row-selected", checked);
        const chk = tr.querySelector('[data-action="toggle-row-select"]');
        if (chk) chk.checked = checked;
      }
    });
  }

  export function completeSelectedHoustonRows() {
    const rows = getHoustonSheet(state.activeDate).filter((r) => r.selected && !r.shiftComplete);
    if (!rows.length) { setDriverSyncStatus("No selected loads need completing — either nothing's checked, or they're already complete.", "error"); return; }
    rows.forEach((row) => { row.shiftComplete = true; saveHoustonRowNow(row); });
    renderHoustonBoardTable();
  }

  export function openTextSelectedHoustonModal() {
    const rows = getHoustonSheet(state.activeDate).filter((r) => r.selected);
    if (!rows.length) { setDriverSyncStatus("Nothing's checked yet — select some loads first.", "error"); return; }
    const modal = $("#modal-text-group");
    if (!modal) return;
    resetGroupTextState();
    if ($("#tg-group-tabs-wrap")) $("#tg-group-tabs-wrap").classList.add("hidden");
    $("#tg-message").value = "";
    $("#tg-setup-step").classList.remove("hidden");
    $("#tg-progress-step").classList.add("hidden");
    $("#tg-error").classList.add("hidden");
    modal.classList.remove("hidden");
  }

  export function startTextSelectedHouston() {
    const message = $("#tg-message").value.trim();
    const errEl = $("#tg-error");
    if (!message) { errEl.textContent = "Write a message first."; errEl.classList.remove("hidden"); return; }
    const rows = getHoustonSheet(state.activeDate).filter((r) => r.selected);
    const members = rows.map((r) => {
      const drv = r.driverId ? findDriver(r.driverId) : null;
      return { name: drv ? drv.name : (r.driverName || "Unnamed"), phone: drv ? drv.phone : r.driverPhone };
    });
    beginTextBatchFlow(members, "Selected Loads", message);
  }

  export function quickAddHoustonBlankRow() {
    const row = blankHoustonRow(null, "");
    row.addedAt = Date.now();
    getHoustonSheet(state.activeDate).push(row);
    renderHoustonBoardTable();
    const input = document.querySelector(`#${row.id} input[data-field="driverName"]`);
    if (input) input.focus();
  }
  
  export function toggleHoustonShiftComplete(rowId) {
    const found = findHoustonRowAnywhere(rowId);
    if (!found) return;
    found.row.shiftComplete = !found.row.shiftComplete;
    saveHoustonRowNow(found.row);
    renderHoustonBoardTable();
  }

  export async function deleteHoustonRow(rowId) {
    const found = findHoustonRowAnywhere(rowId);
    if (!found) return;
    const row = found.row;
    const drv = row.driverId ? findDriver(row.driverId) : null;
    const label = [row.aljexNumber, drv ? drv.name : row.driverName].filter(Boolean).join(" — ") || "this load";
    if (!confirm(`Delete ${label}? This can't be undone.`)) return;

    const rows = getHoustonSheet(state.activeDate);
    const idx = rows.findIndex((r) => r.id === rowId);
    if (idx !== -1) rows.splice(idx, 1);
    renderHoustonBoardTable();

    if (row.dbId && supabaseClient) {
      try {
        const { error } = await supabaseClient.from(HOUSTON_TABLE).delete().eq("id", row.dbId);
        if (error) throw error;
      } catch (e) {
        console.error("deleteHoustonRow failed:", e);
        setDriverSyncStatus(`Row removed here, but couldn't delete it from the database (${e.message || e}) — it may come back on refresh.`, "error");
      }
    }
  }

  export function textHoustonDriverForRow(rowId) {
    const found = findHoustonRowAnywhere(rowId);
    if (!found) return;
    const drv = found.row.driverId ? findDriver(found.row.driverId) : null;
    textDriverPhone(drv ? drv.phone : found.row.driverPhone);
  }

  export async function openHoustonLoadHistoryModal(rowId) {
    const found = findHoustonRowAnywhere(rowId);
    const modal = $("#modal-load-history");
    if (!found || !modal) return;
    const row = found.row;
    const drv = row.driverId ? findDriver(row.driverId) : null;
    const body = $("#lh-body");
    if (body) body.innerHTML = `<div class="subtext">Loading…</div>`;
    modal.classList.remove("hidden");
    let createdAt = row.createdAt, updatedAt = row.updatedAt;
    if (supabaseClient && row.dbId) {
      try {
        const { data, error } = await supabaseClient.from(HOUSTON_TABLE).select("created_at, updated_at").eq("id", row.dbId);
        if (!error && data && data[0]) { createdAt = data[0].created_at; updatedAt = data[0].updated_at; row.createdAt = createdAt; row.updatedAt = updatedAt; }
      } catch (e) { /* fall back to cached */ }
    }
    if (!body) return;
    const fmt = (v) => (v ? new Date(v).toLocaleString() : "—");
    body.innerHTML = `
      <div class="field"><label>Aljex #</label><div class="static-text">${escapeHtml(row.aljexNumber || "—")}</div></div>
      <div class="field"><label>Driver</label><div class="static-text">${escapeHtml(drv ? drv.name : (row.driverName || "—"))}</div></div>
      <div class="field"><label>Created</label><div class="static-text">${fmt(createdAt)}</div></div>
      <div class="field"><label>Last Updated</label><div class="static-text">${fmt(updatedAt)}</div></div>
      <div class="calc-note" style="margin-top:12px;">Detailed field-by-field history isn't tracked yet — same limitation as the other boards, needs a user-identity system first.</div>
    `;
  }

  export function openHoustonRowContextMenu(rowId, x, y) {
    closeContextMenu();
    const found = findHoustonRowAnywhere(rowId);
    if (!found) return;
    const row = found.row;
    const items = [
      { label: row.tonu ? "Un-TONU" : "TONU", action: () => toggleHoustonTonu(rowId) },
      { label: row.highlighted ? "Remove Highlight" : "Highlight", action: () => toggleHoustonRowPin(rowId) },
      { label: row.shiftComplete ? "Mark Shift Incomplete" : "Shift Complete", action: () => toggleHoustonShiftComplete(rowId) },
      { label: "Load History", action: () => openHoustonLoadHistoryModal(rowId) },
      { label: "Text Now", action: () => textHoustonDriverForRow(rowId) },
      { label: "Delete", action: () => deleteHoustonRow(rowId), danger: true },
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

  export async function openHoustonDateDropdown() {
    resetCalendarViewMonth();
    await loadHoustonDatesWithData();
    renderCalendarGrid(houstonState.datesWithData);
    $("#date-dropdown").classList.remove("hidden");
  }

  export function handleRealtimeHoustonChange(payload) {
    if (payload.eventType === "DELETE") return;
    const dbRow = payload.new;
    if (!dbRow) return;
    if (dbRow.shift_date >= state.minDate && dbRow.shift_date <= state.maxDate) {
      houstonState.datesWithData.add(dbRow.shift_date);
    }
    if (dbRow.shift_date !== state.activeDate) return;
    const rows = houstonState.sheets[state.activeDate];
    if (!rows) return;
    const existing = rows.find((r) => r.dbId === dbRow.id);
    const wasComplete = existing ? existing.shiftComplete : null;
    if (!existing) {
      rows.push(houstonRowFromDbRow(dbRow));
      renderHoustonBoardTable();
      return;
    }
    const tr = document.getElementById(existing.id);
    const activeEl = document.activeElement;
    const domField = (tr && tr.contains(activeEl)) ? activeEl.dataset.field : null;
    const preserved = domField ? existing[domField] : undefined;
    const fresh = houstonRowFromDbRow(dbRow);
    Object.assign(existing, fresh, { id: existing.id, addedAt: existing.addedAt, selected: existing.selected });
    if (domField) existing[domField] = preserved;
    if (wasComplete !== existing.shiftComplete) renderHoustonBoardTable();
    else {
      const trAfter = document.getElementById(existing.id);
      if (trAfter) trAfter.outerHTML = houstonRowToHtml(existing);
    }
  }

  export function setupHoustonRealtimeSync() {
    if (!supabaseClient) return;
    const channel = supabaseClient.channel("board-houston");
    channel.on("postgres_changes", { event: "*", schema: "public", table: "loads_houston" }, handleRealtimeHoustonChange);
    channel.on("postgres_changes", { event: "*", schema: "public", table: "atlanta_drivers" }, handleRealtimeDriverChange);
    channel.subscribe();
  }

  export async function submitHoustonAddLoad() {
    const nameField = $("#al-driver-input");
    const name = nameField.value.trim();
    const field = nameField.closest(".field");
    if (!name) { field.classList.add("has-error"); return; }
    field.classList.remove("has-error");

    let driverId = nameField.dataset.driverId || null;
    if (!driverId) {
      const match = driversForLocation("houston").find((d) => d.name.toLowerCase() === name.toLowerCase());
      driverId = match ? match.id : null;
    }

    const row = blankHoustonRow(driverId, name);
    row.aljexNumber = $("#al-pro").value.trim();
    row.time = $("#al-shift-start").value.trim();
    row.addedAt = Date.now();

    const rows = getHoustonSheet(state.activeDate);
    const blankIdx = rows.findIndex((r) => !r.dbId && !r.driverId && !r.driverName);
    if (blankIdx !== -1) rows[blankIdx] = row; else rows.push(row);

    closeAddLoadModal();
    renderHoustonBoardTable();
    await saveHoustonRowNow(row);
  }

  export function initHoustonBoardPage(info) {
    state.activeLocation = "houston";
    loadAndRenderHoustonBoard();
    setupHoustonRealtimeSync();
    loadHoustonDatesWithData().catch((e) => console.error("loadHoustonDatesWithData() failed:", e));
    initAvailableSection();

    $("#date-prev").addEventListener("click", () => setHoustonActiveDate(dateKey(addDays(keyToDate(state.activeDate), -1))));
    $("#date-next").addEventListener("click", () => setHoustonActiveDate(dateKey(addDays(keyToDate(state.activeDate), 1))));
    $("#date-input").addEventListener("change", (e) => setHoustonActiveDate(e.target.value));
    $("#date-input").addEventListener("click", (e) => { e.preventDefault(); openHoustonDateDropdown(); });
    $("#date-today").addEventListener("click", () => setHoustonActiveDate(state.todayKey));
    $("#date-dropdown").addEventListener("click", (e) => {
      const btn = e.target.closest(".cal-cell[data-date]:not(:disabled)");
      if (btn) { setHoustonActiveDate(btn.dataset.date); closeDateDropdown(); }
    });
    document.addEventListener("click", (e) => {
      if (!e.target.closest("#date-dropdown") && !e.target.closest("#date-input")) closeDateDropdown();
    });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeContextMenu(); });
    document.addEventListener("scroll", closeContextMenu, true);
    document.addEventListener("click", (e) => { if (!e.target.closest("#row-context-menu")) closeContextMenu(); });

    if ($("#btn-add-driver")) $("#btn-add-driver").addEventListener("click", () => openAddDriverModal(false));
    if ($("#btn-add-load")) $("#btn-add-load").addEventListener("click", () => openAddLoadModal());
    if ($("#btn-complete-selected")) $("#btn-complete-selected").addEventListener("click", completeSelectedHoustonRows);
    if ($("#btn-text-selected")) $("#btn-text-selected").addEventListener("click", openTextSelectedHoustonModal);

    if ($("#modal-text-group")) {
      on("tg-close", "click", () => $("#modal-text-group").classList.add("hidden"));
      on("tg-cancel", "click", () => $("#modal-text-group").classList.add("hidden"));
      on("tg-start", "click", startTextSelectedHouston);
      on("tg-send-now", "click", sendCurrentGroupBatchDirect);
      on("tg-open-batch", "click", openCurrentGroupBatch);
      on("tg-confirm-sent", "click", confirmGroupBatchSent);
      on("tg-finish", "click", () => $("#modal-text-group").classList.add("hidden"));
      $("#modal-text-group").addEventListener("click", (e) => { if (e.target.id === "modal-text-group") $("#modal-text-group").classList.add("hidden"); });
    }

    if ($("#modal-load-history")) {
      on("lh-close", "click", () => $("#modal-load-history").classList.add("hidden"));
      on("lh-close-btn", "click", () => $("#modal-load-history").classList.add("hidden"));
      $("#modal-load-history").addEventListener("click", (e) => { if (e.target.id === "modal-load-history") $("#modal-load-history").classList.add("hidden"); });
    }

    const boardTable = $("#board-table");
    boardTable.addEventListener("click", (e) => {
      const textBtn = e.target.closest('[data-action="text-driver"]');
      if (textBtn) textHoustonDriverForRow(textBtn.dataset.row);
      if (e.target.closest("#btn-quick-add-row")) quickAddHoustonBlankRow();
    });
    boardTable.addEventListener("contextmenu", (e) => {
      const tr = e.target.closest("tr");
      if (!tr || !tr.id) return;
      e.preventDefault();
      openHoustonRowContextMenu(tr.id, e.clientX, e.clientY);
    });
    boardTable.addEventListener("change", (e) => {
      if (e.target.id === "select-all-rows") { selectAllHoustonRows(e.target.checked); return; }
      if (e.target.dataset.action === "toggle-row-select") toggleHoustonRowSelected(e.target.dataset.row);
    });
    boardTable.addEventListener("input", (e) => {
      const t = e.target;
      const rowId = t.dataset && t.dataset.row;
      if (!rowId) return;
      const found = findHoustonRowAnywhere(rowId);
      if (!found) return;
      const field = t.dataset.field;
      if (!field || field === "driverName") return; // driverName handled separately below for the autocomplete match
      found.row[field] = t.value;
      scheduleHoustonRowSave(found.row);
    });
    boardTable.addEventListener("input", (e) => {
      const t = e.target;
      if (t.dataset.field !== "driverName") return;
      const found = findHoustonRowAnywhere(t.dataset.row);
      if (!found) return;
      found.row.driverName = t.value;
      found.row.driverId = null;
      const match = driversForLocation("houston").find((d) => d.name.toLowerCase() === t.value.trim().toLowerCase());
      if (match) found.row.driverId = match.id;
      const tr = document.getElementById(found.row.id);
      if (tr) {
        const drv = found.row.driverId ? findDriver(found.row.driverId) : null;
        const setText = (selector, val) => { const el = tr.querySelector(selector); if (el) el.textContent = val; };
        setText(".col-cell .static-text", pick(drv && drv.phone, found.row.driverPhone));
        setText(".col-dispatcherPhone .static-text", pick(drv && drv.dispatcherPhone, found.row.dispatcherPhone));
        setText(".col-hou-carrier .static-text", pick(drv && drv.carrier, found.row.carrier));
        setText(".col-mc .static-text", pick(drv && drv.mc, found.row.mc));
        setText(".col-rating .static-text", pick(drv && drv.rating, found.row.rating));
        if (drv && drv.normalRate && !String(found.row.normalRate || "").trim()) {
          found.row.normalRate = drv.normalRate;
          const rateInput = tr.querySelector('input[data-field="normalRate"]');
          if (rateInput) rateInput.value = drv.normalRate;
        }
      }
      scheduleHoustonRowSave(found.row);
    });

    // Add Load modal on this page saves via the Houston path instead
    const alSubmit = $("#al-submit");
    if (alSubmit) alSubmit.addEventListener("click", submitHoustonAddLoad);
  }

  export function setHoustonActiveDate(newKey) {
    if (newKey < state.minDate || newKey > state.maxDate) return;
    state.activeDate = newKey;
    loadAndRenderHoustonBoard();
  }