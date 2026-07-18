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
    "houston.html":    { type: "houston-board", key: "houston",   label: "Houston",    title: "Houston Spreadsheet"    },
    "accounting.html": { type: "accounting",  label: "Accounting" },
    "driverlist.html": { type: "driverlist",  label: "Driver List" },
    "historics.html":  { type: "historics",   label: "Historics" },
  };
  const NAV_ORDER = ["index.html", "dalaware.html", "buildingc.html", "houston.html", "accounting.html", "driverlist.html", "historics.html"];
  const LOCATIONS = NAV_ORDER
    .filter((f) => PAGE_MAP[f].type === "board" || PAGE_MAP[f].type === "houston-board")
    .map((f) => ({ file: f, ...PAGE_MAP[f] }));

  function currentFile() {
    const p = location.pathname.split("/").pop();
    return p && PAGE_MAP[p] ? p : "index.html";
  }

  /* ---------------- constants ---------------- */

  const HIGHLIGHT_MS = 30 * 60 * 1000; // 30 minutes, per spec
  const HISTORY_DAYS = 21;              // 3 weeks live on the board; older goes to Historics
  const FUTURE_DAYS = 14;               // how far ahead loads can be pre-scheduled
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
  const SHIFTS_TABLE = "loads_shifts";
  const TRIPS_TABLE = "loads_trips";

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
      "location": d.location || "atlanta",
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
      location: row["location"] || "atlanta",
      addedAt: null,
    };
  }

  function shiftToDbRow(row, locationKey, dKey) {
    return {
      location: locationKey,
      shift_date: dKey,
      pro_number: row.proNumber || null,
      driver_id: row.driverId ? Number(row.driverId) : null,
      driver_name_text: row.driverNameText || null,
      tonu: !!row.tonu,
      highlighted: !!row.highlighted,
      shift_start: row.shiftStart || null,
      shift_complete: !!row.shiftComplete,
      shift_complete_at: row.shiftCompleteAt || null,
      rate: row.rate === "" || row.rate == null ? null : Number(row.rate),
    };
  }
  function shiftFromDbRow(dbRow) {
    return {
      id: uid("row"),
      dbId: dbRow.id,
      driverId: dbRow.driver_id != null ? String(dbRow.driver_id) : null,
      driverNameText: dbRow.driver_name_text || "",
      proNumber: dbRow.pro_number || "",
      tonu: !!dbRow.tonu,
      highlighted: !!dbRow.highlighted,
      shiftStart: dbRow.shift_start || "",
      shiftComplete: !!dbRow.shift_complete,
      shiftCompleteAt: dbRow.shift_complete_at || null,
      rate: dbRow.rate != null ? String(dbRow.rate) : "",
      selected: false, // local-only UI state, not persisted — see note in chat
      createdAt: dbRow.created_at || null,
      updatedAt: dbRow.updated_at || null,
      addedAt: null,
      // Captured at historic-import time, straight off the original sheet.
      // Used as a display fallback when there's no linked driver, or the
      // linked driver's own record is missing that particular field.
      cellSnapshot: dbRow.driver_cell_snapshot || "",
      mcSnapshot: dbRow.mc_snapshot || "",
      emailSnapshot: dbRow.email_snapshot || "",
      dispatcherPhoneSnapshot: dbRow.dispatcher_phone_snapshot || "",
      ratingSnapshot: dbRow.driver_rating_snapshot || "",
      trips: [blankTrip(), blankTrip(), blankTrip(), blankTrip(), blankTrip()],
    };
  }
  function tripToDbRow(trip, shiftDbId, tripNumber) {
    return {
      shift_id: shiftDbId,
      trip_number: tripNumber,
      route_id: trip.routeId || null,
      trip_id: trip.tripId || null,
      trailer_out: trip.trailerOut || null,
      route_miles: trip.routeMiles !== "" && trip.routeMiles != null ? Number(trip.routeMiles) : null,
      stop_count: trip.stopCount !== "" && trip.stopCount != null ? Number(trip.stopCount) : null,
      dispatch_time: trip.dispatchTime || null,
      salvage: !!trip.salvage,
      backhaul: !!trip.backhaul,
    };
  }
  function tripFromDbRow(dbRow) {
    return {
      id: uid("trip"),
      dbId: dbRow.id,
      routeId: dbRow.route_id || "",
      tripId: dbRow.trip_id || "",
      trailerOut: dbRow.trailer_out || "",
      routeMiles: dbRow.route_miles != null ? String(dbRow.route_miles) : "",
      stopCount: dbRow.stop_count != null ? String(dbRow.stop_count) : "",
      dispatchTime: dbRow.dispatch_time || "",
      salvage: !!dbRow.salvage,
      backhaul: !!dbRow.backhaul,
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
  function shortHumanDate(d) { return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }); }

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
    maxDate: dateKey(addDays(todayDate(), FUTURE_DAYS)),
    todayKey: dateKey(todayDate()),
    pendingAddLoadDriverId: null,
    addDriverNestedFromLoad: false,
    driverSort: { key: null, dir: "asc" },
    driverListTab: "atlanta", // only meaningful on the Driver List page — its 3 tabs
    datesWithData: new Set(), // which days in the browsable range have any loads — for the date dropdown
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

  function locationGroupFor(locationKey) {
    if (locationKey === "buildingc") return ["atlanta"]; // shares Atlanta's pool
    return [locationKey];
  }
  function driversForLocation(locationKey) {
    const group = locationGroupFor(locationKey);
    return state.drivers.filter((d) => group.includes(d.location));
  }

  function getSortedDrivers() {
    const { key, dir } = state.driverSort;
    const pool = driversForLocation(state.driverListTab || "atlanta");
    if (!key) return pool;
    return [...pool].sort((a, b) => compareForSort(a, b, key, dir));
  }

  function blankTrip() {
    return { id: uid("trip"), dbId: null, routeId: "", tripId: "", trailerOut: "", routeMiles: "", stopCount: "", dispatchTime: "", salvage: false, backhaul: false };
  }
  function blankRow(driverId, driverNameText) {
    return {
      id: uid("row"), dbId: null, driverId: driverId || null, driverNameText: driverNameText || "",
      proNumber: "", tonu: false, highlighted: false, shiftStart: "", shiftComplete: false, shiftCompleteAt: null, rate: "", selected: false,
      createdAt: null, updatedAt: null, addedAt: null,
      cellSnapshot: "", mcSnapshot: "", emailSnapshot: "", dispatcherPhoneSnapshot: "", ratingSnapshot: "",
      trips: [blankTrip(), blankTrip(), blankTrip(), blankTrip(), blankTrip()],
    };
  }
  function sheetKey(locationKey, dKey) { return `${locationKey}__${dKey}`; }

  // Sync cache reader — always safe to call, returns [] if not loaded yet.
  function getSheet(locationKey, dKey) {
    const k = sheetKey(locationKey, dKey);
    if (!state.sheets[k]) state.sheets[k] = [];
    return state.sheets[k];
  }

  // Fetches real shifts + their trips from Supabase for a location+date the
  // first time it's visited this session, then pads up to 5 rows so there's
  // always something ready to fill in. Cached after that — doesn't re-fetch
  // on every render, only the first time a given day is opened.
  async function ensureSheetLoaded(locationKey, dKey) {
    const k = sheetKey(locationKey, dKey);
    if (state.sheets[k]) return;
    if (!supabaseClient) {
      state.sheets[k] = Array.from({ length: 5 }, () => blankRow());
      setDriverSyncStatus("Supabase didn't load on this page — loads won't be saved until this is fixed.", "error");
      return;
    }
    const { data: shiftRows, error: shiftErr } = await supabaseClient
      .from(SHIFTS_TABLE).select("*").eq("location", locationKey).eq("shift_date", dKey);
    if (shiftErr) {
      console.error("Failed to load shifts:", shiftErr);
      setDriverSyncStatus(`Couldn't load loads for this day (${shiftErr.message}).`, "error");
      state.sheets[k] = Array.from({ length: 5 }, () => blankRow());
      return;
    }
    const rows = (shiftRows || []).map(shiftFromDbRow);
    if (shiftRows && shiftRows.length) {
      const ids = shiftRows.map((r) => r.id);
      const { data: tripRows, error: tripErr } = await supabaseClient.from(TRIPS_TABLE).select("*").in("shift_id", ids);
      if (tripErr) {
        console.error("Failed to load trip details:", tripErr);
        setDriverSyncStatus(`Loaded rows, but couldn't load their trip details (${tripErr.message}).`, "error");
      } else if (tripRows) {
        rows.forEach((row, i) => {
          const dbId = shiftRows[i].id;
          const mine = tripRows.filter((t) => t.shift_id === dbId);
          const byNumber = {};
          mine.forEach((t) => { byNumber[t.trip_number] = tripFromDbRow(t); });
          row.trips = [1, 2, 3, 4, 5].map((n) => byNumber[n] || blankTrip());
        });
      }
    }
    state.sheets[k] = rows;
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
    // Supabase/PostgREST caps a single request at 1000 rows by default —
    // with 5700+ drivers now on file, a plain select("*") silently
    // truncates. Page through in chunks until a page comes back short.
    const PAGE_SIZE = 1000;
    let all = [];
    let from = 0;
    while (true) {
      const { data, error } = await supabaseClient.from(DRIVERS_TABLE).select("*").range(from, from + PAGE_SIZE - 1);
      if (error) {
        console.error("Failed to load drivers from Supabase:", error);
        setDriverSyncStatus(`Couldn't load drivers (${error.message}). If your table is empty rather than erroring, double check Row Level Security has a "select" policy.`, "error");
        return;
      }
      all = all.concat(data || []);
      if (!data || data.length < PAGE_SIZE) break;
      from += PAGE_SIZE;
    }
    state.drivers = all.map(driverFromDbRow);
    setDriverSyncStatus("");
    refreshDriverDatalist();
    if (currentFile() === "driverlist.html") renderDriverList();
    else if (state.activeLocation && state.sheets[sheetKey(state.activeLocation, state.activeDate)]) renderBoardTable();
  }

  /* ---------------- saving loads to Supabase ---------------- */

  const SAVE_DEBOUNCE_MS = 700;
  const shiftSaveTimers = new Map();
  const tripSaveTimers = new Map();

  // Handles both create (row.dbId is null) and update (row.dbId is set)
  // transparently — callers never need to branch on which one applies.
  async function saveShiftNow(row) {
    if (!supabaseClient) return null;
    try {
      const payload = shiftToDbRow(row, state.activeLocation, state.activeDate);
      if (row.dbId) {
        const { error } = await supabaseClient.from(SHIFTS_TABLE).update(payload).eq("id", row.dbId);
        if (error) { console.error("Failed to save row:", error); setDriverSyncStatus(`Couldn't save changes to this row (${error.message}).`, "error"); return null; }
        return row.dbId;
      }
      const { data, error } = await supabaseClient.from(SHIFTS_TABLE).insert(payload).select();
      if (error) { console.error("Failed to create row:", error); setDriverSyncStatus(`Couldn't save this row (${error.message}).`, "error"); return null; }
      row.dbId = data[0].id;
      return row.dbId;
    } catch (e) {
      console.error("saveShiftNow threw:", e);
      setDriverSyncStatus(`Couldn't save this row (${e.message}).`, "error");
      return null;
    }
  }

  async function saveTripNow(row, trip, tripNumber) {
    if (!supabaseClient) return null;
    try {
      const shiftDbId = row.dbId || (await saveShiftNow(row)); // a trip can't exist without its parent shift
      if (!shiftDbId) return null;
      const payload = tripToDbRow(trip, shiftDbId, tripNumber);
      if (trip.dbId) {
        const { error } = await supabaseClient.from(TRIPS_TABLE).update(payload).eq("id", trip.dbId);
        if (error) { console.error("Failed to save load:", error); setDriverSyncStatus(`Couldn't save this load (${error.message}).`, "error"); return null; }
        return trip.dbId;
      }
      const { data, error } = await supabaseClient.from(TRIPS_TABLE).insert(payload).select();
      if (error) { console.error("Failed to create load:", error); setDriverSyncStatus(`Couldn't save this load (${error.message}).`, "error"); return null; }
      trip.dbId = data[0].id;
      return trip.dbId;
    } catch (e) {
      console.error("saveTripNow threw:", e);
      setDriverSyncStatus(`Couldn't save this load (${e.message}).`, "error");
      return null;
    }
  }

  function scheduleShiftSave(row) {
    clearTimeout(shiftSaveTimers.get(row.id));
    shiftSaveTimers.set(row.id, setTimeout(() => saveShiftNow(row), SAVE_DEBOUNCE_MS));
  }
  function scheduleTripSave(row, trip, tripNumber) {
    clearTimeout(tripSaveTimers.get(trip.id));
    tripSaveTimers.set(trip.id, setTimeout(() => saveTripNow(row, trip, tripNumber), SAVE_DEBOUNCE_MS));
  }

  const CALC_FIELD_RETENTION_MS = 3 * 60 * 60 * 1000; // 3 hours

  function computeCalc(trip, row) {
    const dispatch = parseHHMM(trip.dispatchTime);
    const miles = parseFloat(trip.routeMiles);
    const out = { lastStopDepart: "", returnToDC: "", etaNextDispatch: "", hosLeft: "", tripCallTime: "" };
    if (dispatch != null) out.tripCallTime = minsToClock(dispatch - 30);
    if (dispatch == null || isNaN(miles) || miles <= 0) return applyCalcRetention(out, row);

    const leg = (miles / AVG_MPH) * 60;
    const lastStopDepartMin = dispatch + leg;
    const returnMin = lastStopDepartMin + leg + 15;
    const etaNextMin = returnMin + 30;

    out.lastStopDepart = minsToClock(lastStopDepartMin);
    out.returnToDC = minsToClock(returnMin);
    out.etaNextDispatch = minsToClock(etaNextMin);

    const shiftStartMin = parseHHMM(row.shiftStart);
    if (shiftStartMin != null) out.hosLeft = minsToDuration(14 * 60 - (etaNextMin - shiftStartMin));
    return applyCalcRetention(out, row);
  }

  // 3 hours after a shift is marked complete, these 4 fields specifically
  // are cleared — they won't be needed again. Return to DC isn't on this
  // list and stays visible.
  function applyCalcRetention(out, row) {
    if (row && row.shiftComplete && row.shiftCompleteAt) {
      const elapsed = Date.now() - new Date(row.shiftCompleteAt).getTime();
      if (elapsed > CALC_FIELD_RETENTION_MS) {
        return { ...out, lastStopDepart: "", etaNextDispatch: "", hosLeft: "", tripCallTime: "" };
      }
    }
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

  function pick(driverVal, snapshotVal) {
    if (driverVal && String(driverVal).trim()) return driverVal;
    if (snapshotVal && String(snapshotVal).trim()) return snapshotVal;
    return "—";
  }

  function rowToHtml(row) {
    const drv = row.driverId ? findDriver(row.driverId) : null;
    const displayName = drv ? drv.name : row.driverNameText;
    const tripsHtml = row.trips.map((t, i) => tripCellsHtml(row, t, i + 1)).join("");
    const rowClasses = [
      row.tonu ? "is-tonu" : "",
      row.highlighted ? "is-row-pinned" : "",
      row.selected ? "is-row-selected" : "",
      row.addedAt ? "is-new" : "",
    ].join(" ");
    return `<tr id="${row.id}" class="${rowClasses}">
      <td class="pin pin-select">
        <input type="checkbox" class="chk" data-action="toggle-row-select" data-row="${row.id}" ${row.selected ? "checked" : ""} title="Select">
      </td>
      <td class="pin pin-text">
        <button class="text-btn" data-action="text-driver" data-row="${row.id}" title="Text this driver">Text</button>
      </td>
      <td class="pin pin-rate">
        <input class="cell-input small" style="width:60px;" placeholder="Rate" data-row="${row.id}" data-field="rate" value="${escapeHtml(row.rate)}">
      </td>
      <td class="pin pin-pro${row.shiftComplete ? " shift-complete-tint" : ""}">
        <input class="cell-input" placeholder="PRO#" data-row="${row.id}" data-field="proNumber" value="${escapeHtml(row.proNumber)}">
      </td>
      <td class="pin pin-driver">
        <div class="driver-name-wrap">
          <input class="cell-input" list="driverNamesList" placeholder="Type driver name…"
            data-row="${row.id}" data-field="driverName" value="${escapeHtml(displayName)}">
        </div>
      </td>
      <td class="col-cell"><span class="static-text">${escapeHtml(pick(drv && drv.phone, row.cellSnapshot))}</span></td>
      <td class="col-dispatcherPhone"><span class="static-text">${escapeHtml(pick(drv && drv.dispatcherPhone, row.dispatcherPhoneSnapshot))}</span></td>
      <td class="col-email"><span class="static-text">${escapeHtml(pick(drv && drv.email, row.emailSnapshot))}</span></td>
      <td class="col-mc"><span class="static-text">${escapeHtml(pick(drv && drv.mc, row.mcSnapshot))}</span></td>
      <td class="col-rating"><span class="static-text">${escapeHtml(pick(drv && drv.rating, row.ratingSnapshot))}</span></td>
      <td class="col-shiftStart"><input class="cell-input small" style="width:60px;" placeholder="--:--" data-row="${row.id}" data-field="shiftStart" value="${escapeHtml(row.shiftStart)}"></td>
      ${tripsHtml}
    </tr>`;
  }



  function renderBoardChrome() {
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
  }

  /* ---------------- date dropdown — greys out days with no loads ---------------- */

  async function loadDatesWithData(locationKey) {
    if (!supabaseClient) return;
    const { data, error } = await supabaseClient
      .from(SHIFTS_TABLE).select("shift_date")
      .eq("location", locationKey).gte("shift_date", state.minDate).lte("shift_date", state.maxDate);
    if (error) { console.error("Failed to load date-availability info:", error); return; }
    state.datesWithData = new Set((data || []).map((r) => r.shift_date));
  }

  let calendarViewMonth = null; // { year, month } — which month the open popup is showing

  function renderCalendarGrid(datesWithDataSet) {
    const box = $("#date-dropdown");
    if (!box) return;
    if (!calendarViewMonth) {
      const d = keyToDate(state.activeDate);
      calendarViewMonth = { year: d.getFullYear(), month: d.getMonth() };
    }
    const { year, month } = calendarViewMonth;
    const firstOfMonth = new Date(year, month, 1);
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const startWeekday = firstOfMonth.getDay();
    const monthLabel = firstOfMonth.toLocaleDateString("en-US", { month: "long", year: "numeric" });

    let cells = "";
    for (let i = 0; i < startWeekday; i++) cells += `<div class="cal-cell cal-cell-blank"></div>`;
    for (let day = 1; day <= daysInMonth; day++) {
      const k = dateKey(new Date(year, month, day));
      const inRange = k >= state.minDate && k <= state.maxDate;
      const hasData = datesWithDataSet.has(k);
      const classes = ["cal-cell"];
      if (!inRange) classes.push("cal-cell-disabled");
      else if (!hasData) classes.push("cal-cell-empty");
      if (k === state.activeDate) classes.push("cal-cell-selected");
      if (k === state.todayKey) classes.push("cal-cell-today");
      const dot = (inRange && hasData) ? '<span class="cal-dot"></span>' : "";
      cells += `<button type="button" class="${classes.join(" ")}" data-date="${k}" ${inRange ? "" : "disabled"}>${day}${dot}</button>`;
    }
    const trailing = (7 - ((startWeekday + daysInMonth) % 7)) % 7;
    for (let i = 0; i < trailing; i++) cells += `<div class="cal-cell cal-cell-blank"></div>`;

    box.innerHTML = `
      <div class="cal-header">
        <button type="button" class="cal-nav-btn" id="cal-prev-month">&lsaquo;</button>
        <span class="cal-month-label">${monthLabel}</span>
        <button type="button" class="cal-nav-btn" id="cal-next-month">&rsaquo;</button>
      </div>
      <div class="cal-weekdays"><span>Su</span><span>Mo</span><span>Tu</span><span>We</span><span>Th</span><span>Fr</span><span>Sa</span></div>
      <div class="cal-grid">${cells}</div>
    `;
    $("#cal-prev-month").addEventListener("click", (e) => {
      e.stopPropagation();
      calendarViewMonth.month -= 1;
      if (calendarViewMonth.month < 0) { calendarViewMonth.month = 11; calendarViewMonth.year -= 1; }
      renderCalendarGrid(datesWithDataSet);
    });
    $("#cal-next-month").addEventListener("click", (e) => {
      e.stopPropagation();
      calendarViewMonth.month += 1;
      if (calendarViewMonth.month > 11) { calendarViewMonth.month = 0; calendarViewMonth.year += 1; }
      renderCalendarGrid(datesWithDataSet);
    });
  }

  function openDateDropdown() {
    calendarViewMonth = null; // re-focus on the active date's month each time it's opened fresh
    renderCalendarGrid(state.datesWithData);
    $("#date-dropdown").classList.remove("hidden");
  }
  function closeDateDropdown() {
    const el = $("#date-dropdown");
    if (el) el.classList.add("hidden");
  }

  // Sync — draws whatever's currently cached in state.sheets. Safe to call
  // any time data already loaded needs a full redraw (e.g. after Add Load,
  // or once the driver list arrives and driver-linked cells need refreshing).
  function renderBoardTable() {
    const rows = getSheet(state.activeLocation, state.activeDate);
    const displayRows = [...rows].sort((a, b) => (a.shiftComplete ? 1 : 0) - (b.shiftComplete ? 1 : 0)); // stable — completed shifts sink to the bottom, order preserved otherwise
    const thead = `<thead>
      <tr>
        <th class="pin pin-select" rowspan="2"><input type="checkbox" class="chk" id="select-all-rows" title="Select all"></th>
        <th class="pin pin-text" rowspan="2"></th>
        <th class="pin pin-rate" rowspan="2">Rate</th>
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
    const totalCols = 5 + 6 + 5 * TRIP_SUBCOLS.length;
    const addRowHtml = `<tr class="quick-add-row"><td colspan="${totalCols}"><button type="button" class="quick-add-btn" id="btn-quick-add-row"><span class="quick-add-btn-label">+ Add Row</span></button></td></tr>`;
    const tbody = `<tbody>${displayRows.map(rowToHtml).join("")}${addRowHtml}</tbody>`;

    $("#board-table").innerHTML = thead + tbody;
    const emptyState = $("#board-empty-state");
    if (emptyState) emptyState.classList.toggle("hidden", rows.length > 0);
    refreshDriverDatalist();
  }

  // Async — the actual "switch to this day" entry point. Fetches from
  // Supabase the first time a given location+date is opened this session.
  // Token guard: if the user clicks prev/next again before this finishes,
  // the stale fetch's result gets discarded instead of overwriting the
  // newer one the user is now looking at.
  let boardRenderToken = 0;
  async function loadAndRenderBoard() {
    renderBoardChrome();
    const myToken = ++boardRenderToken;
    await ensureSheetLoaded(state.activeLocation, state.activeDate);
    if (myToken !== boardRenderToken) return; // superseded by a newer navigation
    renderBoardTable();
  }

  function updateDriverLinkedCellsInPlace(rowId) {
    const found = findRowAnywhere(rowId);
    const tr = document.getElementById(rowId);
    if (!found || !tr) return;
    const row = found.row;
    const drv = row.driverId ? findDriver(row.driverId) : null;
    const setText = (selector, val) => { const el = tr.querySelector(selector); if (el) el.textContent = val; };
    setText(".col-cell .static-text", pick(drv && drv.phone, row.cellSnapshot));
    setText(".col-dispatcherPhone .static-text", pick(drv && drv.dispatcherPhone, row.dispatcherPhoneSnapshot));
    setText(".col-email .static-text", pick(drv && drv.email, row.emailSnapshot));
    setText(".col-mc .static-text", pick(drv && drv.mc, row.mcSnapshot));
    setText(".col-rating .static-text", pick(drv && drv.rating, row.ratingSnapshot));
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

  /* ---------------- realtime: live sync with other users ---------------- */
  // DOM data-field names that don't match the row object's own key name.
  const SHIFT_FIELD_TO_STATE_KEY = { driverName: "driverNameText" };

  function currentlyEditedField(rowId, tripId) {
    const tr = document.getElementById(rowId);
    const activeEl = document.activeElement;
    if (!tr || !tr.contains(activeEl)) return null;
    if (tripId != null && activeEl.dataset.trip !== tripId) return null;
    if (tripId == null && activeEl.dataset.trip) return null; // focus is in a trip field, not a shift field
    return activeEl.dataset.field || null;
  }

  function handleRealtimeShiftChange(payload) {
    if (payload.eventType === "DELETE") return; // no delete-row feature yet
    const dbRow = payload.new;
    if (!dbRow) return;
    if (dbRow.shift_date >= state.minDate && dbRow.shift_date <= state.maxDate) {
      state.datesWithData.add(dbRow.shift_date);
    }
    if (dbRow.shift_date !== state.activeDate) return; // not the day currently being viewed
    const rows = state.sheets[sheetKey(state.activeLocation, state.activeDate)];
    if (!rows) return; // this day isn't loaded in this tab yet — nothing to merge into

    const existing = rows.find((r) => r.dbId === dbRow.id);
    if (!existing) {
      rows.push(shiftFromDbRow(dbRow));
      renderBoardTable(); // a whole new row appeared — simplest to redraw
      return;
    }
    const domField = currentlyEditedField(existing.id, null);
    const stateKey = domField ? (SHIFT_FIELD_TO_STATE_KEY[domField] || domField) : null;
    const preserved = stateKey ? existing[stateKey] : undefined;
    const wasComplete = existing.shiftComplete;
    const fresh = shiftFromDbRow(dbRow);
    Object.assign(existing, fresh, { id: existing.id, trips: existing.trips, addedAt: existing.addedAt, selected: existing.selected });
    if (stateKey) existing[stateKey] = preserved; // don't clobber what the user is actively typing right now
    if (wasComplete !== existing.shiftComplete) {
      renderBoardTable(); // needs to move to the top/bottom — a single-row rebuild can't reposition it
    } else {
      recalcRowCalcCellsInPlace(existing.id);
    }
  }

  function handleRealtimeTripChange(payload) {
    if (payload.eventType === "DELETE") return;
    const dbTrip = payload.new;
    if (!dbTrip) return;
    const rows = state.sheets[sheetKey(state.activeLocation, state.activeDate)];
    if (!rows) return;
    const parentRow = rows.find((r) => r.dbId === dbTrip.shift_id);
    if (!parentRow) return; // this trip's shift isn't part of the currently-viewed day
    const idx = dbTrip.trip_number - 1;
    if (idx < 0 || idx > 4) return;
    const localTrip = parentRow.trips[idx];

    const domField = currentlyEditedField(parentRow.id, localTrip.id);
    const preserved = domField ? localTrip[domField] : undefined;
    const fresh = tripFromDbRow(dbTrip);
    Object.assign(localTrip, fresh, { id: localTrip.id });
    if (domField) localTrip[domField] = preserved;
    recalcRowCalcCellsInPlace(parentRow.id);
  }

  function handleRealtimeDriverChange(payload) {
    if (payload.eventType === "DELETE") return;
    const dbDriver = payload.new;
    if (!dbDriver) return;
    const idx = state.drivers.findIndex((d) => String(d.id) === String(dbDriver.id));
    const fresh = driverFromDbRow(dbDriver);
    if (idx !== -1) {
      fresh.addedAt = state.drivers[idx].addedAt; // preserve this tab's own highlight timer
      state.drivers[idx] = fresh;
    } else {
      state.drivers.push(fresh);
    }
    refreshDriverDatalist();
    if (currentFile() === "driverlist.html") renderDriverList();
    else if (state.activeLocation) renderBoardTable(); // driver-linked display cells may need refreshing
  }

  function setupRealtimeSync(locationKey) {
    if (!supabaseClient) return;
    const channel = supabaseClient.channel(`board-${locationKey}`);
    channel.on("postgres_changes", { event: "*", schema: "public", table: "loads_shifts", filter: `location=eq.${locationKey}` }, handleRealtimeShiftChange);
    channel.on("postgres_changes", { event: "*", schema: "public", table: "loads_trips" }, handleRealtimeTripChange);
    channel.on("postgres_changes", { event: "*", schema: "public", table: "atlanta_drivers" }, handleRealtimeDriverChange);
    channel.subscribe();
  }

  function setupDriverListRealtimeSync() {
    if (!supabaseClient) return;
    const channel = supabaseClient.channel("driverlist");
    channel.on("postgres_changes", { event: "*", schema: "public", table: "atlanta_drivers" }, handleRealtimeDriverChange);
    channel.subscribe();
  }

  /* ---------------- rendering: driver list ---------------- */

  function refreshDriverDatalist() {
    let dl = document.getElementById("driverNamesList");
    if (!dl) { dl = document.createElement("datalist"); dl.id = "driverNamesList"; document.body.appendChild(dl); }
    const contextLocation = state.activeLocation || state.driverListTab || "atlanta";
    dl.innerHTML = driversForLocation(contextLocation).map((d) => `<option value="${escapeHtml(d.name)}">`).join("");
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
    loadAndRenderBoard();
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
    saveShiftNow(found.row);
  }

  function toggleRowPin(rowId) {
    const found = findRowAnywhere(rowId);
    if (!found) return;
    found.row.highlighted = !found.row.highlighted;
    const tr = document.getElementById(rowId);
    if (tr) tr.classList.toggle("is-row-pinned", found.row.highlighted);
    saveShiftNow(found.row);
  }

  // Local-only, not persisted to Supabase — this is a per-user selection
  // state for a bulk-action feature that hasn't been designed yet.
  function toggleRowSelected(rowId) {
    const found = findRowAnywhere(rowId);
    if (!found) return;
    found.row.selected = !found.row.selected;
    const tr = document.getElementById(rowId);
    if (tr) tr.classList.toggle("is-row-selected", found.row.selected);
  }

  function selectAllRows(checked) {
    const rows = getSheet(state.activeLocation, state.activeDate);
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

  async function completeSelectedRows() {
    const rows = getSheet(state.activeLocation, state.activeDate).filter((r) => r.selected && !r.shiftComplete);
    if (!rows.length) { setDriverSyncStatus("No selected loads need completing — either nothing's checked, or they're already complete.", "error"); return; }
    for (const row of rows) {
      row.shiftComplete = true;
      row.shiftCompleteAt = new Date().toISOString();
      await saveShiftNow(row); // must finish first — sendShiftToAccounting needs row.dbId to be set
      sendShiftToAccounting(row, state.activeLocation, state.activeDate).catch((e) => console.error("sendShiftToAccounting threw:", e));
    }
    renderBoardTable();
  }

  function openTextSelectedModal() {
    const rows = getSheet(state.activeLocation, state.activeDate).filter((r) => r.selected);
    if (!rows.length) { setDriverSyncStatus("Nothing's checked yet — select some loads first.", "error"); return; }
    const modal = $("#modal-text-group");
    if (!modal) return;
    groupTextState = null;
    $("#tg-group-tabs-wrap").classList.add("hidden"); // no group to pick — the checkboxes already picked them
    $("#tg-message").value = "";
    $("#tg-setup-step").classList.remove("hidden");
    $("#tg-progress-step").classList.add("hidden");
    $("#tg-error").classList.add("hidden");
    modal.classList.remove("hidden");
    modal.dataset.mode = "selected-rows";
  }

  function startTextSelected() {
    const message = $("#tg-message").value.trim();
    const errEl = $("#tg-error");
    if (!message) { errEl.textContent = "Write a message first."; errEl.classList.remove("hidden"); return; }
    const rows = getSheet(state.activeLocation, state.activeDate).filter((r) => r.selected);
    const members = rows.map((r) => {
      const drv = r.driverId ? findDriver(r.driverId) : null;
      return { name: drv ? drv.name : (r.driverNameText || "Unnamed"), phone: drv ? drv.phone : "" };
    });
    beginTextBatchFlow(members, "Selected Loads", message);
  }

  function toggleShiftComplete(rowId) {
    const found = findRowAnywhere(rowId);
    if (!found) return;
    found.row.shiftComplete = !found.row.shiftComplete;
    found.row.shiftCompleteAt = found.row.shiftComplete ? new Date().toISOString() : null;
    saveShiftNow(found.row);
    if (found.row.shiftComplete) {
      sendShiftToAccounting(found.row, state.activeLocation, state.activeDate).catch((e) => console.error("sendShiftToAccounting threw:", e));
    }
    renderBoardTable(); // full redraw needed — this row needs to move to the bottom (or back up)
  }

  async function deleteRow(rowId) {
    const found = findRowAnywhere(rowId);
    if (!found) return;
    const row = found.row;
    const drv = row.driverId ? findDriver(row.driverId) : null;
    const label = [row.proNumber, drv ? drv.name : row.driverNameText].filter(Boolean).join(" — ") || "this load";
    if (!confirm(`Delete ${label}? This can't be undone.`)) return;

    const rows = getSheet(state.activeLocation, state.activeDate);
    const idx = rows.findIndex((r) => r.id === rowId);
    if (idx !== -1) rows.splice(idx, 1);
    renderBoardTable();

    if (row.dbId && supabaseClient) {
      try {
        const { error } = await supabaseClient.from(SHIFTS_TABLE).delete().eq("id", row.dbId);
        if (error) throw error;
      } catch (e) {
        console.error("deleteRow failed:", e);
        setDriverSyncStatus(`Row removed here, but couldn't delete it from the database (${e.message || e}) — it may come back on refresh.`, "error");
      }
    }
  }

  function textDriverForRow(rowId) {
    const found = findRowAnywhere(rowId);
    if (!found) return;
    const drv = found.row.driverId ? findDriver(found.row.driverId) : null;
    textDriverPhone(drv ? drv.phone : null);
  }

  function formatTextAddress(rawPhone) {
    const digits = (rawPhone || "").replace(/\D/g, "");
    if (!digits) return null;
    const withCountryCode = digits.length === 10 ? "1" + digits : digits;
    return `${withCountryCode}@textbetter.com`;
  }

  function textDriverPhone(rawPhone) {
    const addr = formatTextAddress(rawPhone);
    if (!addr) {
      setDriverSyncStatus("No phone number on file for this driver.", "error");
      return;
    }
    const a = document.createElement("a");
    a.href = `mailto:${addr}`;
    a.click();
  }

  /* ---------------- group texting (Driver List page) ---------------- */
  const GROUP_BATCH_SIZE = 9;
  let groupTextState = null; // { groupKey, message, batches: [[driver,...],...], batchIndex, skipped, totalSent }

  function driverGroupKey(drv) {
    const m = /^[A-Za-z]/.exec(drv.rating || "");
    return m ? m[0].toUpperCase() : null;
  }

  function availableRatingGroups() {
    const keys = new Set();
    driversForLocation(state.driverListTab || "atlanta").forEach((d) => { const k = driverGroupKey(d); if (k) keys.add(k); });
    return [...keys].sort();
  }

  function openTextGroupModal() {
    const modal = $("#modal-text-group");
    if (!modal) return;
    groupTextState = null;
    if ($("#tg-group-tabs-wrap")) $("#tg-group-tabs-wrap").classList.remove("hidden");
    modal.dataset.mode = "rating-group";
    const groups = availableRatingGroups();
    const tabsEl = $("#tg-group-tabs");
    if (tabsEl) {
      tabsEl.innerHTML = groups.length
        ? groups.map((g) => `<button type="button" class="tg-group-tab" data-group="${g}">Group ${g}</button>`).join("")
        : `<div class="subtext">No drivers have a rating on file yet.</div>`;
    }
    const msgEl = $("#tg-message");
    if (msgEl) msgEl.value = "";
    $("#tg-setup-step").classList.remove("hidden");
    $("#tg-setup-step").dataset.selectedGroup = "";
    $("#tg-progress-step").classList.add("hidden");
    $("#tg-error").classList.add("hidden");
    modal.classList.remove("hidden");
  }

  function selectTextGroup(groupKey) {
    $all(".tg-group-tab").forEach((btn) => btn.classList.toggle("is-active", btn.dataset.group === groupKey));
    $("#tg-setup-step").dataset.selectedGroup = groupKey;
  }

  function beginTextBatchFlow(members, label, message) {
    const errEl = $("#tg-error");
    const withPhone = [];
    const skipped = [];
    members.forEach((d) => { (formatTextAddress(d.phone) ? withPhone : skipped).push(d); });

    if (withPhone.length === 0) {
      errEl.textContent = `No one in ${label} has a phone number on file.`;
      errEl.classList.remove("hidden");
      return;
    }
    errEl.classList.add("hidden");

    const batches = [];
    for (let i = 0; i < withPhone.length; i += GROUP_BATCH_SIZE) batches.push(withPhone.slice(i, i + GROUP_BATCH_SIZE));

    groupTextState = { groupKey: label, message, batches, batchIndex: 0, skipped, totalSent: 0 };
    $("#tg-setup-step").classList.add("hidden");
    $("#tg-progress-step").classList.remove("hidden");
    renderGroupTextProgress();
  }

  function startGroupTexting() {
    const groupKey = $("#tg-setup-step").dataset.selectedGroup;
    const message = $("#tg-message").value.trim();
    const errEl = $("#tg-error");
    if (!groupKey) { errEl.textContent = "Pick a group first."; errEl.classList.remove("hidden"); return; }
    if (!message) { errEl.textContent = "Write a message first."; errEl.classList.remove("hidden"); return; }
    errEl.classList.add("hidden");

    const members = driversForLocation(state.driverListTab || "atlanta").filter((d) => driverGroupKey(d) === groupKey);
    beginTextBatchFlow(members, `Group ${groupKey}`, message);
  }

  function renderGroupTextProgress() {
    const s = groupTextState;
    if (!s) return;
    const isDone = s.batchIndex >= s.batches.length;
    const skipNote = s.skipped.length
      ? `<div class="calc-note" style="margin-top:8px;">${s.skipped.length} driver(s) in this group have no phone on file and were skipped: ${escapeHtml(s.skipped.map((d) => d.name).join(", "))}</div>`
      : "";

    if (isDone) {
      $("#tg-progress-body").innerHTML = `
        <div class="subtext" style="font-weight:700; font-size:14px;">All done — ${s.totalSent} driver(s) in Group ${s.groupKey} texted across ${s.batches.length} batch(es).</div>
        ${skipNote}`;
      $("#tg-open-batch").classList.add("hidden");
      $("#tg-confirm-sent").classList.add("hidden");
      $("#tg-finish").classList.remove("hidden");
      return;
    }
    const batch = s.batches[s.batchIndex];
    $("#tg-progress-body").innerHTML = `
      <div class="subtext" style="font-weight:700;">Batch ${s.batchIndex + 1} of ${s.batches.length} — ${batch.length} recipient(s)</div>
      <div class="subtext" style="margin-top:6px;">${escapeHtml(batch.map((d) => d.name).join(", "))}</div>
      ${skipNote}
      <div class="calc-note" style="margin-top:10px;">Click "Open in Outlook", review the draft, hit Send there, then come back and confirm.</div>
    `;
    $("#tg-open-batch").classList.remove("hidden");
    $("#tg-open-batch").textContent = "Open in Outlook";
    $("#tg-confirm-sent").classList.add("hidden");
    $("#tg-finish").classList.add("hidden");
  }

  function openCurrentGroupBatch() {
    const s = groupTextState;
    if (!s) return;
    const batch = s.batches[s.batchIndex];
    const addrs = batch.map((d) => formatTextAddress(d.phone)).join(",");
    const a = document.createElement("a");
    a.href = `mailto:${addrs}?body=${encodeURIComponent(s.message)}`;
    a.click();
    $("#tg-open-batch").classList.add("hidden");
    $("#tg-confirm-sent").classList.remove("hidden");
  }

  function confirmGroupBatchSent() {
    const s = groupTextState;
    if (!s) return;
    s.totalSent += s.batches[s.batchIndex].length;
    s.batchIndex += 1;
    renderGroupTextProgress();
  }

  /* ---------------- right-click context menu ---------------- */

  function closeContextMenu() {
    const existing = document.getElementById("row-context-menu");
    if (existing) existing.remove();
  }

  function openRowContextMenu(rowId, x, y) {
    closeContextMenu();
    const found = findRowAnywhere(rowId);
    if (!found) return;
    const row = found.row;
    const items = [
      { label: row.tonu ? "Un-TONU" : "TONU", action: () => toggleTonu(rowId) },
      { label: row.highlighted ? "Remove Highlight" : "Highlight", action: () => toggleRowPin(rowId) },
      { label: row.shiftComplete ? "Mark Shift Incomplete" : "Shift Complete", action: () => toggleShiftComplete(rowId) },
      { label: "Load History", action: () => openLoadHistoryModal(rowId) },
      { label: "Text Now", action: () => textDriverForRow(rowId) },
      { label: "Delete", action: () => deleteRow(rowId), danger: true },
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

  /* ---------------- Load History (basic — full change-attribution needs a user-identity system, flagged separately) ---------------- */

  async function openLoadHistoryModal(rowId) {
    const found = findRowAnywhere(rowId);
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
        const { data, error } = await supabaseClient.from(SHIFTS_TABLE).select("created_at, updated_at").eq("id", row.dbId);
        if (!error && data && data[0]) {
          createdAt = data[0].created_at;
          updatedAt = data[0].updated_at;
          row.createdAt = createdAt;
          row.updatedAt = updatedAt;
        }
      } catch (e) { /* fall back to cached timestamps below */ }
    }
    if (!body) return;
    const fmt = (v) => (v ? new Date(v).toLocaleString() : "—");
    body.innerHTML = `
      <div class="field"><label>PRO#</label><div class="static-text">${escapeHtml(row.proNumber || "—")}</div></div>
      <div class="field"><label>Driver</label><div class="static-text">${escapeHtml(drv ? drv.name : (row.driverNameText || "—"))}</div></div>
      <div class="field"><label>Created</label><div class="static-text">${fmt(createdAt)}</div></div>
      <div class="field"><label>Last Updated</label><div class="static-text">${fmt(updatedAt)}</div></div>
      <div class="calc-note" style="margin-top:12px;">Detailed field-by-field history — who changed what, and when — isn't tracked yet. That needs a real user-identity system first (nobody logs in currently), which is a bigger separate feature. This is what's available for now.</div>
    `;
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
    state.editingDriverLocation = d.location || "atlanta";
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

    const isEdit = !!state.editingDriverId;
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
      location: isEdit ? state.editingDriverLocation : (state.activeLocation === "buildingc" ? "atlanta" : (state.activeLocation || state.driverListTab || "atlanta")),
    };

    if (!supabaseClient) {
      setDriverSyncStatus("Can't save — Supabase didn't load on this page.", "error");
      return;
    }

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
    const pool = driversForLocation(state.activeLocation || "atlanta");
    const matches = q ? pool.filter((d) => d.name.toLowerCase().includes(q)) : pool;
    box.innerHTML = matches.length
      ? matches.slice(0, 8).map((d) => `
          <div class="autocomplete-item" data-pick-driver="${d.id}">
            ${escapeHtml(d.name)}<div class="ac-sub">${escapeHtml(d.mc)} · ${escapeHtml(d.phone)}</div>
          </div>`).join("")
      : `<div class="autocomplete-item" style="color:var(--slate-500);">No matching driver — use “+ Add new driver” below.</div>`;
    box.classList.remove("hidden");
  }

  function quickAddBlankRow() {
    const row = blankRow(null, "");
    row.addedAt = Date.now();
    getSheet(state.activeLocation, state.activeDate).push(row);
    renderBoardTable();
    const input = document.querySelector(`#${row.id} input[data-field="driverName"]`);
    if (input) input.focus();
  }

  async function submitAddLoad() {
    const nameField = $("#al-driver-input");
    const name = nameField.value.trim();
    const field = nameField.closest(".field");
    if (!name) { field.classList.add("has-error"); return; }
    field.classList.remove("has-error");

    let driverId = nameField.dataset.driverId || null;
    if (!driverId) {
      const match = driversForLocation(state.activeLocation || "atlanta").find((d) => d.name.toLowerCase() === name.toLowerCase());
      driverId = match ? match.id : null;
    }

    const row = blankRow(driverId, name);
    row.proNumber = $("#al-pro").value.trim();
    row.shiftStart = $("#al-shift-start").value.trim();

    const submitBtn = $("#al-submit");
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = "Adding…"; }
    await saveShiftNow(row);
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = "Add Load"; }

    getSheet(state.activeLocation, state.activeDate).push(row);

    closeAddLoadModal();
    renderBoardTable();
    highlightRow(row.id);
    requestAnimationFrame(() => {
      const el = document.getElementById(row.id);
      if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  }

  /* ---------------- midnight rollover (client-side stand-in, board pages only) ---------------- */

  function checkMidnightRollover() {
    const newToday = dateKey(todayDate());
    if (newToday !== state.todayKey) {
      const wasOnToday = state.activeDate === state.todayKey;
      state.todayKey = newToday;
      state.maxDate = dateKey(addDays(todayDate(), FUTURE_DAYS));
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
      if (currentFile() !== "houston.html") on("al-submit", "click", submitAddLoad);
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
    loadAndRenderBoard();
    setupRealtimeSync(info.key);
    loadDatesWithData(info.key).catch((e) => console.error("loadDatesWithData() failed:", e));

    $("#date-prev").addEventListener("click", () => setActiveDate(dateKey(addDays(keyToDate(state.activeDate), -1))));
    $("#date-next").addEventListener("click", () => setActiveDate(dateKey(addDays(keyToDate(state.activeDate), 1))));
    $("#date-input").addEventListener("change", (e) => setActiveDate(e.target.value));
    $("#date-input").addEventListener("click", (e) => { e.preventDefault(); openDateDropdown(); });
    $("#date-today").addEventListener("click", () => setActiveDate(state.todayKey));
    $("#date-dropdown").addEventListener("click", (e) => {
      const btn = e.target.closest(".cal-cell[data-date]:not(:disabled)");
      if (btn) { setActiveDate(btn.dataset.date); closeDateDropdown(); }
    });
    document.addEventListener("click", (e) => {
      if (!e.target.closest("#date-dropdown") && !e.target.closest("#date-input")) closeDateDropdown();
    });

    if ($("#btn-add-driver")) $("#btn-add-driver").addEventListener("click", () => openAddDriverModal(false));
    if ($("#btn-add-load")) $("#btn-add-load").addEventListener("click", () => openAddLoadModal());
    if ($("#btn-complete-selected")) $("#btn-complete-selected").addEventListener("click", completeSelectedRows);
    if ($("#btn-text-selected")) $("#btn-text-selected").addEventListener("click", openTextSelectedModal);

    if ($("#modal-text-group")) {
      on("tg-close", "click", () => $("#modal-text-group").classList.add("hidden"));
      on("tg-cancel", "click", () => $("#modal-text-group").classList.add("hidden"));
      on("tg-start", "click", startTextSelected);
      on("tg-open-batch", "click", openCurrentGroupBatch);
      on("tg-confirm-sent", "click", confirmGroupBatchSent);
      on("tg-finish", "click", () => $("#modal-text-group").classList.add("hidden"));
      $("#modal-text-group").addEventListener("click", (e) => { if (e.target.id === "modal-text-group") $("#modal-text-group").classList.add("hidden"); });
    }


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
      const textBtn = e.target.closest('[data-action="text-driver"]');
      if (textBtn) textDriverForRow(textBtn.dataset.row);
      if (e.target.id === "btn-quick-add-row") quickAddBlankRow();
    });
    boardTable.addEventListener("contextmenu", (e) => {
      const tr = e.target.closest("tr");
      if (!tr || !tr.id) return; // header row has no id — let the browser's normal menu show there
      e.preventDefault();
      openRowContextMenu(tr.id, e.clientX, e.clientY);
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
        scheduleShiftSave(found.row);
        return;
      }
      if (t.dataset.field === "rate") {
        found.row.rate = t.value;
        scheduleShiftSave(found.row);
        return;
      }
      if (t.dataset.field === "driverName") {
        found.row.driverNameText = t.value;
        found.row.driverId = null;
        const match = driversForLocation(state.activeLocation || "atlanta").find((d) => d.name.toLowerCase() === t.value.trim().toLowerCase());
        if (match) found.row.driverId = match.id;
        updateDriverLinkedCellsInPlace(rowId);
        scheduleShiftSave(found.row);
        return;
      }
      if (t.dataset.field === "shiftStart") {
        found.row.shiftStart = t.value;
        recalcRowCalcCellsInPlace(rowId);
        scheduleShiftSave(found.row);
        return;
      }
      if (t.dataset.trip && t.dataset.field) {
        const trip = found.row.trips.find((tr) => tr.id === t.dataset.trip);
        if (trip) {
          trip[t.dataset.field] = t.value;
          recalcRowCalcCellsInPlace(rowId);
          scheduleTripSave(found.row, trip, found.row.trips.indexOf(trip) + 1);
        }
      }
    });
    boardTable.addEventListener("change", (e) => {
      const t = e.target;
      if (t.id === "select-all-rows") {
        selectAllRows(t.checked);
        return;
      }
      if (t.dataset.action === "toggle-row-select") {
        toggleRowSelected(t.dataset.row);
        return;
      }
      if (t.type === "checkbox" && t.dataset.trip) {
        const found = findRowAnywhere(t.dataset.row);
        if (!found) return;
        const trip = found.row.trips.find((tr) => tr.id === t.dataset.trip);
        if (trip) {
          trip[t.dataset.field] = t.checked;
          const td = t.closest("td");
          td.classList.toggle(t.dataset.field === "salvage" ? "flag-yes" : "flag-backhaul", t.checked);
          saveTripNow(found.row, trip, found.row.trips.indexOf(trip) + 1);
        }
      }
    });

    document.addEventListener("click", (e) => {
      if (!e.target.closest("#row-context-menu")) closeContextMenu();
    });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeContextMenu(); });
    document.addEventListener("scroll", closeContextMenu, true);

    if ($("#modal-load-history")) {
      on("lh-close", "click", () => $("#modal-load-history").classList.add("hidden"));
      on("lh-close-btn", "click", () => $("#modal-load-history").classList.add("hidden"));
      $("#modal-load-history").addEventListener("click", (e) => { if (e.target.id === "modal-load-history") $("#modal-load-history").classList.add("hidden"); });
    }

    setInterval(checkMidnightRollover, 60 * 1000);
  }

  function switchDriverListTab(locationKey) {
    state.driverListTab = locationKey;
    $all(".location-tab").forEach((btn) => btn.classList.toggle("is-active", btn.dataset.location === locationKey));
    renderDriverList();
  }

  function initDriverListPage() {
    state.driverListTab = "atlanta";
    renderDriverList();
    setupDriverListRealtimeSync();
    if ($("#driverlist-location-tabs")) {
      $("#driverlist-location-tabs").addEventListener("click", (e) => {
        const btn = e.target.closest(".location-tab");
        if (btn) switchDriverListTab(btn.dataset.location);
      });
      switchDriverListTab("atlanta");
    }
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

    if ($("#btn-text-group")) $("#btn-text-group").addEventListener("click", openTextGroupModal);
    if ($("#tg-group-tabs")) $("#tg-group-tabs").addEventListener("click", (e) => {
      const btn = e.target.closest(".tg-group-tab");
      if (btn) selectTextGroup(btn.dataset.group);
    });
    on("tg-start", "click", startGroupTexting);
    on("tg-open-batch", "click", openCurrentGroupBatch);
    on("tg-confirm-sent", "click", confirmGroupBatchSent);
    const closeTextGroupModal = () => $("#modal-text-group").classList.add("hidden");
    on("tg-finish", "click", closeTextGroupModal);
    on("tg-cancel", "click", closeTextGroupModal);
    on("tg-close", "click", closeTextGroupModal);
    if ($("#modal-text-group")) $("#modal-text-group").addEventListener("click", (e) => { if (e.target.id === "modal-text-group") closeTextGroupModal(); });
  }

  /* ================================================================
     Houston board — separate implementation, not shared with the other
     three boards, since loads_houston is a flat table (no shift/trips
     split) with entirely different columns. See chat for why this
     isn't just another branch in the existing board code.
     ================================================================ */

  const HOUSTON_TABLE = "loads_houston";
  const houstonState = { sheets: {}, datesWithData: new Set() };

  function blankHoustonRow(driverId, driverName) {
    return {
      id: uid("hrow"), dbId: null, driverId: driverId || null, driverName: driverName || "",
      aljexNumber: "", comments: "", ttc: "", ttt: "", rating: "", time: "",
      driverPhone: "", timeOutRemarks: "", dispatcherPhone: "", carrier: "", mc: "", normalRate: "",
      tonu: false, highlighted: false, shiftComplete: false, selected: false,
      createdAt: null, updatedAt: null, addedAt: null,
    };
  }
  function houstonRowFromDbRow(r) {
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
  function houstonRowToDbRow(row, dKey) {
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
  function findHoustonRowAnywhere(rowId) {
    for (const k in houstonState.sheets) {
      const r = houstonState.sheets[k].find((x) => x.id === rowId);
      if (r) return { row: r, sheetKey: k };
    }
    return null;
  }
  function getHoustonSheet(dKey) { return houstonState.sheets[dKey] || []; }

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

  async function loadHoustonDatesWithData() {
    if (!supabaseClient) return;
    const { data, error } = await supabaseClient
      .from(HOUSTON_TABLE).select("shift_date")
      .gte("shift_date", state.minDate).lte("shift_date", state.maxDate);
    if (error) { console.error("Failed to load Houston date-availability info:", error); return; }
    houstonState.datesWithData = new Set((data || []).map((r) => r.shift_date));
  }

  async function saveHoustonRowNow(row) {
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
  function scheduleHoustonRowSave(row) {
    clearTimeout(houstonSaveTimers[row.id]);
    houstonSaveTimers[row.id] = setTimeout(() => saveHoustonRowNow(row), SAVE_DEBOUNCE_MS);
  }

  function houstonRowToHtml(row) {
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
        <input class="cell-input small" style="width:60px;" placeholder="Rate" data-row="${row.id}" data-field="normalRate" value="${escapeHtml(row.normalRate)}">
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
      <td class="col-shiftStart"><input class="cell-input small" style="width:60px;" placeholder="--:--" data-row="${row.id}" data-field="time" value="${escapeHtml(row.time)}"></td>
      <td class="col-hou-ttc"><input class="cell-input small" style="width:60px;" data-row="${row.id}" data-field="ttc" value="${escapeHtml(row.ttc)}"></td>
      <td class="col-hou-ttt"><input class="cell-input small" style="width:60px;" data-row="${row.id}" data-field="ttt" value="${escapeHtml(row.ttt)}"></td>
      <td class="col-hou-comments"><input class="cell-input" data-row="${row.id}" data-field="comments" value="${escapeHtml(row.comments)}"></td>
      <td class="col-hou-timeout"><input class="cell-input" data-row="${row.id}" data-field="timeOutRemarks" value="${escapeHtml(row.timeOutRemarks)}"></td>
    </tr>`;
  }

  function renderHoustonBoardTable() {
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

  async function loadAndRenderHoustonBoard() {
    await ensureHoustonSheetLoaded(state.activeDate);
    renderBoardChrome();
    renderHoustonBoardTable();
  }

  function toggleHoustonTonu(rowId) {
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
  function toggleHoustonRowPin(rowId) {
    const found = findHoustonRowAnywhere(rowId);
    if (!found) return;
    found.row.highlighted = !found.row.highlighted;
    const tr = document.getElementById(rowId);
    if (tr) tr.classList.toggle("is-row-pinned", found.row.highlighted);
    saveHoustonRowNow(found.row);
  }
  function toggleHoustonRowSelected(rowId) {
    const found = findHoustonRowAnywhere(rowId);
    if (!found) return;
    found.row.selected = !found.row.selected;
    const tr = document.getElementById(rowId);
    if (tr) tr.classList.toggle("is-row-selected", found.row.selected);
  }

  function selectAllHoustonRows(checked) {
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

  function completeSelectedHoustonRows() {
    const rows = getHoustonSheet(state.activeDate).filter((r) => r.selected && !r.shiftComplete);
    if (!rows.length) { setDriverSyncStatus("No selected loads need completing — either nothing's checked, or they're already complete.", "error"); return; }
    rows.forEach((row) => { row.shiftComplete = true; saveHoustonRowNow(row); });
    renderHoustonBoardTable();
  }

  function openTextSelectedHoustonModal() {
    const rows = getHoustonSheet(state.activeDate).filter((r) => r.selected);
    if (!rows.length) { setDriverSyncStatus("Nothing's checked yet — select some loads first.", "error"); return; }
    const modal = $("#modal-text-group");
    if (!modal) return;
    groupTextState = null;
    if ($("#tg-group-tabs-wrap")) $("#tg-group-tabs-wrap").classList.add("hidden");
    $("#tg-message").value = "";
    $("#tg-setup-step").classList.remove("hidden");
    $("#tg-progress-step").classList.add("hidden");
    $("#tg-error").classList.add("hidden");
    modal.classList.remove("hidden");
  }

  function startTextSelectedHouston() {
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

  function quickAddHoustonBlankRow() {
    const row = blankHoustonRow(null, "");
    row.addedAt = Date.now();
    getHoustonSheet(state.activeDate).push(row);
    renderHoustonBoardTable();
    const input = document.querySelector(`#${row.id} input[data-field="driverName"]`);
    if (input) input.focus();
  }

  function toggleHoustonShiftComplete(rowId) {
    const found = findHoustonRowAnywhere(rowId);
    if (!found) return;
    found.row.shiftComplete = !found.row.shiftComplete;
    saveHoustonRowNow(found.row);
    renderHoustonBoardTable();
  }

  async function deleteHoustonRow(rowId) {
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

  function textHoustonDriverForRow(rowId) {
    const found = findHoustonRowAnywhere(rowId);
    if (!found) return;
    const drv = found.row.driverId ? findDriver(found.row.driverId) : null;
    textDriverPhone(drv ? drv.phone : found.row.driverPhone);
  }

  async function openHoustonLoadHistoryModal(rowId) {
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

  function openHoustonRowContextMenu(rowId, x, y) {
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

  function openHoustonDateDropdown() {
    calendarViewMonth = null;
    renderCalendarGrid(houstonState.datesWithData);
    $("#date-dropdown").classList.remove("hidden");
  }

  function handleRealtimeHoustonChange(payload) {
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

  function setupHoustonRealtimeSync() {
    if (!supabaseClient) return;
    const channel = supabaseClient.channel("board-houston");
    channel.on("postgres_changes", { event: "*", schema: "public", table: "loads_houston" }, handleRealtimeHoustonChange);
    channel.on("postgres_changes", { event: "*", schema: "public", table: "atlanta_drivers" }, handleRealtimeDriverChange);
    channel.subscribe();
  }

  async function submitHoustonAddLoad() {
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

  function initHoustonBoardPage(info) {
    state.activeLocation = "houston";
    loadAndRenderHoustonBoard();
    setupHoustonRealtimeSync();
    loadHoustonDatesWithData().catch((e) => console.error("loadHoustonDatesWithData() failed:", e));

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
      if (e.target.id === "btn-quick-add-row") quickAddHoustonBlankRow();
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
      }
      scheduleHoustonRowSave(found.row);
    });

    // Add Load modal on this page saves via the Houston path instead
    const alSubmit = $("#al-submit");
    if (alSubmit) alSubmit.addEventListener("click", submitHoustonAddLoad);
  }

  function setHoustonActiveDate(newKey) {
    if (newKey < state.minDate || newKey > state.maxDate) return;
    state.activeDate = newKey;
    loadAndRenderHoustonBoard();
  }

  /* ================================================================
     Accounting calculation engine — ported from a Python reference
     implementation validated against 6 real rows from the actual
     accounting workbook (every field matched exactly). Pricing tiers
     and settings are fetched live from Supabase so they stay editable
     without a code change.
     ================================================================ */

  const ACCOUNTING_TABLE = "loads_accounting";
  const ACCOUNTING_ROUTES_TABLE = "loads_accounting_routes";
  let pricingTiers = null;   // { cost_1: [{min,max,rate}...], revenue_2: [...], ... }
  let pricingSettings = null; // { fsc_rate: 5.06, cost_1_per_mile: 2.4, ... }

  async function loadPricingData() {
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

  function tierLookup(tableRows, miles) {
    if (!tableRows) return null;
    const hit = tableRows.find((t) => miles >= t.min && miles <= t.max);
    return hit ? hit.rate : null;
  }

  // Pure function — same logic as the validated Python reference. Takes
  // pricing data as an argument (rather than reading module state) so it
  // stays independently testable.
  function calcRoute({ costLevel, revenueLevel, miles, stops, contractRate }, tiers, settings) {
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

  function calcFscPayment(fscRate, totalMiles, settings) {
    const mult = settings.fsc_multiplier || 0;
    return Math.round(fscRate * mult * totalMiles * 100) / 100;
  }

  async function sendShiftToAccounting(row, locationKey, dKey) {
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

  /* ---------------- Accounting page ---------------- */

  let accountingRecords = [];

  async function loadAccountingRecords() {
    if (!supabaseClient) return;
    const { data, error } = await supabaseClient.from(ACCOUNTING_TABLE).select("*");
    if (error) { console.error("Failed to load accounting records:", error); setDriverSyncStatus(`Couldn't load Accounting (${error.message}).`, "error"); return; }
    accountingRecords = (data || []).sort((a, b) => (a.shift_date < b.shift_date ? 1 : -1));
  }

  function fmtMoney(n) { return n == null ? "—" : `$${Number(n).toFixed(2)}`; }

  function accountingRowHtml(rec) {
    const levelOptions = (selected) => [1, 2, 3, 4].map((n) => `<option value="${n}" ${n === selected ? "selected" : ""}>${n}${n === 4 ? " (Market)" : ""}</option>`).join("");
    const statusOptions = ["active", "released"].map((s) => `<option value="${s}" ${s === rec.status ? "selected" : ""}>${s[0].toUpperCase() + s.slice(1)}</option>`).join("");
    return `<tr id="acct-${rec.id}">
      <td>${escapeHtml(rec.shift_date)}</td>
      <td>${escapeHtml(rec.aljex_load_number || "—")}</td>
      <td>${escapeHtml(rec.driver_name_text || "—")}</td>
      <td>${escapeHtml(rec.mc_dot || "—")}</td>
      <td><select class="cell-input" data-action="acct-cost-level" data-id="${rec.id}">${levelOptions(rec.cost_level)}</select></td>
      <td><select class="cell-input" data-action="acct-revenue-level" data-id="${rec.id}">${levelOptions(rec.revenue_level)}</select></td>
      <td>${escapeHtml(rec.total_miles != null ? String(rec.total_miles) : "—")}</td>
      <td>${escapeHtml(rec.total_stops != null ? String(rec.total_stops) : "—")}</td>
      <td>${fmtMoney(rec.total_cost)}</td>
      <td>${fmtMoney(rec.total_revenue)}</td>
      <td>${fmtMoney(rec.fsc_payment)}</td>
      <td><input class="cell-input" style="width:90px;" data-action="acct-carrier-pay" data-id="${rec.id}" value="${rec.total_carrier_pay != null ? rec.total_carrier_pay : ""}"></td>
      <td><select class="cell-input" data-action="acct-status" data-id="${rec.id}">${statusOptions}</select></td>
    </tr>`;
  }

  function renderAccountingTable() {
    const body = $("#accounting-table-body");
    if (!body) return;
    const loc = state.acctLocationTab || "atlanta";
    let filtered = accountingRecords.filter((r) => r.location === loc);
    if (state.acctDateFilter) filtered = filtered.filter((r) => r.shift_date === state.acctDateFilter);
    body.innerHTML = filtered.length
      ? filtered.map(accountingRowHtml).join("")
      : `<tr><td colspan="13" class="subtext" style="padding:16px;">No completed loads ${state.acctDateFilter ? "for this day" : ""} here yet — mark a shift complete on the ${loc} board and it'll show up here.</td></tr>`;
  }

  function switchAcctLocationTab(loc) {
    state.acctLocationTab = loc;
    $all(".location-tab", $("#acct-location-tabs")).forEach((btn) => btn.classList.toggle("is-active", btn.dataset.location === loc));
    renderAccountingTable();
  }

  function setAcctDateFilter(dKey) {
    state.acctDateFilter = dKey;
    state.activeDate = dKey; // reuses the shared calendar's "selected day" highlighting
    renderAcctDateChrome();
    renderAccountingTable();
  }

  async function recalcAccountingRecord(accountingId, patch) {
    accountingId = Number(accountingId);
    const rec = accountingRecords.find((r) => Number(r.id) === accountingId);
    if (!rec) return;
    Object.assign(rec, patch);
    if (!pricingTiers || !pricingSettings) await loadPricingData();

    const { data: routes, error } = await supabaseClient.from(ACCOUNTING_ROUTES_TABLE).select("*").eq("accounting_id", accountingId);
    if (error) { console.error("Failed to load routes for recalc:", error); return; }

    let totalCost = 0, totalRevenue = 0;
    const routeUpdates = (routes || []).map((r) => {
      const calc = calcRoute({ costLevel: rec.cost_level, revenueLevel: rec.revenue_level, miles: Number(r.miles) || 0, stops: Number(r.stops) || 0, contractRate: rec.contract_rate }, pricingTiers, pricingSettings);
      totalCost += calc.totalCost; totalRevenue += calc.totalRevenue;
      return { id: r.id, linehaul_cost: calc.linehaulCost, stop_charge: calc.stopCharge, total_cost: calc.totalCost, revenue: calc.revenue, stop_charge_revenue: calc.stopChargeRevenue, total_revenue: calc.totalRevenue };
    });

    rec.total_cost = Math.round(totalCost * 100) / 100;
    rec.total_revenue = Math.round(totalRevenue * 100) / 100;

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

  function renderAcctDateChrome() {
    const input = $("#date-input");
    if (!input) return;
    input.value = state.activeDate || state.todayKey;
    input.min = state.minDate;
    input.max = state.maxDate;
    if ($("#date-next")) $("#date-next").disabled = (state.activeDate || state.todayKey) >= state.maxDate;
    if ($("#date-prev")) $("#date-prev").disabled = (state.activeDate || state.todayKey) <= state.minDate;
  }

  async function initAccountingPage() {
    // Accounting looks back further than the boards do — override the
    // shared min/max just for this page's calendar.
    state.minDate = dateKey(addDays(todayDate(), -60));
    state.maxDate = state.todayKey;
    state.acctLocationTab = "atlanta";
    state.acctDateFilter = null;

    await loadPricingData();
    if (pricingSettings && $("#fsc-rate-input")) $("#fsc-rate-input").value = pricingSettings.fsc_rate || "";
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
        pricingSettings.fsc_rate = val;
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
    }
  }

  function setupAccountingRealtimeSync() {
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

  /* ---------------- init ---------------- */

  function init() {
    try { renderNav(); } catch (e) { console.error("renderNav() failed:", e); }
    const info = PAGE_MAP[currentFile()];
    try { wireModals(); } catch (e) { console.error("wireModals() failed:", e); }
    try {
      if (info.type === "board") initBoardPage(info);
      else if (info.type === "houston-board") initHoustonBoardPage(info);
      else if (info.type === "driverlist") initDriverListPage();
      else if (info.type === "accounting") initAccountingPage();
    } catch (e) { console.error("page-specific init failed:", e); }
    loadDriversFromSupabase().catch((e) => console.error("loadDriversFromSupabase() failed:", e));
  }

  document.addEventListener("DOMContentLoaded", init);
})();