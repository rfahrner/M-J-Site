/* ============================================================
   Load Board — application logic (multi-page version)
   Each tab is its own real HTML file; this file is loaded on
   every page and only wires up what actually exists on the
   current page — nothing assumes other pages' markup is present.

   DATA STATUS:
   - Drivers are real, backed by Supabase (table: atlanta_drivers).
     Adding a driver anywhere writes to the database, and every
     page fetches the current list on load — so drivers now show
     up consistently across pages and survive a refresh.
   - Loads/TONU rows are still in-memory only and reset on every
     page load / navigation. That still needs its own Supabase
     table — not built yet.
   ============================================================ */

(function () {
  "use strict";

  /* ---------------- page map (single source of truth for nav) ---------------- */

  const PAGE_MAP = {
    "index.html":      { type: "board",       key: "atlanta",   label: "Atlanta",    title: "Atlanta Spreadsheet"    },
    "dalaware.html":   { type: "board",       key: "delaware",  label: "Delaware",   title: "Delaware Spreadsheet"   },
    "buildingc.html":  { type: "board",       key: "buildingc", label: "Building C", title: "Building C Spreadsheet" },
    "houston.html":    { type: "board",       key: "houston",   label: "Houston",    title: "Houston Spreadsheet"    },
    "accounting.html": { type: "accounting",  label: "Accounting" },
    "driverlist.html": { type: "driverlist",  label: "Driver List" },
    "historics.html":  { type: "historics",   label: "Historics" },
  };
  const NAV_ORDER = ["index.html", "dalaware.html", "buildingc.html", "houston.html", "accounting.html", "driverlist.html", "historics.html"];
  const LOCATIONS = NAV_ORDER
    .filter((f) => PAGE_MAP[f].type === "board")
    .map((f) => ({ file: f, ...PAGE_MAP[f] }));

  function currentFile() {
    const p = location.pathname.split("/").pop();
    return p && PAGE_MAP[p] ? p : "index.html";
  }

  /* ---------------- constants ---------------- */

  const HIGHLIGHT_MS = 30 * 60 * 1000; // 30 minutes, per spec
  const HISTORY_DAYS = 90;              // ~3 months visible on the board
  const AVG_MPH = 45;                   // placeholder speed for calc columns

  const TRIP_SUBCOLS = [
    { key: "routeId",     label: "Route ID",         type: "text" },
    { key: "tripId",      label: "Trip ID",           type: "text" },
    { key: "trailerOut",  label: "Trailer #",         type: "text" },
    { key: "routeMiles",  label: "Rte Mi",             type: "text", small: true, inputmode: "decimal" },
    { key: "stopCount",   label: "Stops",              type: "text", small: true, inputmode: "numeric" },
    { key: "dispatchTime",label: "Dispatch/Ready",     type: "time" },
    { key: "salvage",     label: "Salvage",            type: "checkbox" },
    { key: "backhaul",    label: "B/Haul",             type: "checkbox" },
    { key: "lastStopDepart",  label: "Last Stop Depart",   type: "calc" },
    { key: "returnToDC",      label: "Return to DC",       type: "calc" },
    { key: "etaNextDispatch", label: "ETA Next Dispatch",  type: "calc" },
    { key: "hosLeft",         label: "HOS Left",           type: "calc" },
    { key: "tripCallTime",    label: "Trip Call Time",     type: "calc" },
  ];

  /* ---------------- Supabase (drivers only, for now — loads aren't backed by a table yet) ---------------- */

  const SUPABASE_URL = "https://ygsapysqzwrpcimgvaqx.supabase.co";
  const SUPABASE_KEY = "sb_publishable_8b8bSIiYm5TzLTw0WG1pAw_5ZWW5ZPL"; // publishable key — safe to be public
  const DRIVERS_TABLE = "atlanta_drivers";

  const supabaseClient = (typeof window !== "undefined" && window.supabase)
    ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY)
    : null;

  function driverToDbRow(d) {
    return {
      "Driver Name": d.name,
      "Driver Cell": d.phone,
      "MC": d.mc === "" || d.mc == null ? null : Number(d.mc),
      "Dispatcher phone number": d.dispatcherPhone || null,
      "E mail": d.email,
      "2nd email": d.email2 || null,
      "Driver Rating": d.rating || null,
      "Notes": d.notes || null,
      "Interchange agreement": !!d.tia,
      "Interchange Coverage $": d.tiiAmount != null ? d.tiiAmount : null,
      "Carrier": d.carrier || null,
      "Rate/booking contact": d.rateBooking || null,
    };
  }
  function driverFromDbRow(row) {
    return {
      id: row.id,
      name: row["Driver Name"] || "",
      phone: row["Driver Cell"] || "",
      mc: row["MC"] != null ? String(row["MC"]) : "",
      dispatcherPhone: row["Dispatcher phone number"] || "",
      email: row["E mail"] || "",
      email2: row["2nd email"] || "",
      rating: row["Driver Rating"] || null,
      notes: row["Notes"] || "",
      tia: !!row["Interchange agreement"],
      tiiAmount: row["Interchange Coverage $"] != null ? Number(row["Interchange Coverage $"]) : null,
      carrier: row["Carrier"] || "",
      rateBooking: row["Rate/booking contact"] || "",
      addedAt: null,
    };
  }

  /* ---------------- tiny helpers ---------------- */

  let uidCounter = 1000;
  const uid = (prefix) => `${prefix}_${uidCounter++}`;

  const escapeHtml = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));

  function todayDate() { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }
  function dateKey(d) {
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
  function keyToDate(k) { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d); }
  function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
  function humanDate(d) { return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" }); }

  function parseHHMM(str) {
    if (!str) return null;
    const m = /^(\d{1,2}):(\d{2})$/.exec(str.trim());
    if (!m) return null;
    return Number(m[1]) * 60 + Number(m[2]);
  }
  function minsToClock(mins) {
    if (mins == null || isNaN(mins)) return "";
    mins = ((Math.round(mins) % 1440) + 1440) % 1440;
    return `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, "0")}`;
  }
  function minsToDuration(mins) {
    if (mins == null || isNaN(mins)) return "";
    mins = Math.max(0, Math.round(mins));
    return `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, "0")}`;
  }

  /* ---------------- state ---------------- */

  const state = {
    activeLocation: null,   // set by initBoardPage() on board pages only
    activeDate: dateKey(todayDate()),
    drivers: [],
    sheets: {},              // `${locationKey}__${dateKey}` -> Row[]
    minDate: dateKey(addDays(todayDate(), -HISTORY_DAYS)),
    maxDate: dateKey(todayDate()),
    pendingAddLoadDriverId: null,
    addDriverNestedFromLoad: false,
    driverSort: { key: null, dir: "asc" },
    hiddenCols: new Set(),
    editingDriverId: null,
  };

  const DRIVER_INFO_COLS = [
    { key: "cell", label: "Cell" },
    { key: "dispatcherPhone", label: "Dispatcher Phone" },
    { key: "email", label: "Email" },
    { key: "mc", label: "MC #" },
    { key: "rating", label: "Rating" },
    { key: "shiftStart", label: "Shift Start" },
  ];
  // TRIP_SUBCOLS (defined above) doubles as the trip-column toggle list —
  // toggling one hides that column across all 5 trip blocks at once.

  function compareForSort(a, b, key, dir) {
    const av = a[key], bv = b[key];
    const aEmpty = av === null || av === undefined || av === "";
    const bEmpty = bv === null || bv === undefined || bv === "";
    if (aEmpty && bEmpty) return 0;
    if (aEmpty) return 1;  // blanks always sort last, regardless of direction
    if (bEmpty) return -1;
    const cmp = key === "mc"
      ? Number(av) - Number(bv)
      : String(av).localeCompare(String(bv), undefined, { sensitivity: "base", numeric: true });
    return dir === "desc" ? -cmp : cmp;
  }

  function getSortedDrivers() {
    const { key, dir } = state.driverSort;
    if (!key) return state.drivers;
    return [...state.drivers].sort((a, b) => compareForSort(a, b, key, dir));
  }

  function blankTrip() {
    return { id: uid("trip"), routeId: "", tripId: "", trailerOut: "", routeMiles: "", stopCount: "", dispatchTime: "", salvage: false, backhaul: false };
  }
  function blankRow(driverId, driverNameText) {
    return {
      id: uid("row"), driverId: driverId || null, driverNameText: driverNameText || "",
      proNumber: "", tonu: false, highlighted: false, shiftStart: "", addedAt: null,
      trips: [blankTrip(), blankTrip(), blankTrip(), blankTrip(), blankTrip()],
    };
  }
  function sheetKey(locationKey, dKey) { return `${locationKey}__${dKey}`; }
  function getSheet(locationKey, dKey) {
    const k = sheetKey(locationKey, dKey);
    if (!state.sheets[k]) state.sheets[k] = Array.from({ length: 5 }, () => blankRow());
    return state.sheets[k];
  }
  function findDriver(id) { return state.drivers.find((d) => String(d.id) === String(id)) || null; }
  function findRowAnywhere(rowId) {
    for (const k in state.sheets) {
      const r = state.sheets[k].find((x) => x.id === rowId);
      if (r) return { row: r, sheetKey: k };
    }
    return null;
  }

  /* ---------------- driver sync status banner ---------------- */

  function setDriverSyncStatus(message, kind) {
    $all('#driver-sync-status').forEach((el) => {
      el.textContent = message || "";
      el.classList.toggle("sync-error", kind === "error");
      el.classList.toggle("hidden", !message);
    });
  }

  /* ---------------- load real drivers from Supabase ---------------- */

  async function loadDriversFromSupabase() {
    if (!supabaseClient) {
      setDriverSyncStatus("Supabase didn't load on this page — check the script tag and your connection.", "error");
      return;
    }
    setDriverSyncStatus("Loading drivers…", "loading");
    const { data, error } = await supabaseClient.from(DRIVERS_TABLE).select("*");
    if (error) {
      console.error("Failed to load drivers from Supabase:", error);
      setDriverSyncStatus(`Couldn't load drivers (${error.message}). If your table is empty rather than erroring, double check Row Level Security has a "select" policy.`, "error");
      return;
    }
    state.drivers = data.map(driverFromDbRow);
    setDriverSyncStatus("");
    refreshDriverDatalist();
    if (currentFile() === "driverlist.html") renderDriverList();
    else if (state.activeLocation) renderBoard();
  }

  /* ---------------- calculations (PLACEHOLDER FORMULAS) ---------------- */

  function computeCalc(trip, row) {
    const dispatch = parseHHMM(trip.dispatchTime);
    const miles = parseFloat(trip.routeMiles);
    const out = { lastStopDepart: "", returnToDC: "", etaNextDispatch: "", hosLeft: "", tripCallTime: "" };
    if (dispatch != null) out.tripCallTime = minsToClock(dispatch - 30);
    if (dispatch == null || isNaN(miles) || miles <= 0) return out;

    const leg = (miles / AVG_MPH) * 60;
    const lastStopDepartMin = dispatch + leg;
    const returnMin = lastStopDepartMin + leg + 15;
    const etaNextMin = returnMin + 30;

    out.lastStopDepart = minsToClock(lastStopDepartMin);
    out.returnToDC = minsToClock(returnMin);
    out.etaNextDispatch = minsToClock(etaNextMin);

    const shiftStartMin = parseHHMM(row.shiftStart);
    if (shiftStartMin != null) out.hosLeft = minsToDuration(14 * 60 - (etaNextMin - shiftStartMin));
    return out;
  }

  /* ---------------- dom helpers ---------------- */

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $all = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  /* ---------------- nav (built the same way on every page) ---------------- */

  function renderNav() {
    const tabsEl = $("#tabs");
    if (!tabsEl) return;
    const cur = currentFile();
    tabsEl.innerHTML = NAV_ORDER.map((file) => {
      const info = PAGE_MAP[file];
      return `<a class="tab-btn${file === cur ? " active" : ""}" href="${file}">${info.label}</a>`;
    }).join("");
  }

  /* ---------------- rendering: board ---------------- */

  function tripBlockHeaderHtml(n) {
    return `<th class="group-trip${n % 2 === 0 ? " group-trip-alt" : ""}" colspan="${TRIP_SUBCOLS.length}">Trip #${n}</th>`;
  }
  function tripSubheaderHtml(n) {
    const altClass = n % 2 === 0 ? " trip-tint-b" : "";
    return TRIP_SUBCOLS.map((c, i) => `<th class="${i === 0 ? "trip-block-start" : ""}${altClass} col-${c.key}">${c.label}</th>`).join("");
  }

  function tripCellsHtml(row, trip, n) {
    const calc = computeCalc(trip, row);
    const altClass = n % 2 === 0 ? " trip-tint-b" : "";
    return TRIP_SUBCOLS.map((col, i) => {
      const cls = (i === 0 ? "trip-block-start" : "") + altClass + ` col-${col.key}`;
      if (col.type === "checkbox") {
        const on = !!trip[col.key];
        const flagCls = col.key === "salvage" ? "flag-yes" : "flag-backhaul";
        return `<td class="${cls} ${on ? flagCls : ""}" style="text-align:center;">
          <input type="checkbox" class="chk" data-row="${row.id}" data-trip="${trip.id}" data-field="${col.key}" ${on ? "checked" : ""}>
        </td>`;
      }
      if (col.type === "calc") {
        return `<td class="${cls}"><input class="cell-input calc" value="${escapeHtml(calc[col.key])}" readonly tabindex="-1"></td>`;
      }
      const placeholder = col.type === "time" ? "--:--" : "";
      const inputmode = col.inputmode ? ` inputmode="${col.inputmode}"` : "";
      return `<td class="${cls}"><input class="cell-input ${col.small ? "small" : ""}" type="text" placeholder="${placeholder}"${inputmode}
        data-row="${row.id}" data-trip="${trip.id}" data-field="${col.key}" value="${escapeHtml(trip[col.key])}"></td>`;
    }).join("");
  }

  function rowToHtml(row) {
    const drv = row.driverId ? findDriver(row.driverId) : null;
    const displayName = drv ? drv.name : row.driverNameText;
    const tripsHtml = row.trips.map((t, i) => tripCellsHtml(row, t, i + 1)).join("");
    return `<tr id="${row.id}" class="${row.tonu ? "is-tonu" : ""} ${row.highlighted ? "is-row-pinned" : ""} ${row.addedAt ? "is-new" : ""}">
      <td class="pin pin-mark">
        <button class="row-pin-btn ${row.highlighted ? "is-active" : ""}" data-action="toggle-row-pin" data-row="${row.id}" title="Highlight this row">★</button>
      </td>
      <td class="pin pin-tonu">
        <button class="tonu-btn ${row.tonu ? "is-active" : ""}" data-action="toggle-tonu" data-row="${row.id}">TONU</button>
      </td>
      <td class="pin pin-pro">
        <input class="cell-input" placeholder="PRO#" data-row="${row.id}" data-field="proNumber" value="${escapeHtml(row.proNumber)}">
      </td>
      <td class="pin pin-driver">
        <div class="driver-name-wrap">
          <input class="cell-input" list="driverNamesList" placeholder="Type driver name…"
            data-row="${row.id}" data-field="driverName" value="${escapeHtml(displayName)}">
        </div>
      </td>
      <td class="col-cell"><span class="static-text">${escapeHtml(drv ? drv.phone : "—")}</span></td>
      <td class="col-dispatcherPhone"><span class="static-text">${escapeHtml(drv ? drv.dispatcherPhone : "—")}</span></td>
      <td class="col-email"><span class="static-text">${escapeHtml(drv ? drv.email : "—")}</span></td>
      <td class="col-mc"><span class="static-text">${escapeHtml(drv ? drv.mc : "—")}</span></td>
      <td class="col-rating"><span class="static-text">${escapeHtml(drv && drv.rating ? drv.rating : "—")}</span></td>
      <td class="col-shiftStart"><input class="cell-input small" style="width:60px;" placeholder="--:--" data-row="${row.id}" data-field="shiftStart" value="${escapeHtml(row.shiftStart)}"></td>
      ${tripsHtml}
    </tr>`;
  }

  function renderBoard() {
    const loc = LOCATIONS.find((l) => l.key === state.activeLocation);
    if (!loc) return;
    $("#sheet-title").textContent = loc.title;
    const d = keyToDate(state.activeDate);
    const isToday = state.activeDate === dateKey(todayDate());
    $("#sheet-subtext").textContent = humanDate(d) + (isToday ? " · today" : "");
    $("#date-input").value = state.activeDate;
    $("#date-input").min = state.minDate;
    $("#date-input").max = state.maxDate;
    $("#date-next").disabled = state.activeDate >= state.maxDate;
    $("#date-prev").disabled = state.activeDate <= state.minDate;

    const rows = getSheet(state.activeLocation, state.activeDate);
    const thead = `<thead>
      <tr>
        <th class="pin pin-mark" rowspan="2"></th>
        <th class="pin pin-tonu" rowspan="2">TONU</th>
        <th class="pin pin-pro" rowspan="2">PRO#</th>
        <th class="pin pin-driver" rowspan="2">Driver</th>
        <th class="col-cell" rowspan="2">Cell</th>
        <th class="col-dispatcherPhone" rowspan="2">Dispatcher Phone</th>
        <th class="col-email" rowspan="2">Email</th>
        <th class="col-mc" rowspan="2">MC #</th>
        <th class="col-rating" rowspan="2">Rating</th>
        <th class="col-shiftStart" rowspan="2">Shift Start</th>
        ${[1, 2, 3, 4, 5].map(tripBlockHeaderHtml).join("")}
      </tr>
      <tr>${[1, 2, 3, 4, 5].map(tripSubheaderHtml).join("")}</tr>
    </thead>`;
    const tbody = `<tbody>${rows.map(rowToHtml).join("")}</tbody>`;

    $("#board-table").innerHTML = thead + tbody;
    const emptyState = $("#board-empty-state");
    if (emptyState) emptyState.classList.toggle("hidden", rows.length > 0);
    refreshDriverDatalist();
  }

  function recalcRowCalcCellsInPlace(rowId) {
    const found = findRowAnywhere(rowId);
    const tr = document.getElementById(rowId);
    if (!found || !tr) return;
    const activeEl = document.activeElement;
    const wasThisRow = tr.contains(activeEl);
    const activeField = wasThisRow ? activeEl.dataset.field : null;
    const activeTrip = wasThisRow ? activeEl.dataset.trip : null;
    const selStart = wasThisRow ? activeEl.selectionStart : null;
    tr.outerHTML = rowToHtml(found.row);
    if (wasThisRow) {
      const newTr = document.getElementById(rowId);
      const sel = activeTrip
        ? newTr.querySelector(`input[data-trip="${activeTrip}"][data-field="${activeField}"]`)
        : newTr.querySelector(`input[data-field="${activeField}"]`);
      if (sel) {
        sel.focus();
        try { if (selStart != null) sel.setSelectionRange(selStart, selStart); } catch (_) { /* input type doesn't support selection range */ }
      }
    }
  }

  /* ---------------- rendering: driver list ---------------- */

  function refreshDriverDatalist() {
    let dl = document.getElementById("driverNamesList");
    if (!dl) { dl = document.createElement("datalist"); dl.id = "driverNamesList"; document.body.appendChild(dl); }
    dl.innerHTML = state.drivers.map((d) => `<option value="${escapeHtml(d.name)}">`).join("");
  }

  function renderDriverList() {
    const body = $("#driverlist-table-body");
    if (!body) return;
    const tbody = getSortedDrivers().map((d) => `
      <tr id="dl-${d.id}" class="${d.addedAt ? "is-new" : ""}">
        <td><button class="edit-driver-btn" data-action="edit-driver" data-driver-id="${d.id}">Edit</button></td>
        <td>${escapeHtml(d.name)}</td>
        <td>${escapeHtml(d.phone || "—")}</td>
        <td>${escapeHtml(d.mc || "—")}</td>
        <td>${escapeHtml(d.dispatcherPhone || "—")}</td>
        <td>${escapeHtml(d.email)}</td>
        <td>${escapeHtml(d.email2 || "—")}</td>
        <td>${escapeHtml(d.rating || "—")}</td>
        <td>${escapeHtml(d.carrier || "—")}</td>
        <td>${escapeHtml(d.rateBooking || "—")}</td>
        <td><span class="badge ${d.tia ? "badge-yes" : "badge-no"}">${d.tia ? "Yes" : "No"}</span></td>
        <td>${d.tiiAmount != null ? `$${Number(d.tiiAmount).toLocaleString()}` : "—"}</td>
        <td>${escapeHtml(d.notes || "—")}</td>
      </tr>`).join("");
    body.innerHTML = tbody || `<tr><td colspan="13" style="text-align:center;color:var(--slate-500);padding:24px;">No drivers on file yet.</td></tr>`;
    refreshDriverDatalist();
    $all('th[data-sort]').forEach((th) => {
      const arrow = th.querySelector(".sort-arrow");
      if (!arrow) return;
      arrow.textContent = state.driverSort.key === th.dataset.sort ? (state.driverSort.dir === "asc" ? " ▲" : " ▼") : "";
    });
  }

  /* ---------------- date navigation ---------------- */

  function setActiveDate(newKey) {
    if (newKey < state.minDate || newKey > state.maxDate) return;
    state.activeDate = newKey;
    renderBoard();
  }

  /* ---------------- TONU ---------------- */

  function toggleTonu(rowId) {
    const found = findRowAnywhere(rowId);
    if (!found) return;
    found.row.tonu = !found.row.tonu;
    const tr = document.getElementById(rowId);
    if (tr) {
      tr.classList.toggle("is-tonu", found.row.tonu);
      const btn = tr.querySelector('[data-action="toggle-tonu"]');
      if (btn) btn.classList.toggle("is-active", found.row.tonu);
    }
  }

  function toggleRowPin(rowId) {
    const found = findRowAnywhere(rowId);
    if (!found) return;
    found.row.highlighted = !found.row.highlighted;
    const tr = document.getElementById(rowId);
    if (tr) {
      tr.classList.toggle("is-row-pinned", found.row.highlighted);
      const btn = tr.querySelector('[data-action="toggle-row-pin"]');
      if (btn) btn.classList.toggle("is-active", found.row.highlighted);
    }
  }

  /* ---------------- highlighting ---------------- */

  function highlightRow(rowId) {
    const found = findRowAnywhere(rowId);
    if (!found) return;
    found.row.addedAt = Date.now();
    const tr = document.getElementById(rowId);
    if (tr) tr.classList.add("is-new");
    setTimeout(() => {
      found.row.addedAt = null;
      const el = document.getElementById(rowId);
      if (el) el.classList.remove("is-new");
    }, HIGHLIGHT_MS);
  }

  function highlightDriver(driverId) {
    const d = findDriver(driverId);
    if (!d) return;
    d.addedAt = Date.now();
    const tr = document.getElementById(`dl-${driverId}`);
    if (tr) tr.classList.add("is-new");
    setTimeout(() => {
      d.addedAt = null;
      const el = document.getElementById(`dl-${driverId}`);
      if (el) el.classList.remove("is-new");
    }, HIGHLIGHT_MS);
  }

  function buildColumnsPanelHtml() {
    const item = (c) => `<label><input type="checkbox" data-col-toggle="${c.key}" ${state.hiddenCols.has(c.key) ? "" : "checked"}> ${c.label}</label>`;
    return `
      <div class="columns-panel-group-label">Driver info</div>
      ${DRIVER_INFO_COLS.map(item).join("")}
      <div class="columns-panel-group-label">Trip columns (applies to all 5 trips)</div>
      ${TRIP_SUBCOLS.map(item).join("")}
      <div class="columns-panel-footer"><button type="button" id="columns-show-all">Show all columns</button></div>
    `;
  }

  function applyColumnVisibility() {
    const table = $("#board-table");
    if (!table) return;
    [...DRIVER_INFO_COLS, ...TRIP_SUBCOLS].forEach((c) => {
      table.classList.toggle("hide-col-" + c.key, state.hiddenCols.has(c.key));
    });
  }

  /* ---------------- Add Driver modal (guarded — only wired if present) ---------------- */

  function setVal(id, val) { const el = $("#" + id); if (el) el.value = val; }
  function setText(id, text) { const el = $("#" + id); if (el) el.textContent = text; }

  function openAddDriverModal(nestedFromLoad) {
    const modalEl = $("#modal-add-driver");
    if (!modalEl) { console.error('openAddDriverModal: #modal-add-driver not found on this page.'); return; }
    state.addDriverNestedFromLoad = !!nestedFromLoad;
    state.editingDriverId = null;
    modalEl.classList.remove("hidden"); // open first — a missing field below should never block this
    ["ad-name", "ad-phone", "ad-mc", "ad-dispatcher-phone", "ad-email", "ad-email2", "ad-rating", "ad-carrier", "ad-rate-booking", "ad-notes", "ad-tii-amount"]
      .forEach((id) => setVal(id, ""));
    $all('input[name="ad-tia"]').forEach((r) => (r.checked = r.value === "no"));
    $all(".field", modalEl).forEach((f) => f.classList.remove("has-error"));
    setText("ad-modal-title", "Add Driver");
    setText("ad-submit", "Add");
    const nameEl = $("#ad-name");
    if (nameEl) nameEl.focus();
  }

  function openEditDriverModal(driverId) {
    const d = findDriver(driverId);
    if (!d) { console.error("openEditDriverModal: no driver found for id", driverId); return; }
    const modalEl = $("#modal-add-driver");
    if (!modalEl) { console.error('openEditDriverModal: #modal-add-driver not found on this page.'); return; }
    state.addDriverNestedFromLoad = false;
    state.editingDriverId = driverId;
    modalEl.classList.remove("hidden"); // open first — a missing field below should never block this
    setVal("ad-name", d.name || "");
    setVal("ad-phone", d.phone || "");
    setVal("ad-mc", d.mc || "");
    setVal("ad-dispatcher-phone", d.dispatcherPhone || "");
    setVal("ad-email", d.email || "");
    setVal("ad-email2", d.email2 || "");
    setVal("ad-rating", d.rating || "");
    setVal("ad-carrier", d.carrier || "");
    setVal("ad-rate-booking", d.rateBooking || "");
    setVal("ad-notes", d.notes || "");
    $all('input[name="ad-tia"]').forEach((r) => (r.checked = r.value === (d.tia ? "yes" : "no")));
    setVal("ad-tii-amount", d.tiiAmount != null ? d.tiiAmount : "");
    $all(".field", modalEl).forEach((f) => f.classList.remove("has-error"));
    setText("ad-modal-title", "Edit Driver");
    setText("ad-submit", "Save");
    const nameEl = $("#ad-name");
    if (nameEl) nameEl.focus();
  }

  function closeAddDriverModal() { $("#modal-add-driver").classList.add("hidden"); }

  async function submitDriverForm() {
    const name = $("#ad-name").value.trim();
    const phone = $("#ad-phone").value.trim();
    const mc = $("#ad-mc").value.trim();
    const email = $("#ad-email").value.trim();
    let ok = true;
    [["ad-name", name], ["ad-phone", phone], ["ad-mc", mc], ["ad-email", email]].forEach(([id, val]) => {
      const field = $("#" + id).closest(".field");
      field.classList.toggle("has-error", !val);
      if (!val) ok = false;
    });
    if (mc && !/^\d+$/.test(mc)) {
      $("#ad-mc").closest(".field").classList.add("has-error");
      ok = false;
    }
    if (!ok) return;

    const draft = {
      name, phone, mc, email,
      dispatcherPhone: $("#ad-dispatcher-phone").value.trim(),
      email2: $("#ad-email2").value.trim(),
      rating: $("#ad-rating").value.trim() || null,
      notes: $("#ad-notes").value.trim(),
      carrier: $("#ad-carrier").value.trim(),
      rateBooking: $("#ad-rate-booking").value.trim(),
      tia: $all('input[name="ad-tia"]').find((r) => r.checked).value === "yes",
      tiiAmount: $("#ad-tii-amount").value.trim() ? Number($("#ad-tii-amount").value) : null,
    };

    if (!supabaseClient) {
      setDriverSyncStatus("Can't save — Supabase didn't load on this page.", "error");
      return;
    }

    const isEdit = !!state.editingDriverId;
    const submitBtn = $("#ad-submit");
    submitBtn.disabled = true;
    submitBtn.textContent = isEdit ? "Saving…" : "Adding…";

    const { data, error } = isEdit
      ? await supabaseClient.from(DRIVERS_TABLE).update(driverToDbRow(draft)).eq("id", state.editingDriverId).select()
      : await supabaseClient.from(DRIVERS_TABLE).insert(driverToDbRow(draft)).select();

    submitBtn.disabled = false;
    submitBtn.textContent = isEdit ? "Save" : "Add";

    if (error) {
      console.error(`Failed to ${isEdit ? "update" : "add"} driver:`, error);
      setDriverSyncStatus(`Couldn't save this driver (${error.message}).${isEdit ? ' If this is a permissions error, the table needs an "update" Row Level Security policy — it likely only has select/insert so far.' : ""}`, "error");
      return;
    }
    if (isEdit && (!data || data.length === 0)) {
      // Update ran with no error but matched zero rows — almost always a missing RLS update policy.
      setDriverSyncStatus('Save didn\u2019t take \u2014 0 rows were updated. This table needs an "update" Row Level Security policy (it likely only has select/insert so far).', "error");
      return;
    }

    const driver = driverFromDbRow(data[0]);
    if (isEdit) {
      const idx = state.drivers.findIndex((x) => x.id === driver.id);
      if (idx !== -1) state.drivers[idx] = driver; else state.drivers.push(driver);
    } else {
      state.drivers.push(driver);
    }
    closeAddDriverModal();
    renderDriverList(); // no-op (guarded) unless this is the Driver List page
    refreshDriverDatalist();
    highlightDriver(driver.id);

    if (state.addDriverNestedFromLoad && $("#modal-add-load")) {
      state.pendingAddLoadDriverId = driver.id;
      openAddLoadModal();
    }
  }

  /* ---------------- Add Load modal (guarded — only wired if present) ---------------- */

  function openAddLoadModal() {
    $("#al-pro").value = "";
    $("#al-shift-start").value = "";
    $("#al-driver-dropdown").innerHTML = "";
    $("#al-driver-dropdown").classList.add("hidden");
    $all(".field", $("#modal-add-load")).forEach((f) => f.classList.remove("has-error"));

    if (state.pendingAddLoadDriverId) {
      const d = findDriver(state.pendingAddLoadDriverId);
      $("#al-driver-input").value = d ? d.name : "";
      $("#al-driver-input").dataset.driverId = d ? d.id : "";
      state.pendingAddLoadDriverId = null;
    } else {
      $("#al-driver-input").value = "";
      $("#al-driver-input").dataset.driverId = "";
    }
    $("#modal-add-load").classList.remove("hidden");
    $("#al-driver-input").focus();
  }
  function closeAddLoadModal() { $("#modal-add-load").classList.add("hidden"); }

  function renderDriverDropdown(query) {
    const box = $("#al-driver-dropdown");
    const q = query.trim().toLowerCase();
    const matches = q ? state.drivers.filter((d) => d.name.toLowerCase().includes(q)) : state.drivers;
    box.innerHTML = matches.length
      ? matches.slice(0, 8).map((d) => `
          <div class="autocomplete-item" data-pick-driver="${d.id}">
            ${escapeHtml(d.name)}<div class="ac-sub">${escapeHtml(d.mc)} · ${escapeHtml(d.phone)}</div>
          </div>`).join("")
      : `<div class="autocomplete-item" style="color:var(--slate-500);">No matching driver — use “+ Add new driver” below.</div>`;
    box.classList.remove("hidden");
  }

  function submitAddLoad() {
    const nameField = $("#al-driver-input");
    const name = nameField.value.trim();
    const field = nameField.closest(".field");
    if (!name) { field.classList.add("has-error"); return; }
    field.classList.remove("has-error");

    let driverId = nameField.dataset.driverId || null;
    if (!driverId) {
      const match = state.drivers.find((d) => d.name.toLowerCase() === name.toLowerCase());
      driverId = match ? match.id : null;
    }

    const rows = getSheet(state.activeLocation, state.activeDate);
    const row = blankRow(driverId, driverId ? "" : name);
    row.proNumber = $("#al-pro").value.trim();
    row.shiftStart = $("#al-shift-start").value.trim();
    rows.push(row);

    closeAddLoadModal();
    renderBoard();
    highlightRow(row.id);
    requestAnimationFrame(() => {
      const el = document.getElementById(row.id);
      if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  }

  /* ---------------- midnight rollover (client-side stand-in, board pages only) ---------------- */

  function checkMidnightRollover() {
    const newToday = dateKey(todayDate());
    if (newToday !== state.maxDate) {
      const wasOnToday = state.activeDate === state.maxDate;
      state.maxDate = newToday;
      state.minDate = dateKey(addDays(todayDate(), -HISTORY_DAYS));
      if (wasOnToday) setActiveDate(newToday);
    }
  }

  /* ---------------- per-page init ---------------- */

  function on(id, event, handler) {
    const el = $("#" + id);
    if (el) el.addEventListener(event, handler);
    else console.error(`on(): #${id} not found on this page — that control won't work until the HTML matches loadboard.js.`);
  }

  function wireModals() {
    if ($("#modal-add-driver")) {
      on("ad-close", "click", closeAddDriverModal);
      on("ad-cancel", "click", closeAddDriverModal);
      on("ad-submit", "click", submitDriverForm);
      on("modal-add-driver", "click", (e) => { if (e.target.id === "modal-add-driver") closeAddDriverModal(); });
    }
    if ($("#modal-add-load")) {
      on("al-close", "click", closeAddLoadModal);
      on("al-cancel", "click", closeAddLoadModal);
      on("al-submit", "click", submitAddLoad);
      on("al-add-new-driver-link", "click", () => openAddDriverModal(true));
      on("modal-add-load", "click", (e) => { if (e.target.id === "modal-add-load") closeAddLoadModal(); });

      const driverInput = $("#al-driver-input");
      if (driverInput) {
        driverInput.addEventListener("input", () => { driverInput.dataset.driverId = ""; renderDriverDropdown(driverInput.value); });
        driverInput.addEventListener("focus", () => renderDriverDropdown(driverInput.value));
        document.addEventListener("click", (e) => {
          const dropdown = $("#al-driver-dropdown");
          if (dropdown && !e.target.closest(".driver-name-wrap") && e.target.id !== "al-driver-input" && !e.target.closest("#al-driver-dropdown")) {
            dropdown.classList.add("hidden");
          }
          const pick = e.target.closest("[data-pick-driver]");
          if (pick) {
            const d = findDriver(pick.dataset.pickDriver);
            if (d) { driverInput.value = d.name; driverInput.dataset.driverId = d.id; }
            if (dropdown) dropdown.classList.add("hidden");
          }
        });
      }
    }
  }

  function initBoardPage(info) {
    state.activeLocation = info.key;
    renderBoard();

    $("#date-prev").addEventListener("click", () => setActiveDate(dateKey(addDays(keyToDate(state.activeDate), -1))));
    $("#date-next").addEventListener("click", () => setActiveDate(dateKey(addDays(keyToDate(state.activeDate), 1))));
    $("#date-input").addEventListener("change", (e) => setActiveDate(e.target.value));
    $("#date-today").addEventListener("click", () => setActiveDate(state.maxDate));

    if ($("#btn-add-driver")) $("#btn-add-driver").addEventListener("click", () => openAddDriverModal(false));
    if ($("#btn-add-load")) $("#btn-add-load").addEventListener("click", () => openAddLoadModal());

    if ($("#btn-columns") && $("#columns-panel")) {
      $("#columns-panel").innerHTML = buildColumnsPanelHtml();
      applyColumnVisibility();
      $("#btn-columns").addEventListener("click", (e) => {
        e.stopPropagation();
        $("#columns-panel").classList.toggle("hidden");
      });
      $("#columns-panel").addEventListener("change", (e) => {
        const key = e.target.dataset.colToggle;
        if (!key) return;
        if (e.target.checked) state.hiddenCols.delete(key); else state.hiddenCols.add(key);
        applyColumnVisibility();
      });
      $("#columns-panel").addEventListener("click", (e) => {
        if (e.target.id === "columns-show-all") {
          state.hiddenCols.clear();
          applyColumnVisibility();
          $("#columns-panel").innerHTML = buildColumnsPanelHtml();
        }
      });
      document.addEventListener("click", (e) => {
        if (!e.target.closest("#columns-panel") && !e.target.closest("#btn-columns")) {
          $("#columns-panel").classList.add("hidden");
        }
      });
    }

    const boardTable = $("#board-table");
    boardTable.addEventListener("click", (e) => {
      const tonuBtn = e.target.closest('[data-action="toggle-tonu"]');
      if (tonuBtn) toggleTonu(tonuBtn.dataset.row);
      const pinBtn = e.target.closest('[data-action="toggle-row-pin"]');
      if (pinBtn) toggleRowPin(pinBtn.dataset.row);
    });
    boardTable.addEventListener("input", (e) => {
      const t = e.target;
      if (t.type === "checkbox") return; // checkboxes are handled by the 'change' listener below, via .checked not .value
      const rowId = t.dataset && t.dataset.row;
      if (!rowId) return;
      const found = findRowAnywhere(rowId);
      if (!found) return;

      if (t.dataset.field === "proNumber") {
        found.row.proNumber = t.value;
        return;
      }
      if (t.dataset.field === "driverName") {
        found.row.driverNameText = t.value;
        found.row.driverId = null;
        const match = state.drivers.find((d) => d.name.toLowerCase() === t.value.trim().toLowerCase());
        if (match) found.row.driverId = match.id;
        recalcRowCalcCellsInPlace(rowId);
        return;
      }
      if (t.dataset.field === "shiftStart") {
        found.row.shiftStart = t.value;
        recalcRowCalcCellsInPlace(rowId);
        return;
      }
      if (t.dataset.trip && t.dataset.field) {
        const trip = found.row.trips.find((tr) => tr.id === t.dataset.trip);
        if (trip) { trip[t.dataset.field] = t.value; recalcRowCalcCellsInPlace(rowId); }
      }
    });
    boardTable.addEventListener("change", (e) => {
      const t = e.target;
      if (t.type === "checkbox" && t.dataset.trip) {
        const found = findRowAnywhere(t.dataset.row);
        if (!found) return;
        const trip = found.row.trips.find((tr) => tr.id === t.dataset.trip);
        if (trip) {
          trip[t.dataset.field] = t.checked;
          const td = t.closest("td");
          td.classList.toggle(t.dataset.field === "salvage" ? "flag-yes" : "flag-backhaul", t.checked);
        }
      }
    });

    setInterval(checkMidnightRollover, 60 * 1000);
  }

  function initDriverListPage() {
    renderDriverList();
    if ($("#btn-add-driver")) $("#btn-add-driver").addEventListener("click", () => openAddDriverModal(false));
    $("#driverlist-table-body").addEventListener("click", (e) => {
      const btn = e.target.closest('[data-action="edit-driver"]');
      if (btn) openEditDriverModal(btn.dataset.driverId);
    });
    $all('th[data-sort]').forEach((th) => {
      th.addEventListener("click", () => {
        const key = th.dataset.sort;
        state.driverSort = state.driverSort.key === key
          ? { key, dir: state.driverSort.dir === "asc" ? "desc" : "asc" }
          : { key, dir: "asc" };
        renderDriverList();
      });
    });
  }

  /* ---------------- init ---------------- */

  function init() {
    try { renderNav(); } catch (e) { console.error("renderNav() failed:", e); }
    const info = PAGE_MAP[currentFile()];
    try { wireModals(); } catch (e) { console.error("wireModals() failed:", e); }
    try {
      if (info.type === "board") initBoardPage(info);
      else if (info.type === "driverlist") initDriverListPage();
    } catch (e) { console.error("page-specific init failed:", e); }
    loadDriversFromSupabase().catch((e) => console.error("loadDriversFromSupabase() failed:", e));
  }

  document.addEventListener("DOMContentLoaded", init);
})();