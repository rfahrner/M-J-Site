/* ============================================================
   Load Board — application logic (multi-page version)
   Each tab is its own real HTML file now, not a JS-toggled
   section. This file is loaded on every page; it looks at what
   elements actually exist on the current page and only wires
   those up — nothing assumes the other pages' markup is present.

   IMPORTANT CURRENT LIMITATION: state (drivers, loads) lives in
   memory only and resets on every page load. That was fine for a
   single-page demo; now that navigating tabs means a real page
   load, it means a driver added on Home won't show up yet on
   Houston or Driver List after you click over. Fixing that for
   real needs the Supabase backend — that's next. For now every
   page seeds the same demo drivers so autofill/testing still work.
   ============================================================ */

(function () {
  "use strict";

  /* ---------------- page map (single source of truth for nav) ---------------- */

  const PAGE_MAP = {
    "index.html":      { type: "board",       key: "atlanta",   label: "Home",       title: "Atlanta Spreadsheet"    },
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
  };

  function blankTrip() {
    return { id: uid("trip"), routeId: "", tripId: "", trailerOut: "", routeMiles: "", stopCount: "", dispatchTime: "", salvage: false, backhaul: false };
  }
  function blankRow(driverId, driverNameText) {
    return {
      id: uid("row"), driverId: driverId || null, driverNameText: driverNameText || "",
      tonu: false, shiftStart: "", addedAt: null,
      trips: [blankTrip(), blankTrip(), blankTrip(), blankTrip(), blankTrip()],
    };
  }
  function sheetKey(locationKey, dKey) { return `${locationKey}__${dKey}`; }
  function getSheet(locationKey, dKey) {
    const k = sheetKey(locationKey, dKey);
    if (!state.sheets[k]) state.sheets[k] = [];
    return state.sheets[k];
  }
  function findDriver(id) { return state.drivers.find((d) => d.id === id) || null; }
  function findRowAnywhere(rowId) {
    for (const k in state.sheets) {
      const r = state.sheets[k].find((x) => x.id === rowId);
      if (r) return { row: r, sheetKey: k };
    }
    return null;
  }

  /* ---------------- seed sample data ---------------- */
  // Runs on every page load (no shared backend yet), so the driver list and
  // Atlanta's demo rows look the same no matter which page you land on.

  function seed() {
    const d = (o) => state.drivers.push({ id: uid("drv"), addedAt: null, ...o });
    d({ name: "Jeffrey Wilkinson", phone: "404-723-9942", mc: "1389818", dispatcherName: "", dispatcherPhone: "404-791-9001", email: "service@sjtransporting.com", rating: "A1", notes: "Long haul preferred.", tia: true, tii: true, tiiAmount: 2500 });
    d({ name: "Santino Rosedurr",  phone: "312-358-7502", mc: "1034972", dispatcherName: "", dispatcherPhone: "470-755-6049", email: "BTR.Trucking2@gmail.com", rating: "R", notes: "", tia: false, tii: false, tiiAmount: null });
    d({ name: "Rodney Reid",       phone: "678-313-2546", mc: "991321",  dispatcherName: "Reid's Trans - c", dispatcherPhone: "678-477-6597", email: "reidstransportationservice@gmail.com", rating: "A2", notes: "1800 lb lift gate.", tia: true, tii: true, tiiAmount: 5000 });
    d({ name: "James Terrell",     phone: "678-362-5982", mc: "1108556", dispatcherName: "", dispatcherPhone: "470-240-6863", email: "jt.terrell75@gmail.com", rating: "A2", notes: "", tia: true, tii: false, tiiAmount: null });
    d({ name: "Marcus Webb",       phone: "404-555-0134", mc: "1245001", dispatcherName: "", dispatcherPhone: "404-555-0199", email: "mwebb.freight@gmail.com", rating: "A1", notes: "", tia: false, tii: false, tiiAmount: null });

    const byName = (n) => state.drivers.find((x) => x.name === n);
    const rows = getSheet("atlanta", state.activeDate);

    const r1 = blankRow(byName("Jeffrey Wilkinson").id); r1.tonu = true; rows.push(r1);
    const r2 = blankRow(byName("Santino Rosedurr").id);  r2.tonu = true; rows.push(r2);

    const r3 = blankRow(byName("Rodney Reid").id);
    r3.shiftStart = "11:00";
    Object.assign(r3.trips[0], { routeId: "FRTG", tripId: "1254384", trailerOut: "326011", routeMiles: "93.8", stopCount: "1", dispatchTime: "11:03" });
    rows.push(r3);

    const r4 = blankRow(byName("James Terrell").id);
    r4.shiftStart = "11:00";
    Object.assign(r4.trips[0], { routeId: "P40055", tripId: "1254216", trailerOut: "326776", routeMiles: "55.2", stopCount: "2", dispatchTime: "11:19" });
    rows.push(r4);

    const r5 = blankRow(byName("Marcus Webb").id);
    r5.shiftStart = "11:30";
    rows.push(r5);
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

  function tripBlockHeaderHtml(n) { return `<th class="group-trip" colspan="${TRIP_SUBCOLS.length}">Trip #${n}</th>`; }
  function tripSubheaderHtml() { return TRIP_SUBCOLS.map((c, i) => `<th class="${i === 0 ? "trip-block-start" : ""}">${c.label}</th>`).join(""); }

  function tripCellsHtml(row, trip) {
    const calc = computeCalc(trip, row);
    return TRIP_SUBCOLS.map((col, i) => {
      const cls = i === 0 ? "trip-block-start" : "";
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
    const tripsHtml = row.trips.map((t) => tripCellsHtml(row, t)).join("");
    return `<tr id="${row.id}" class="${row.tonu ? "is-tonu" : ""} ${row.addedAt ? "is-new" : ""}">
      <td class="pin pin-tonu">
        <button class="tonu-btn ${row.tonu ? "is-active" : ""}" data-action="toggle-tonu" data-row="${row.id}">TONU</button>
      </td>
      <td class="pin pin-driver">
        <div class="driver-name-wrap">
          <input class="cell-input" list="driverNamesList" placeholder="Type driver name…"
            data-row="${row.id}" data-field="driverName" value="${escapeHtml(displayName)}">
        </div>
      </td>
      <td><span class="static-text">${escapeHtml(drv ? drv.phone : "—")}</span></td>
      <td><span class="static-text">${escapeHtml(drv ? drv.dispatcherPhone : "—")}</span></td>
      <td><span class="static-text">${escapeHtml(drv ? drv.email : "—")}</span></td>
      <td><span class="static-text">${escapeHtml(drv ? drv.mc : "—")}</span></td>
      <td><span class="static-text">${escapeHtml(drv && drv.rating ? drv.rating : "—")}</span></td>
      <td><input class="cell-input small" style="width:60px;" placeholder="--:--" data-row="${row.id}" data-field="shiftStart" value="${escapeHtml(row.shiftStart)}"></td>
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
        <th class="pin pin-tonu" rowspan="2">TONU</th>
        <th class="pin pin-driver" rowspan="2">Driver</th>
        <th rowspan="2">Cell</th>
        <th rowspan="2">Dispatcher Phone</th>
        <th rowspan="2">Email</th>
        <th rowspan="2">MC #</th>
        <th rowspan="2">Rating</th>
        <th rowspan="2">Shift Start</th>
        ${[1, 2, 3, 4, 5].map(tripBlockHeaderHtml).join("")}
      </tr>
      <tr>${[1, 2, 3, 4, 5].map(tripSubheaderHtml).join("")}</tr>
    </thead>`;
    const tbody = `<tbody>${rows.map(rowToHtml).join("") || `<tr><td class="pin pin-tonu" colspan="${8 + 5 * TRIP_SUBCOLS.length}" style="text-align:center;color:var(--slate-500);padding:24px;">No loads yet for this day. Use “+ Add Load” to start filling in the sheet.</td></tr>`}</tbody>`;

    $("#board-table").innerHTML = thead + tbody;
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
    const tbody = state.drivers.map((d) => `
      <tr id="dl-${d.id}" class="${d.addedAt ? "is-new" : ""}">
        <td>${escapeHtml(d.name)}</td>
        <td>${escapeHtml(d.phone)}</td>
        <td>${escapeHtml(d.mc)}</td>
        <td>${escapeHtml(d.dispatcherName || "—")}</td>
        <td>${escapeHtml(d.dispatcherPhone || "—")}</td>
        <td>${escapeHtml(d.email)}</td>
        <td>${escapeHtml(d.rating || "—")}</td>
        <td><span class="badge ${d.tia ? "badge-yes" : "badge-no"}">${d.tia ? "Yes" : "No"}</span></td>
        <td><span class="badge ${d.tii ? "badge-yes" : "badge-no"}">${d.tii ? "Yes" : "No"}</span>${d.tii && d.tiiAmount ? ` <span class="static-text">$${Number(d.tiiAmount).toLocaleString()}</span>` : ""}</td>
        <td>${escapeHtml(d.notes || "—")}</td>
      </tr>`).join("");
    body.innerHTML = tbody || `<tr><td colspan="10" style="text-align:center;color:var(--slate-500);padding:24px;">No drivers on file yet.</td></tr>`;
    refreshDriverDatalist();
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

  /* ---------------- Add Driver modal (guarded — only wired if present) ---------------- */

  function openAddDriverModal(nestedFromLoad) {
    state.addDriverNestedFromLoad = !!nestedFromLoad;
    ["ad-name", "ad-phone", "ad-mc", "ad-dispatcher-name", "ad-dispatcher-phone", "ad-email", "ad-rating", "ad-notes", "ad-tii-amount"]
      .forEach((id) => { const el = $("#" + id); if (el) el.value = ""; });
    $all('input[name="ad-tia"]').forEach((r) => (r.checked = r.value === "no"));
    $all('input[name="ad-tii"]').forEach((r) => (r.checked = r.value === "no"));
    $("#ad-tii-amount-wrap").classList.add("hidden");
    $all(".field", $("#modal-add-driver")).forEach((f) => f.classList.remove("has-error"));
    $("#modal-add-driver").classList.remove("hidden");
    $("#ad-name").focus();
  }
  function closeAddDriverModal() { $("#modal-add-driver").classList.add("hidden"); }

  function submitAddDriver() {
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
    if (!ok) return;

    const tii = $all('input[name="ad-tii"]').find((r) => r.checked).value === "yes";
    const driver = {
      id: uid("drv"), name, phone, mc,
      dispatcherName: $("#ad-dispatcher-name").value.trim(),
      dispatcherPhone: $("#ad-dispatcher-phone").value.trim(),
      email,
      rating: $("#ad-rating").value.trim() || null,
      notes: $("#ad-notes").value.trim(),
      tia: $all('input[name="ad-tia"]').find((r) => r.checked).value === "yes",
      tii, tiiAmount: tii ? (Number($("#ad-tii-amount").value) || null) : null,
      addedAt: null,
    };
    state.drivers.push(driver);
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

  function wireModals() {
    if ($("#modal-add-driver")) {
      $("#ad-close").addEventListener("click", closeAddDriverModal);
      $("#ad-cancel").addEventListener("click", closeAddDriverModal);
      $("#ad-submit").addEventListener("click", submitAddDriver);
      $all('input[name="ad-tii"]').forEach((r) => r.addEventListener("change", () => {
        $("#ad-tii-amount-wrap").classList.toggle("hidden", $all('input[name="ad-tii"]').find((x) => x.checked).value !== "yes");
      }));
      $("#modal-add-driver").addEventListener("click", (e) => { if (e.target.id === "modal-add-driver") closeAddDriverModal(); });
    }
    if ($("#modal-add-load")) {
      $("#al-close").addEventListener("click", closeAddLoadModal);
      $("#al-cancel").addEventListener("click", closeAddLoadModal);
      $("#al-submit").addEventListener("click", submitAddLoad);
      $("#al-add-new-driver-link").addEventListener("click", () => openAddDriverModal(true));
      $("#modal-add-load").addEventListener("click", (e) => { if (e.target.id === "modal-add-load") closeAddLoadModal(); });

      const driverInput = $("#al-driver-input");
      driverInput.addEventListener("input", () => { driverInput.dataset.driverId = ""; renderDriverDropdown(driverInput.value); });
      driverInput.addEventListener("focus", () => renderDriverDropdown(driverInput.value));
      document.addEventListener("click", (e) => {
        if (!e.target.closest(".driver-name-wrap") && e.target.id !== "al-driver-input" && !e.target.closest("#al-driver-dropdown")) {
          $("#al-driver-dropdown").classList.add("hidden");
        }
        const pick = e.target.closest("[data-pick-driver]");
        if (pick) {
          const d = findDriver(pick.dataset.pickDriver);
          if (d) { driverInput.value = d.name; driverInput.dataset.driverId = d.id; }
          $("#al-driver-dropdown").classList.add("hidden");
        }
      });
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

    const boardTable = $("#board-table");
    boardTable.addEventListener("click", (e) => {
      const btn = e.target.closest('[data-action="toggle-tonu"]');
      if (btn) toggleTonu(btn.dataset.row);
    });
    boardTable.addEventListener("input", (e) => {
      const t = e.target;
      const rowId = t.dataset && t.dataset.row;
      if (!rowId) return;
      const found = findRowAnywhere(rowId);
      if (!found) return;

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
  }

  /* ---------------- init ---------------- */

  function init() {
    seed();
    renderNav();
    const info = PAGE_MAP[currentFile()];
    wireModals();
    if (info.type === "board") initBoardPage(info);
    else if (info.type === "driverlist") initDriverListPage();
  }

  document.addEventListener("DOMContentLoaded", init);
})();