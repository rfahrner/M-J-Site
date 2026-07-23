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
import { initAccountingPage, getAccountingRecordById } from './accounting.js';
import { sendShiftToAccounting } from './accountingcalc.js';
import { initHoustonBoardPage } from './houston.js';
import { initMondelezPage } from './mondelez.js';
import { renderNav, startAlertScanning, IDLE_THRESHOLD_MIN, PRE_SHIFT_TEXT_LEAD_MIN, PRE_SHIFT_CALL_FOLLOWUP_MIN } from './alerts.js';
import { loadBoardRateData, getBoardRateTiers, calcLoadRateBreakdown, effectiveTierRate, effectiveSetting, isTierOverridden, isSettingOverridden } from './boardrates.js';

  /* ---------------- page map (single source of truth for nav) ---------------- */

  export const PAGE_MAP = {
    "index.html":      { type: "board",       key: "atlanta",   label: "Atlanta",    title: "Atlanta Spreadsheet"    },
    "dalaware.html":   { type: "board",       key: "delaware",  label: "Delaware",   title: "Delaware Spreadsheet"   },
    "buildingc.html":  { type: "board",       key: "buildingc", label: "Building C", title: "Building C Spreadsheet" },
    "houston.html":    { type: "houston-board", key: "houston",   label: "Houston",    title: "Houston Spreadsheet"    },
    "mondelez.html":   { type: "mondelez",    label: "Mondelez" },
    "accounting.html": { type: "accounting",  label: "Accounting" },
    "driverlist.html": { type: "driverlist",  label: "Driver List" },
    "historics.html":  { type: "historics",   label: "Historics" },
  };
  export const NAV_ORDER = ["index.html", "dalaware.html", "buildingc.html", "houston.html", "mondelez.html", "accounting.html", "driverlist.html", "historics.html"];
  const LOCATIONS = NAV_ORDER
    .filter((f) => PAGE_MAP[f].type === "board" || PAGE_MAP[f].type === "houston-board")
    .map((f) => ({ file: f, ...PAGE_MAP[f] }));

  export function currentFile() {
    const p = location.pathname.split("/").pop();
    return p && PAGE_MAP[p] ? p : "index.html";
  }

  /* ---------------- constants ---------------- */

  const HIGHLIGHT_MS = 30 * 60 * 1000; // 30 minutes, per spec
  const HISTORY_DAYS = 21;              // 3 weeks live on the board; older goes to Historics
  const FUTURE_DAYS = 14;               // how far ahead loads can be pre-scheduled
  export const AVG_MPH = 45;                   // placeholder speed for calc columns

  // Prompted to send when a dispatcher marks a trip as Salvage or Backhaul.
  // NOTE: the two message bodies were given to me with the trigger labels
  // swapped (the "if backhaul" message text described a salvage pickup, and
  // vice versa) — mapped here to match what each message actually SAYS,
  // flagged clearly in chat rather than silently guessed.
  const SALVAGE_MESSAGE = "This is D&L, you have a salvage pick up at your last stop. Please Call or text me your return info (what trailer the salvage is on, if anything was missing or damaged, and your ETA back) when you are done at your last stop, Also a pic of your stores in and out times.";
  const BACKHAUL_MESSAGE = "This is D&L, you have a Backhaul pickup at your last stop. Please Call or text me your return info (what trailer the load is on, if anything was missing or damaged, and your ETA back) when you are done at your last stop, Also a pic of your stores in and out times.";

  const TRIP_SUBCOLS = [
    { key: "routeId",     label: "Route ID",         type: "text", pistachio: true },
    { key: "tripId",      label: "Trip ID",           type: "text", pistachio: true },
    { key: "trailerOut",  label: "Trailer #",         type: "text", pistachio: true },
    { key: "routeMiles",  label: "Miles",             type: "text", small: true, inputmode: "decimal", pistachio: true },
    { key: "stopCount",   label: "Stops",              type: "text", small: true, inputmode: "numeric", pistachio: true },
    { key: "dispatchTime",label: "Dispatch Time",     type: "time", pistachio: true },
    { key: "lastStopDepart",  label: "Last Stop Depart",   type: "time", pistachio: true },
    { key: "returnToDC",      label: "Return to DC",       type: "time", pistachio: true },
    { key: "salvage",     label: "Salvage",            type: "checkbox", group: "backhaul", pistachio: true },
    { key: "backhaul",    label: "B/Haul",             type: "checkbox", group: "backhaul", pistachio: true },
    { key: "salvageBhaulRefusedBy",  label: "Refused By",          type: "text", group: "backhaul", pistachio: true },
    { key: "backhaulTrailerNumber",  label: "B/Haul Trailer #",    type: "text", group: "backhaul", pistachio: true },
    { key: "returnEtaToDc",          label: "Return ETA to DC",    type: "time", group: "backhaul", pistachio: true },
    { key: "ppwkReceived",           label: "Ppwk Rec'd",          type: "checkbox", group: "backhaul", pistachio: true },
    { key: "routeEstHours",   label: "Route Est Hours",    type: "text", small: true, inputmode: "decimal", group: "estimate" },
    // Not in the latest specified order -- kept available (hidden by
    // default) rather than deleted, since removal wasn't explicit. Flagged
    // in chat; say the word if any of these should actually go.
    { key: "backhaulType",           label: "B/Haul Type",         type: "text", group: "backhaul" },
    { key: "etaToFinalStop",         label: "ETA to Final Stop",   type: "time", group: "estimate" },
    { key: "estRouteComplete",       label: "Est Route Complete",  type: "time", group: "estimate" },
    { key: "etaNextDispatch", label: "ETA Next Dispatch",  type: "calc" },
    { key: "tripCallTime",    label: "Trip Call Time",     type: "calc" },
  ];

  // Drag-to-reorder for the trip columns, persisted per-browser. Keeps
  // TRIP_SUBCOLS itself as the source of truth for which columns exist —
  // this is purely a display-order overlay on top of it, so adding or
  // removing a column in code later never gets silently lost: unknown
  // saved keys are dropped, and any column missing from a saved order
  // (newly added since) is appended at the end rather than hidden.
  let tripColOrder = TRIP_SUBCOLS.map((c) => c.key);
  try {
    const saved = JSON.parse(localStorage.getItem("dl-trip-col-order") || "null");
    if (Array.isArray(saved)) {
      const validKeys = new Set(TRIP_SUBCOLS.map((c) => c.key));
      const kept = saved.filter((k) => validKeys.has(k));
      const missing = TRIP_SUBCOLS.map((c) => c.key).filter((k) => !kept.includes(k));
      tripColOrder = [...kept, ...missing];
    }
  } catch (e) { /* malformed localStorage — fall back to the default order */ }

  function getOrderedTripSubcols() {
    const byKey = {};
    TRIP_SUBCOLS.forEach((c) => { byKey[c.key] = c; });
    return tripColOrder.map((k) => byKey[k]).filter(Boolean);
  }

  function saveTripColOrder() {
    try { localStorage.setItem("dl-trip-col-order", JSON.stringify(tripColOrder)); } catch (e) { /* ignore quota errors */ }
  }

  function moveTripCol(key, beforeKey) {
    tripColOrder = tripColOrder.filter((k) => k !== key);
    if (beforeKey == null) {
      tripColOrder.push(key);
    } else {
      const idx = tripColOrder.indexOf(beforeKey);
      tripColOrder.splice(idx === -1 ? tripColOrder.length : idx, 0, key);
    }
    saveTripColOrder();
    renderBoardTable();
    const panel = $("#columns-panel");
    if (panel) panel.innerHTML = buildColumnsPanelHtml(); // keep the show/hide list in sync with the new order too
  }

  /* ---------------- Supabase (drivers only, for now — loads aren't backed by a table yet) ---------------- */

  export const SUPABASE_URL = "https://ygsapysqzwrpcimgvaqx.supabase.co";
  export const SUPABASE_KEY = "sb_publishable_8b8bSIiYm5TzLTw0WG1pAw_5ZWW5ZPL"; // publishable key — safe to be public
  export const DRIVERS_TABLE = "atlanta_drivers";
  export const SHIFTS_TABLE = "loads_shifts";
  export const TRIPS_TABLE = "loads_trips";
  export const ACCOUNTING_TABLE = "loads_accounting";
  export const ACCOUNTING_ROUTES_TABLE = "loads_accounting_routes";

  // The Supabase CDN <script> tag should always finish before this module
  // (module scripts are deferred by the browser regardless of the defer
  // attribute), but a slow network or a flaky CDN edge can occasionally
  // still win the race. Rather than giving up forever the instant
  // window.supabase isn't there yet, wait briefly for it to show up —
  // this uses top-level await, so nothing that imports from this module
  // (which is everything) runs until this resolves one way or the other.
  async function waitForSupabaseGlobal(maxWaitMs) {
    if (typeof window === "undefined") return null;
    const start = Date.now();
    while (!window.supabase && Date.now() - start < maxWaitMs) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return window.supabase || null;
  }

  const supabaseGlobal = await waitForSupabaseGlobal(4000);
  export const supabaseClient = supabaseGlobal
    ? supabaseGlobal.createClient(SUPABASE_URL, SUPABASE_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, storageKey: "dl-dispatch-auth" },
      })
    : null;

  let currentUserRole = null; // set by requireAuth() before any page-specific init runs
  let currentUserLabel = null; // "username" (the @dltransport.local suffix stripped) — used for audit logging

  async function requireAuth() {
    if (!supabaseClient) return true; // no client configured (e.g. local test) — don't block
    const { data } = await supabaseClient.auth.getSession();
    if (!data.session) {
      window.location.href = "login.html";
      return false;
    }
    const { data: userData } = await supabaseClient.auth.getUser();
    currentUserRole = (userData && userData.user && userData.user.user_metadata && userData.user.user_metadata.role) || null;
    const email = (userData && userData.user && userData.user.email) || "";
    currentUserLabel = email.includes("@") ? email.split("@")[0] : (email || "unknown user");
    supabaseClient.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") window.location.href = "login.html";
    });
    return true;
  }

  export function isAccountingUser() { return currentUserRole === "accounting"; }

  export async function signOut() {
    if (supabaseClient) await supabaseClient.auth.signOut();
    window.location.href = "login.html";
  }

  function driverToDbRow(d) {
    return {
      "Driver Name": d.name,
      "Driver Cell": d.phone,
      "MC": d.mc === "" || d.mc == null ? null : Number(d.mc),
      "Dispatcher phone number": d.dispatcherPhone || null,
      "E mail": d.email,
      "2nd email": d.email2 || null,
      "Driver Rating": d.rating || null,
      "Driver Preference": d.preference || null,
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
      preference: row["Driver Preference"] || "",
      notes: row["Notes"] || "",
      tia: !!row["Interchange agreement"],
      tiiAmount: row["Interchange Coverage $"] != null ? Number(row["Interchange Coverage $"]) : null,
      carrier: row["Carrier"] || "",
      rateBooking: row["Rate/booking contact"] || "",
      normalRate: row["normal_rate"] != null ? String(row["normal_rate"]) : "",
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
      carrier_rate: row.rate === "" || row.rate == null ? null : Number(row.rate),
      notes: row.notes || null,
      pre_shift_text_sent: !!row.preShiftTextSent,
      pre_shift_call: !!row.preShiftCall,
      eta_shift_report: row.etaShiftReport || null,
      actual_shift_report: row.actualShiftReport || null,
      rev_level: row.revLevel || null,
      timesheet_received: !!row.timesheetReceived,
      timesheet_start_time: row.timesheetStartTime || null,
      timesheet_end_time: row.timesheetEndTime || null,
      trailer_drop_location: row.trailerDropLocation || null,
      pre_shift_text_sent_at: row.preShiftTextSentAt || null,
      birm: !!row.birm,
      route_type: row.routeType || "birm",
      hostler_hours: row.hostlerHours !== "" && row.hostlerHours != null ? Number(row.hostlerHours) : null,
      rate_manual: !!row.rateManual,
      rate_overrides: (row.rateOverrides && (Object.keys(row.rateOverrides.tiers || {}).length || Object.keys(row.rateOverrides.settings || {}).length)) ? row.rateOverrides : null,
    };
  }
  function shiftFromDbRow(dbRow) {
    return {
      id: uid("row"),
      dbId: dbRow.id,
      location: dbRow.location || null,
      shiftDate: dbRow.shift_date || null,
      driverId: dbRow.driver_id != null ? String(dbRow.driver_id) : null,
      driverNameText: dbRow.driver_name_text || "",
      proNumber: dbRow.pro_number || "",
      tonu: !!dbRow.tonu,
      highlighted: !!dbRow.highlighted,
      shiftStart: dbRow.shift_start || "",
      shiftComplete: !!dbRow.shift_complete,
      shiftCompleteAt: dbRow.shift_complete_at || null,
      rate: dbRow.carrier_rate != null ? String(dbRow.carrier_rate) : "",
      notes: dbRow.notes || "",
      preShiftTextSent: !!dbRow.pre_shift_text_sent,
      preShiftCall: !!dbRow.pre_shift_call,
      etaShiftReport: dbRow.eta_shift_report || "",
      actualShiftReport: dbRow.actual_shift_report || "",
      revLevel: dbRow.rev_level || "",
      timesheetReceived: !!dbRow.timesheet_received,
      timesheetStartTime: dbRow.timesheet_start_time || "",
      timesheetEndTime: dbRow.timesheet_end_time || "",
      trailerDropLocation: dbRow.trailer_drop_location || "",
      preShiftTextSentAt: dbRow.pre_shift_text_sent_at || null,
      birm: !!dbRow.birm,
      routeType: dbRow.route_type || "birm",
      hostlerHours: dbRow.hostler_hours != null ? String(dbRow.hostler_hours) : "",
      rateManual: !!dbRow.rate_manual,
      rateOverrides: dbRow.rate_overrides ? { tiers: dbRow.rate_overrides.tiers || {}, settings: dbRow.rate_overrides.settings || {} } : { tiers: {}, settings: {} },
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
      last_stop_depart: trip.lastStopDepart || null,
      return_to_dc: trip.returnToDC || null,
      salvage: !!trip.salvage,
      backhaul: !!trip.backhaul,
      minimized: !!trip.minimized,
      complete: !!trip.complete,
      driver_id: trip.driverId ? Number(trip.driverId) : null,
      notes: trip.notes || null,
      current_route_status: trip.currentRouteStatus || null,
      current_backhaul_status: trip.currentBackhaulStatus || null,
      next_call_time: trip.nextCallTime || null,
      backhaul_location: trip.backhaulLocation || null,
      salvage_bhaul_refused_by: trip.salvageBhaulRefusedBy || null,
      backhaul_trailer_number: trip.backhaulTrailerNumber || null,
      backhaul_type: trip.backhaulType || null,
      return_eta_to_dc: trip.returnEtaToDc || null,
      return_drop_location: trip.returnDropLocation || null,
      ppwk_received: !!trip.ppwkReceived,
      timesheet_start_time: trip.timesheetStartTime || null,
      timesheet_end_time: trip.timesheetEndTime || null,
      drop_location_text: trip.dropLocationText || null,
      return_to_dc_text: trip.returnToDcText || null,
      route_est_hours: trip.routeEstHours !== "" && trip.routeEstHours != null ? Number(trip.routeEstHours) : null,
      time_to_final_stop: trip.timeToFinalStop || null,
      eta_to_final_stop: trip.etaToFinalStop || null,
      est_route_complete: trip.estRouteComplete || null,
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
      lastStopDepart: dbRow.last_stop_depart || "",
      returnToDC: dbRow.return_to_dc || "",
      salvage: !!dbRow.salvage,
      backhaul: !!dbRow.backhaul,
      minimized: !!dbRow.minimized,
      complete: !!dbRow.complete,
      driverId: dbRow.driver_id != null ? String(dbRow.driver_id) : null,
      notes: dbRow.notes || "",
      currentRouteStatus: dbRow.current_route_status || "",
      currentBackhaulStatus: dbRow.current_backhaul_status || "",
      nextCallTime: dbRow.next_call_time || "",
      backhaulLocation: dbRow.backhaul_location || "",
      salvageBhaulRefusedBy: dbRow.salvage_bhaul_refused_by || "",
      backhaulTrailerNumber: dbRow.backhaul_trailer_number || "",
      backhaulType: dbRow.backhaul_type || "",
      returnEtaToDc: dbRow.return_eta_to_dc || "",
      returnDropLocation: dbRow.return_drop_location || "",
      ppwkReceived: !!dbRow.ppwk_received,
      timesheetStartTime: dbRow.timesheet_start_time || "",
      timesheetEndTime: dbRow.timesheet_end_time || "",
      dropLocationText: dbRow.drop_location_text || "",
      returnToDcText: dbRow.return_to_dc_text || "",
      routeEstHours: dbRow.route_est_hours != null ? String(dbRow.route_est_hours) : "",
      timeToFinalStop: dbRow.time_to_final_stop || "",
      etaToFinalStop: dbRow.eta_to_final_stop || "",
      estRouteComplete: dbRow.est_route_complete || "",
    };
  }

  /* ---------------- tiny helpers ---------------- */

  let uidCounter = 1000;
  export const uid = (prefix) => `${prefix}_${uidCounter++}`;

  export const escapeHtml = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));

  function fmtRateMoney(n) { return n == null || isNaN(n) ? "—" : `$${Number(n).toFixed(2)}`; }

  export function todayDate() { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }
  export function dateKey(d) {
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
  export function keyToDate(k) { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d); }
  export function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
  function humanDate(d) { return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" }); }
  function shortHumanDate(d) { return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }); }

  export function parseHHMM(str) {
    if (!str) return null;
    const m = /^(\d{1,2}):(\d{2})$/.exec(str.trim());
    if (!m) return null;
    return Number(m[1]) * 60 + Number(m[2]);
  }
  export function minsToClock(mins) {
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

  export const state = {
    activeLocation: null,   // set by initBoardPage() on board pages only
    activeDate: dateKey(todayDate()),
    drivers: [],
    sheets: {},              // `${locationKey}__${dateKey}` -> Row[]
    availableSheets: {},     // `${locationKey}__${dateKey}` -> AvailableRow[]
    minDate: dateKey(addDays(todayDate(), -HISTORY_DAYS)),
    maxDate: dateKey(addDays(todayDate(), FUTURE_DAYS)),
    todayKey: dateKey(todayDate()),
    pendingAddLoadDriverId: null,
    addDriverNestedFromLoad: false,
    driverSort: { key: null, dir: "asc" },
    driverListTab: "atlanta", // only meaningful on the Driver List page — its 3 tabs
    datesWithData: new Set(), // which days in the browsable range have any loads — for the date dropdown
    hiddenCols: new Set([
      "email", "dispatcherPhone", "shiftDate", "rating", "driverPreference", "shiftHosLeft", "revLevel", // shift-level, hidden per spec
      "routeEstHours", // trip-level, hidden per spec
      "backhaulType", "etaToFinalStop", "estRouteComplete", "etaNextDispatch", "tripCallTime", // not in the latest spec — kept but hidden, not deleted
    ]),
    editingDriverId: null,
  };

  const DRIVER_INFO_COLS = [
    { key: "cell", label: "Cell" },
    { key: "dispatcherPhone", label: "Dispatcher Phone" },
    { key: "email", label: "Email" },
    { key: "shiftDate", label: "Date" },
    { key: "mc", label: "MC #" },
    { key: "rating", label: "Rating" },
    { key: "driverPreference", label: "Driver Preference" },
    { key: "shiftStart", label: "Shift Start" },
    { key: "etaShiftReport", label: "ETA" },
    { key: "shiftHosLeft", label: "HOS Left" },
    { key: "revLevel", label: "Rev Level" },
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
    const cmp = (key === "mc" || key === "normalRate")
      ? Number(av) - Number(bv)
      : String(av).localeCompare(String(bv), undefined, { sensitivity: "base", numeric: true });
    return dir === "desc" ? -cmp : cmp;
  }

  function locationGroupFor(locationKey) {
    if (locationKey === "buildingc") return ["atlanta"]; // shares Atlanta's pool
    return [locationKey];
  }
  export function driversForLocation(locationKey) {
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
    return {
      id: uid("trip"), dbId: null, routeId: "", tripId: "", trailerOut: "", routeMiles: "", stopCount: "", dispatchTime: "", salvage: false, backhaul: false, minimized: false, complete: false, driverId: null, notes: "",
      lastStopDepart: "", returnToDC: "",
      currentRouteStatus: "", currentBackhaulStatus: "", nextCallTime: "", backhaulLocation: "", salvageBhaulRefusedBy: "", backhaulTrailerNumber: "", backhaulType: "",
      returnEtaToDc: "", returnDropLocation: "", ppwkReceived: false, timesheetStartTime: "", timesheetEndTime: "", dropLocationText: "", returnToDcText: "",
      routeEstHours: "", timeToFinalStop: "", etaToFinalStop: "", estRouteComplete: "",
    };
  }
  function blankRow(driverId, driverNameText) {
    return {
      id: uid("row"), dbId: null, location: state.activeLocation || null, shiftDate: state.activeDate || null,
      driverId: driverId || null, driverNameText: driverNameText || "",
      proNumber: "", tonu: false, highlighted: false, shiftStart: "", shiftComplete: false, shiftCompleteAt: null, rate: "", notes: "", selected: false,
      preShiftTextSent: false, preShiftCall: false, etaShiftReport: "", actualShiftReport: "", revLevel: "",
      timesheetReceived: false, timesheetStartTime: "", timesheetEndTime: "", trailerDropLocation: "", preShiftTextSentAt: null,
      createdAt: null, updatedAt: null, addedAt: null,
      cellSnapshot: "", mcSnapshot: "", emailSnapshot: "", dispatcherPhoneSnapshot: "", ratingSnapshot: "",
      birm: false, routeType: "birm", hostlerHours: "", rateManual: false, rateOverrides: { tiers: {}, settings: {} },
      trips: [blankTrip()],
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
  export async function ensureSheetLoaded(locationKey, dKey) {
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
          const mine = tripRows.filter((t) => t.shift_id === dbId).sort((a, b) => a.trip_number - b.trip_number);
          row.trips = mine.map(tripFromDbRow);
          if (!row.trips.length || row.trips[row.trips.length - 1].minimized) row.trips.push(blankTrip());
        });
      }
    }
    state.sheets[k] = rows;
  }
  export function findDriver(id) { return state.drivers.find((d) => String(d.id) === String(id)) || null; }
  const standaloneLoadedRows = {}; // row.id -> row, for modal access from pages that don't have state.sheets (e.g. Accounting)

  function findRowAnywhere(rowId) {
    for (const k in state.sheets) {
      const r = state.sheets[k].find((x) => x.id === rowId);
      if (r) return { row: r, sheetKey: k };
    }
    if (standaloneLoadedRows[rowId]) return { row: standaloneLoadedRows[rowId], sheetKey: null };
    return null;
  }

  /* ---------------- driver sync status banner ---------------- */

  export function setDriverSyncStatus(message, kind) {
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

  export const SAVE_DEBOUNCE_MS = 700;
  const shiftSaveTimers = new Map();
  const tripSaveTimers = new Map();

  // Handles both create (row.dbId is null) and update (row.dbId is set)
  // transparently — callers never need to branch on which one applies.
  async function saveShiftNow(row) {
    if (!supabaseClient) return null;
    try {
      const payload = shiftToDbRow(row, row.location || state.activeLocation, row.shiftDate || state.activeDate);
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

  function labelForRow(row) {
    const drv = row.driverId ? findDriver(row.driverId) : null;
    return row.proNumber || (drv ? drv.name : row.driverNameText) || "(unlabeled load)";
  }

  // Generic audit-log write, reused by every tracked event (notes, route/
  // shift completion, TONU, delete, reassignment). shift_id is set when
  // available but load_label is always captured too, so entries stay
  // readable even after the parent load is deleted.
  async function logChange(shiftDbId, label, fieldName, oldValue, newValue) {
    if (!supabaseClient) return;
    try {
      await supabaseClient.from("load_change_history").insert({
        shift_id: shiftDbId || null,
        load_label: label || null,
        field_name: fieldName,
        old_value: oldValue != null ? String(oldValue) : null,
        new_value: newValue != null ? String(newValue) : null,
        changed_by: currentUserLabel || "unknown user",
      }).select();
    } catch (e) {
      console.error("logChange failed:", e); // never block the actual action over a logging failure
    }
  }

  async function minimizeTrip(rowId, tripId) {
    const found = findRowAnywhere(rowId);
    if (!found) return;
    const row = found.row;
    const trip = row.trips.find((t) => t.id === tripId);
    if (!trip) return;
    trip.minimized = true;
    await saveTripNow(row, trip, row.trips.indexOf(trip) + 1);
    renderBoardTable();
  }

  async function restoreTrip(rowId, tripId) {
    const found = findRowAnywhere(rowId);
    if (!found) return;
    const row = found.row;
    const trip = row.trips.find((t) => t.id === tripId);
    if (!trip) return;
    trip.minimized = false;
    await saveTripNow(row, trip, row.trips.indexOf(trip) + 1);
    renderBoardTable();
  }

  function addNewTrip(rowId) {
    const found = findRowAnywhere(rowId);
    if (!found) return;
    found.row.trips.push(blankTrip());
    renderBoardTable();
  }

  function completeTrip(rowId, tripId) {
    const found = findRowAnywhere(rowId);
    if (!found) return;
    const trip = found.row.trips.find((t) => t.id === tripId);
    if (!trip || !String(trip.routeId || "").trim()) return;
    openStopTimesModal(rowId, tripId);
  }

  let stopTimesModalState = null; // { rowId, tripId, stopCount }

  function openStopTimesModal(rowId, tripId) {
    const found = findRowAnywhere(rowId);
    if (!found) return;
    const trip = found.row.trips.find((t) => t.id === tripId);
    if (!trip || !$("#modal-stop-times")) return;
    const stopCount = Math.max(0, parseInt(trip.stopCount, 10) || 0);
    stopTimesModalState = { rowId, tripId, stopCount };
    $("#st-stop-fields").innerHTML = stopCount
      ? stopFieldsHtml(stopCount, [])
      : `<div class="subtext">No stop count set on this trip — nothing to fill in, but you can still confirm or skip.</div>`;
    $("#modal-stop-times").classList.remove("hidden");
  }

  function closeStopTimesModal() {
    if ($("#modal-stop-times")) $("#modal-stop-times").classList.add("hidden");
    stopTimesModalState = null;
  }

  async function finalizeTripCompletion(saveStopTimes) {
    if (!stopTimesModalState) return;
    const { rowId, tripId, stopCount } = stopTimesModalState;
    const found = findRowAnywhere(rowId);
    if (!found) { closeStopTimesModal(); return; }
    const row = found.row;
    const trip = row.trips.find((t) => t.id === tripId);
    if (!trip) { closeStopTimesModal(); return; }

    if (saveStopTimes && stopCount > 0 && supabaseClient && trip.dbId) {
      for (let i = 0; i < stopCount; i++) {
        const timeInEl = document.querySelector(`#modal-stop-times [data-stop-field="timeIn"][data-stop-index="${i}"]`);
        const timeOutEl = document.querySelector(`#modal-stop-times [data-stop-field="timeOut"][data-stop-index="${i}"]`);
        const timeIn = timeInEl ? timeInEl.value.trim() : "";
        const timeOut = timeOutEl ? timeOutEl.value.trim() : "";
        if (!timeIn && !timeOut) continue; // nothing entered for this stop — don't create an empty record
        try {
          await supabaseClient.from("trip_stops").insert({ trip_id: trip.dbId, stop_number: i + 1, time_in: timeIn || null, time_out: timeOut || null });
        } catch (e) {
          console.error("Saving stop time failed:", e);
        }
      }
    }

    trip.complete = true;
    trip.minimized = true;
    await saveTripNow(row, trip, row.trips.indexOf(trip) + 1);
    logChange(row.dbId, `${labelForRow(row)} — ${trip.routeId || trip.tripId || "route"}`, "route_complete", "false", "true");
    closeStopTimesModal();
    renderBoardTable();
    flashTripGreenTint(rowId, tripId);
  }

  function flashTripGreenTint(rowId, tripId) {
    // the trip has already collapsed into a chip by the time this runs — flash the chip itself
    requestAnimationFrame(() => {
      const chip = document.querySelector(`.trip-chip[data-row="${rowId}"][data-trip="${tripId}"]`);
      if (!chip) return;
      chip.classList.add("shift-complete-tint", "trip-just-completed-flash");
      setTimeout(() => chip.classList.remove("trip-just-completed-flash"), 1600);
    });
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

  // Last Stop Depart and Return to DC are editable trip fields now
  // (trip.lastStopDepart / trip.returnToDC), not pure calculations — see
  // autoFillCalcTimes() below for how they get their initial 45mph-based
  // value. What's left here is just ETA Next Dispatch / HOS Left / Trip
  // Call Time, which key off whichever Return to DC time is actually
  // showing (a manual entry if there is one, otherwise the same 45mph
  // estimate) so a correction to the real return time flows through
  // instead of getting silently ignored.
  function computeCalc(trip, row) {
    const dispatch = parseHHMM(trip.dispatchTime);
    const miles = parseFloat(trip.routeMiles);
    const out = { etaNextDispatch: "", hosLeft: "", tripCallTime: "" };
    if (dispatch != null) out.tripCallTime = minsToClock(dispatch - 30);

    let returnMin = parseHHMM(trip.returnToDC);
    if (returnMin == null && dispatch != null && !isNaN(miles) && miles > 0) {
      const leg = (miles / AVG_MPH) * 60;
      returnMin = dispatch + leg + leg + 15;
    }
    if (returnMin == null) return applyCalcRetention(out, row);

    const etaNextMin = returnMin + 30;
    out.etaNextDispatch = minsToClock(etaNextMin);

    const shiftStartMin = parseHHMM(row.shiftStart);
    if (shiftStartMin != null) out.hosLeft = minsToDuration(12 * 60 - (etaNextMin - shiftStartMin));
    return applyCalcRetention(out, row);
  }

  // 3 hours after a shift is marked complete, these fields are cleared —
  // they won't be needed again. Last Stop Depart / Return to DC are real
  // entries now rather than calculations, so they're not touched here —
  // same as Return to DC already worked before this change.
  function applyCalcRetention(out, row) {
    if (row && row.shiftComplete && row.shiftCompleteAt) {
      const elapsed = Date.now() - new Date(row.shiftCompleteAt).getTime();
      if (elapsed > CALC_FIELD_RETENTION_MS) {
        return { ...out, etaNextDispatch: "", hosLeft: "", tripCallTime: "" };
      }
    }
    return out;
  }

  // Shift-level calculated column -- the earliest upcoming moment (across
  // the same rule types the alert widget evaluates) that needs a driver
  // contacted. Deliberately reuses the alert system's own thresholds
  // (IDLE_THRESHOLD_MIN etc, defined further down) so the board and the
  // alert widget never disagree about timing. Not included here: the
  // missing-paperwork rule, since it needs trip_stops data that isn't part
  // of the row/trip objects already loaded on the board -- pulling that in
  // live per-row isn't practical, so this column only reflects the other
  // four rule types.
  function computeNextCallTimeForRow(row) {
    if (row.shiftComplete) return "";
    const candidates = [];
    const shiftStartMin = parseHHMM(row.shiftStart);
    const hasRealTrip = row.trips.some((t) => (t.routeId || "").trim() || (t.tripId || "").trim());

    if (shiftStartMin != null && !hasRealTrip) candidates.push(shiftStartMin + IDLE_THRESHOLD_MIN);
    if (shiftStartMin != null && !row.preShiftTextSent) candidates.push(shiftStartMin - PRE_SHIFT_TEXT_LEAD_MIN);
    if (row.preShiftTextSent && row.preShiftTextSentAt) {
      const sentDate = new Date(row.preShiftTextSentAt);
      candidates.push(sentDate.getHours() * 60 + sentDate.getMinutes() + PRE_SHIFT_CALL_FOLLOWUP_MIN);
    }
    row.trips.forEach((t) => {
      if (t.minimized || t.complete || !String(t.routeId || "").trim()) return;
      const dispatch = parseHHMM(t.dispatchTime);
      const miles = parseFloat(t.routeMiles);
      if (dispatch != null && !isNaN(miles) && miles > 0) {
        const leg = (miles / AVG_MPH) * 60;
        candidates.push(dispatch + leg + leg + 15); // matches the overdue-return threshold used elsewhere
      }
    });

    if (!candidates.length) return "";
    return minsToClock(Math.min(...candidates));
  }

  // Give Last Stop Depart / Return to DC a starting value once Dispatch
  // Time and Route Miles are both known, using the same 45mph estimate as
  // before — but only while the field is still blank. Once a dispatcher
  // has anything in there (typed manually or from a previous auto-fill),
  // this leaves it alone; it never overwrites what's already showing.
  function autoFillCalcTimes(rowId, trip) {
    const dispatch = parseHHMM(trip.dispatchTime);
    const miles = parseFloat(trip.routeMiles);
    if (dispatch == null || isNaN(miles) || miles <= 0) return;
    const leg = (miles / AVG_MPH) * 60;
    let changed = false;
    if (!String(trip.lastStopDepart || "").trim()) {
      trip.lastStopDepart = minsToClock(dispatch + leg);
      changed = true;
    }
    if (!String(trip.returnToDC || "").trim()) {
      const lastDepartMin = parseHHMM(trip.lastStopDepart);
      trip.returnToDC = minsToClock((lastDepartMin != null ? lastDepartMin : dispatch + leg) + leg + 15);
      changed = true;
    }
    if (!changed) return;
    const lsdEl = document.querySelector(`input[data-row="${rowId}"][data-trip="${trip.id}"][data-field="lastStopDepart"]`);
    if (lsdEl) lsdEl.value = trip.lastStopDepart;
    const rtdEl = document.querySelector(`input[data-row="${rowId}"][data-trip="${trip.id}"][data-field="returnToDC"]`);
    if (rtdEl) rtdEl.value = trip.returnToDC;
  }


  // Shift-level HOS display -- a driver only has one "current" HOS status
  // at a time, not one per trip block, so this reflects whichever trip is
  // the most recently active (last one with dispatch+miles entered).
  function computeShiftLevelHosLeft(row) {
    let latest = null;
    row.trips.forEach((t) => {
      if (parseHHMM(t.dispatchTime) != null && parseFloat(t.routeMiles) > 0) latest = t;
    });
    if (!latest) return "";
    return computeCalc(latest, row).hosLeft;
  }

  // Recomputes the Rate column from the board rate engine (mileage tiers /
  // flat-per-route / TONU / BIRM / Hostler, depending on location) and
  // writes it into row.rate — unless the dispatcher has typed a manual
  // override into that field, in which case this is a no-op so we never
  // silently clobber what they typed. Updates the live DOM cell in place
  // when present, rather than forcing a full board redraw.
  function recomputeRowRate(row) {
    if (row.rateManual) return;
    const locationKey = row.location || state.activeLocation || "atlanta";
    const breakdown = calcLoadRateBreakdown(locationKey, row);
    const nextRate = breakdown.total ? String(breakdown.total) : "";
    if (row.rate === nextRate) return;
    row.rate = nextRate;
    scheduleShiftSave(row);
    const rateInput = document.querySelector(`input[data-row="${row.id}"][data-field="rate"]`);
    if (rateInput && document.activeElement !== rateInput) rateInput.value = row.rate;
  }

  /* ---------------- dom helpers ---------------- */

  export const $ = (sel, root) => (root || document).querySelector(sel);
  export const $all = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  /* ---------------- nav (built the same way on every page) ---------------- */

  
  /* ---------------- rendering: board ---------------- */

  function openTripsFor(row) {
    const open = row.trips.filter((t) => !t.minimized);
    return open.length ? open : [row.trips[row.trips.length - 1]]; // always show at least one editable trip row
  }

  function routesChipsHtml(row) {
    const done = row.trips.filter((t) => t.minimized);
    if (!done.length) return `<span class="subtext" style="font-size:11px;">—</span>`;
    return done.map((t, i) => {
      const statusCls = t.complete ? "trip-segment-done" : "";
      const title = t.complete ? "Closed out — click to view" : "Click to view or edit";
      return `<button type="button" class="trip-chip ${statusCls}" data-action="restore-trip" data-row="${row.id}" data-trip="${t.id}" title="${title}">${escapeHtml(t.routeId || t.tripId || `Route ${i + 1}`)}</button>`;
    }).join(" ");
  }

  function tripFieldCellsHtml(row, trip) {
    const calc = computeCalc(trip, row);
    const canComplete = String(trip.routeId || "").trim();
    return getOrderedTripSubcols().map((col) => {
      const pistachioCls = col.pistachio ? " col-pistachio" : "";
      if (col.type === "checkbox") {
        const on = !!trip[col.key];
        const flagCls = col.key === "backhaul" ? "flag-backhaul" : "flag-yes";
        return `<td class="col-${col.key}${pistachioCls} ${on ? flagCls : ""}" style="text-align:center;">
          <input type="checkbox" class="chk" data-row="${row.id}" data-trip="${trip.id}" data-field="${col.key}" ${on ? "checked" : ""}>
        </td>`;
      }
      if (col.type === "calc") {
        return `<td class="col-${col.key}${pistachioCls}"><input class="cell-input calc" data-row="${row.id}" data-trip="${trip.id}" data-field="${col.key}" value="${escapeHtml(calc[col.key])}" readonly tabindex="-1"></td>`;
      }
      const placeholder = col.type === "time" ? "--:--" : "";
      const inputmode = col.inputmode ? ` inputmode="${col.inputmode}"` : "";
      const linkBtn = (col.key === "routeId" && trip.routeId)
        ? `<button type="button" class="cell-link-btn" data-open-pro="${row.id}" data-trip="${trip.id}" title="Open route details">↗</button>` : "";
      return `<td class="col-${col.key}${pistachioCls}"><div class="cell-with-link">
        <input class="cell-input ${col.small ? "small" : ""}" type="text" placeholder="${placeholder}"${inputmode}
        data-row="${row.id}" data-trip="${trip.id}" data-field="${col.key}" value="${escapeHtml(trip[col.key])}">${linkBtn}</div></td>`;
    }).join("") + `<td class="col-trip-actions">
        <button type="button" class="tc-btn" data-action="minimize-trip" data-row="${row.id}" data-trip="${trip.id}" title="Collapse — doesn't mark it done">&minus;</button>
        <button type="button" class="tc-btn" data-action="add-trip" data-row="${row.id}" title="Add another trip">+</button>
        <button type="button" class="tc-btn tc-btn-primary" data-action="complete-trip" data-row="${row.id}" data-trip="${trip.id}" ${canComplete ? "" : "disabled"} title="${canComplete ? "Mark closed out" : "Enter a Route ID first"}">${trip.complete ? "✓" : "Complete"}</button>
      </td>`;
  }

  export function pick(driverVal, snapshotVal) {
    if (driverVal && String(driverVal).trim()) return driverVal;
    if (snapshotVal && String(snapshotVal).trim()) return snapshotVal;
    return "—";
  }

  function shiftInfoCellsHtml(row, rowspan) {
    const drv = row.driverId ? findDriver(row.driverId) : null;
    const displayName = drv ? drv.name : row.driverNameText;
    const proLinkBtn = row.proNumber ? `<button type="button" class="cell-link-btn" data-open-pro="${row.id}" title="Open load details">↗</button>` : "";
    const rs = rowspan > 1 ? ` rowspan="${rowspan}"` : "";
    return `
      <td class="pin pin-select"${rs}>
        <input type="checkbox" class="chk" data-action="toggle-row-select" data-row="${row.id}" ${row.selected ? "checked" : ""} title="Select">
      </td>
      <td class="pin pin-text"${rs}>
        <button class="text-btn" data-action="text-driver" data-row="${row.id}" title="Text this driver">Text</button>
      </td>
      <td class="col-email"${rs}><span class="static-text">${escapeHtml(pick(drv && drv.email, row.emailSnapshot))}</span></td>
      <td class="col-dispatcherPhone"${rs}><span class="static-text">${escapeHtml(pick(drv && drv.dispatcherPhone, row.dispatcherPhoneSnapshot))}</span></td>
      <td class="pin pin-pro${row.shiftComplete ? " shift-complete-tint" : ""}"${rs}>
        <div class="cell-with-link">
          <input class="cell-input" placeholder="PRO#" data-row="${row.id}" data-field="proNumber" value="${escapeHtml(row.proNumber)}">${proLinkBtn}
        </div>
      </td>
      <td class="col-shiftDate"${rs}><span class="static-text">${escapeHtml(row.shiftDate || "")}</span></td>
      <td class="col-mc"${rs}><span class="static-text">${escapeHtml(pick(drv && drv.mc, row.mcSnapshot))}</span></td>
      <td class="col-rating"${rs}><span class="static-text">${escapeHtml(pick(drv && drv.rating, row.ratingSnapshot))}</span></td>
      <td class="col-driverPreference"${rs}><span class="static-text">${escapeHtml((drv && drv.preference) || "")}</span></td>
      <td class="pin pin-driver"${rs}>
        <div class="driver-name-wrap">
          <input class="cell-input" list="driverNamesList" placeholder="Type driver name…"
            data-row="${row.id}" data-field="driverName" value="${escapeHtml(displayName)}">
        </div>
      </td>
        <td class="col-rate"${rs}>
          <input class="cell-input small" style="width:46px;" placeholder="Rate" data-row="${row.id}" data-field="rate" value="${escapeHtml(row.rate)}">
      </td>
      <td class="col-cell"${rs}><span class="static-text">${escapeHtml(pick(drv && drv.phone, row.cellSnapshot))}</span></td>
      <td class="col-shiftStart"${rs}><input class="cell-input small" style="width:46px;" placeholder="--:--" data-row="${row.id}" data-field="shiftStart" value="${escapeHtml(row.shiftStart)}"></td>
      <td class="col-etaShiftReport"${rs}><input class="cell-input small" style="width:46px;" placeholder="--:--" data-row="${row.id}" data-field="etaShiftReport" value="${escapeHtml(row.etaShiftReport)}"></td>
      <td class="col-shiftHosLeft"${rs}><input class="cell-input calc" data-row="${row.id}" data-field="shiftHosLeft" value="${escapeHtml(computeShiftLevelHosLeft(row))}" readonly tabindex="-1"></td>
      <td class="col-nextCallTimeCalc"${rs}><input class="cell-input calc" data-row="${row.id}" data-field="nextCallTimeCalc" value="${escapeHtml(computeNextCallTimeForRow(row))}" readonly tabindex="-1"></td>
      <td class="col-revLevel"${rs}><input class="cell-input small" style="width:42px;" placeholder="Rev" data-row="${row.id}" data-field="revLevel" value="${escapeHtml(row.revLevel)}"></td>
      <td class="col-birm"${rs}>
        ${row.location === "buildingc" ? `
          <select class="cell-input small" data-action="change-route-type" data-row="${row.id}">
            <option value="birm" ${row.routeType === "birm" ? "selected" : ""}>BIRM</option>
            <option value="hostler" ${row.routeType === "hostler" ? "selected" : ""}>Hostler</option>
            <option value="na" ${row.routeType === "na" ? "selected" : ""}>N/A</option>
          </select>
        ` : `<span class="static-text">—</span>`}
      </td>
      <td class="col-notes"${rs}><input class="cell-input" placeholder="Notes" data-row="${row.id}" data-field="notes" value="${escapeHtml(row.notes)}"></td>
      <td class="col-routes"${rs}>${routesChipsHtml(row)}</td>`;
  }

  function rowsToHtml(row) {
    const open = openTripsFor(row);
    const rowClasses = [
      row.tonu ? "is-tonu" : "",
      row.highlighted ? "is-row-pinned" : "",
      row.selected ? "is-row-selected" : "",
      row.addedAt ? "is-new" : "",
    ].join(" ");
    return open.map((trip, i) => {
      const idAttr = i === 0 ? ` id="${row.id}"` : ` id="${row.id}__${trip.id}" data-parent-row="${row.id}"`;
      const shiftCells = i === 0 ? shiftInfoCellsHtml(row, open.length) : "";
      return `<tr${idAttr} class="${rowClasses}">${shiftCells}${tripFieldCellsHtml(row, trip)}</tr>`;
    }).join("");
  }

  export function renderBoardChrome() {
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

  // houston.js needs to reset this before opening its own date dropdown,
  // but an imported `let` binding can't be reassigned from outside this
  // module — so this setter is the sanctioned way to do that from elsewhere.
  export function resetCalendarViewMonth() { calendarViewMonth = null; }

  export function renderCalendarGrid(datesWithDataSet) {
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

  export function openDateDropdown() {
    calendarViewMonth = null; // re-focus on the active date's month each time it's opened fresh
    renderCalendarGrid(state.datesWithData);
    $("#date-dropdown").classList.remove("hidden");
  }
  export function closeDateDropdown() {
    const el = $("#date-dropdown");
    if (el) el.classList.add("hidden");
  }

  // Sync — draws whatever's currently cached in state.sheets. Safe to call
  // any time data already loaded needs a full redraw (e.g. after Add Load,
  // or once the driver list arrives and driver-linked cells need refreshing).
  function renderBoardTable() {
    if (!$("#board-table")) return; // this page (e.g. Accounting) has no board grid — nothing to redraw
    const rows = getSheet(state.activeLocation, state.activeDate);
    const displayRows = [...rows].sort((a, b) => (a.shiftComplete ? 1 : 0) - (b.shiftComplete ? 1 : 0)); // stable — completed shifts sink to the bottom, order preserved otherwise
    const tripHeaderCells = getOrderedTripSubcols().map((c) => {
      const pistachioCls = c.pistachio ? " col-pistachio" : "";
      return `<th class="col-${c.key}${pistachioCls} col-draggable" draggable="true" data-col-key="${c.key}" title="Drag to reorder">${c.label}</th>`;
    }).join("");
    const thead = `<thead>
      <tr>
        <th class="pin pin-select"><input type="checkbox" class="chk" id="select-all-rows" title="Select all"></th>
        <th class="pin pin-text"></th>
        <th class="col-email">Email</th>
        <th class="col-dispatcherPhone">Dispatcher Phone</th>
        <th class="pin pin-pro">PRO#</th>
        <th class="col-shiftDate">Date</th>
        <th class="col-mc">MC #</th>
        <th class="col-rating">Rating</th>
        <th class="col-driverPreference">Driver Preference</th>
        <th class="pin pin-driver">Driver</th>
        <th class="col-rate">Rate</th>
        <th class="col-cell">Cell</th>
        <th class="col-shiftStart">Shift Start</th>
        <th class="col-etaShiftReport">ETA</th>
        <th class="col-shiftHosLeft">HOS Left</th>
        <th class="col-nextCallTimeCalc">Next Call Time</th>
        <th class="col-revLevel">Rev Level</th>
        <th class="col-birm" title="Building C only">Route</th>
        <th class="col-notes">Notes</th>
        <th class="col-routes">Routes</th>
        ${tripHeaderCells}
        <th class="col-trip-actions"></th>
      </tr>
    </thead>`;
    const totalCols = 20 + TRIP_SUBCOLS.length + 1;
    const addRowHtml = `<tr class="quick-add-row"><td colspan="${totalCols}"><button type="button" class="quick-add-btn" id="btn-quick-add-row"><span class="quick-add-btn-label">+ Add Row</span></button></td></tr>`;
    const tbody = `<tbody>${displayRows.map(rowsToHtml).join("")}${addRowHtml}</tbody>`;

    $("#board-table").innerHTML = thead + tbody;
    const emptyState = $("#board-empty-state");
    if (emptyState) emptyState.classList.toggle("hidden", rows.length > 0);
    refreshDriverDatalist();
    updateBulkActionButtonsVisibility();
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
    refreshAvailableSection();
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
    setText(".col-driverPreference .static-text", (drv && drv.preference) || "");
  }

  function recalcRowCalcCellsInPlace(rowId) {
    const found = findRowAnywhere(rowId);
    if (!found) return;
    const row = found.row;
    const open = openTripsFor(row);
    open.forEach((trip) => {
      const anyFieldForTrip = document.querySelector(`[data-trip="${trip.id}"]`);
      const tr = anyFieldForTrip ? anyFieldForTrip.closest("tr") : null;
      if (!tr) return;
      const calc = computeCalc(trip, row);
      TRIP_SUBCOLS.forEach((col) => {
        if (col.type !== "calc") return;
        const el = tr.querySelector(`input[data-trip="${trip.id}"][data-field="${col.key}"]`);
        if (el) el.value = calc[col.key]; // readonly calc fields — safe to set directly, never focused/typed into
      });
    });
    const nextCallEl = document.querySelector(`input[data-row="${rowId}"][data-field="nextCallTimeCalc"]`);
    if (nextCallEl) nextCallEl.value = computeNextCallTimeForRow(row);
    const hosEl = document.querySelector(`input[data-row="${rowId}"][data-field="shiftHosLeft"]`);
    if (hosEl) hosEl.value = computeShiftLevelHosLeft(row);
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

  export function handleRealtimeDriverChange(payload) {
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

  export function refreshDriverDatalist() {
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
        <td>${d.normalRate ? `$${Number(d.normalRate).toLocaleString()}` : "—"}</td>
        <td>${escapeHtml(d.carrier || "—")}</td>
        <td>${escapeHtml(d.rateBooking || "—")}</td>
        <td><span class="badge ${d.tia ? "badge-yes" : "badge-no"}">${d.tia ? "Yes" : "No"}</span></td>
        <td>${d.tiiAmount != null ? `$${Number(d.tiiAmount).toLocaleString()}` : "—"}</td>
        <td>${escapeHtml(d.notes || "—")}</td>
      </tr>`).join("");
    body.innerHTML = tbody || `<tr><td colspan="14" style="text-align:center;color:var(--slate-500);padding:24px;">No drivers on file yet.</td></tr>`;
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
    const wasTonu = found.row.tonu;
    found.row.tonu = !found.row.tonu;
    const tr = document.getElementById(rowId);
    if (tr) {
      tr.classList.toggle("is-tonu", found.row.tonu);
      const btn = tr.querySelector('[data-action="toggle-tonu"]');
      if (btn) btn.classList.toggle("is-active", found.row.tonu);
    }
    saveShiftNow(found.row);
    recomputeRowRate(found.row);
    if (!wasTonu && found.row.tonu) logChange(found.row.dbId, labelForRow(found.row), "tonu", "false", "true");
  }

  function toggleRowPin(rowId) {
    const found = findRowAnywhere(rowId);
    if (!found) return;
    found.row.highlighted = !found.row.highlighted;
    const tr = document.getElementById(rowId);
    if (tr) tr.classList.toggle("is-row-pinned", found.row.highlighted);
    saveShiftNow(found.row);
  }

  // Building C only — switches between BIRM (flat), Hostler (hourly,
  // manual shift length), and N/A (no automatic rate). Logged since it
  // changes what the driver gets paid.
  export function changeRouteType(rowId, newType) {
    const found = findRowAnywhere(rowId);
    if (!found) return;
    const before = found.row.routeType;
    if (before === newType) return;
    found.row.routeType = newType;
    saveShiftNow(found.row);
    recomputeRowRate(found.row);
    logChange(found.row.dbId, labelForRow(found.row), "route_type", before, newType);
    if (loadDetailsState && loadDetailsState.rowId === rowId) renderLoadDetailsTabContent();
  }

  export function setHostlerHours(rowId, rawValue) {
    const found = findRowAnywhere(rowId);
    if (!found) return;
    const before = found.row.hostlerHours;
    if (before === rawValue) return;
    found.row.hostlerHours = rawValue;
    saveShiftNow(found.row);
    recomputeRowRate(found.row);
    logChange(found.row.dbId, labelForRow(found.row), "hostler_hours", before, rawValue);
  }

  // Local-only, not persisted to Supabase — this is a per-user selection
  // state for a bulk-action feature that hasn't been designed yet.
  function updateBulkActionButtonsVisibility() {
    const anySelected = getSheet(state.activeLocation, state.activeDate).some((r) => r.selected);
    if ($("#btn-complete-selected")) $("#btn-complete-selected").classList.toggle("hidden", !anySelected);
    if ($("#btn-text-selected")) $("#btn-text-selected").classList.toggle("hidden", !anySelected);
  }

  function toggleRowSelected(rowId) {
    const found = findRowAnywhere(rowId);
    if (!found) return;
    found.row.selected = !found.row.selected;
    const tr = document.getElementById(rowId);
    if (tr) tr.classList.toggle("is-row-selected", found.row.selected);
    updateBulkActionButtonsVisibility();
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
    updateBulkActionButtonsVisibility();
  }

  let timesheetModalState = null; // { rowId, queue: [rowId, ...] } — queue is for bulk-complete chaining
  const focusValueSnapshots = new Map(); // "rowId:field" -> value at focus-in, for detecting a real committed change on blur

  async function finalizeShiftCompletion(row) {
    row.shiftComplete = true;
    row.shiftCompleteAt = new Date().toISOString();
    await saveShiftNow(row);
    logChange(row.dbId, labelForRow(row), "shift_complete", "false", "true");
    await discardBlankTrips(row);
    await minimizeAllTrips(row);
    recomputeRowRate(row);
    sendShiftToAccounting(row, row.location || state.activeLocation, row.shiftDate || state.activeDate).catch((e) => console.error("sendShiftToAccounting threw:", e));
  }

  function openTimesheetModal(rowId, queue) {
    timesheetModalState = { rowId, queue: queue || [] };
    $("#tsc-received").checked = false;
    $("#tsc-start").value = "";
    $("#tsc-end").value = "";
    $("#tsc-drop-location").value = "";
    $("#tsc-error").textContent = "";
    $("#modal-timesheet-complete").classList.remove("hidden");
  }

  function advanceTimesheetQueue() {
    $("#modal-timesheet-complete").classList.add("hidden");
    const finishedState = timesheetModalState;
    timesheetModalState = null;
    if (finishedState && finishedState.queue.length) {
      const [next, ...rest] = finishedState.queue;
      openTimesheetModal(next, rest);
    } else {
      renderBoardTable();
    }
  }

  async function submitTimesheetModal() {
    if (!timesheetModalState) return;
    const received = $("#tsc-received").checked;
    const start = $("#tsc-start").value.trim();
    const end = $("#tsc-end").value.trim();
    const dropLocation = $("#tsc-drop-location").value.trim();
    if (!received || !start || !end || !dropLocation) {
      $("#tsc-error").textContent = "Time Sheet Received, Start, Finish, and Trailer Drop Location are all required before this shift can be marked complete.";
      return;
    }
    const found = findRowAnywhere(timesheetModalState.rowId);
    if (!found) { advanceTimesheetQueue(); return; }
    const row = found.row;
    row.timesheetReceived = received;
    row.timesheetStartTime = start;
    row.timesheetEndTime = end;
    row.trailerDropLocation = dropLocation;
    await finalizeShiftCompletion(row);
    advanceTimesheetQueue();
  }

  function skipTimesheetModal() {
    // Cancel just skips THIS row (it stays incomplete) but continues the queue for bulk-complete
    advanceTimesheetQueue();
  }

  async function completeSelectedRows() {
    const rows = getSheet(state.activeLocation, state.activeDate).filter((r) => r.selected && !r.shiftComplete);
    if (!rows.length) { setDriverSyncStatus("No selected loads need completing — either nothing's checked, or they're already complete.", "error"); return; }

    const rowsWithOpenTrips = rows.filter((r) => openTripsForRow(r).length);
    if (rowsWithOpenTrips.length) {
      const label = rowsWithOpenTrips.map((r) => r.proNumber || "(no PRO#)").join(", ");
      if (!confirm(`${rowsWithOpenTrips.length} of these loads still have trips not closed out yet (${label}). Send all selected loads to Accounting anyway?`)) return;
    }

    const [first, ...rest] = rows.map((r) => r.id);
    openTimesheetModal(first, rest);
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

  function openTripsForRow(row) {
    return row.trips.filter((t) => String(t.routeId || "").trim() && !t.complete);
  }

  async function discardBlankTrips(row) {
    const blank = row.trips.filter((t) => !String(t.routeId || "").trim() && !String(t.tripId || "").trim());
    if (!blank.length) return;
    row.trips = row.trips.filter((t) => !blank.includes(t));
    if (!row.trips.length) row.trips.push(blankTrip()); // never leave a shift with zero trips
    if (supabaseClient) {
      const dbIds = blank.filter((t) => t.dbId).map((t) => t.dbId);
      if (dbIds.length) {
        try { await supabaseClient.from(TRIPS_TABLE).delete().in("id", dbIds); }
        catch (e) { console.error("discardBlankTrips failed:", e); }
      }
    }
  }

  async function minimizeAllTrips(row) {
    for (const trip of row.trips) {
      if (trip.minimized) continue;
      trip.minimized = true;
      await saveTripNow(row, trip, row.trips.indexOf(trip) + 1);
    }
  }

  function toggleShiftComplete(rowId) {
    const found = findRowAnywhere(rowId);
    if (!found) return;
    const row = found.row;
    if (!row.shiftComplete) {
      const open = openTripsForRow(row);
      if (open.length) {
        const names = open.map((t, i) => t.routeId || t.tripId || `Route ${i + 1}`).join(", ");
        if (!confirm(`This load still has ${open.length} trip(s) not closed out yet (${names}) — likely still waiting on paperwork. Send it to Accounting anyway?`)) return;
      }
      openTimesheetModal(rowId, []); // required time sheet info gate — finalizeShiftCompletion runs after it's submitted
      return;
    }
    // Un-completing stays instant — no time sheet re-check needed to walk it back
    row.shiftComplete = false;
    row.shiftCompleteAt = null;
    saveShiftNow(row);
    renderBoardTable();
  }

  async function deleteRow(rowId) {
    const found = findRowAnywhere(rowId);
    if (!found) return;
    const row = found.row;
    const drv = row.driverId ? findDriver(row.driverId) : null;
    const label = [row.proNumber, drv ? drv.name : row.driverNameText].filter(Boolean).join(" — ") || "this load";
    if (!confirm(`Delete ${label}? This can't be undone.`)) return;

    logChange(row.dbId, label, "deleted", "active", "deleted"); // logged before the row goes, in case the FK doesn't outlive it

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

  let sendTextModalState = null; // { rawPhone }

  function updateSendTextCounter() {
    const el = $("#send-text-counter");
    const input = $("#send-text-message");
    if (!el || !input) return;
    const len = input.value.length;
    // Standard SMS segment sizing: 160 chars fits in one text; anything
    // longer splits into multi-part messages at 153 chars/segment (7
    // chars go to part-tracking headers). TextBetter doesn't publish its
    // own limit -- this is the carrier-network standard every SMS gateway
    // is bound by, TextBetter included.
    const segments = len === 0 ? 1 : (len <= 160 ? 1 : Math.ceil(len / 153));
    const segLabel = segments === 1 ? "1 text" : `${segments} texts (message will split)`;
    el.textContent = `${len} character${len === 1 ? "" : "s"} — ${segLabel}`;
    el.style.color = segments > 1 ? "var(--amber-700, #b45309)" : "";
  }

  export function openSendTextModal(recipients, prefilledMessage, markShiftIdsOnSent) {
    const withPhone = recipients.filter((r) => formatTextAddress(r.phone));
    if (!withPhone.length) {
      setDriverSyncStatus("No phone number on file for this driver.", "error");
      return;
    }
    sendTextModalState = { recipients: withPhone, markShiftIdsOnSent: markShiftIdsOnSent || null };
    $("#send-text-phone-display").textContent = withPhone.map((r) => r.name || r.phone).join(", ");
    $("#send-text-message").value = prefilledMessage || "";
    $("#send-text-status").textContent = "";
    updateSendTextCounter();
    $("#modal-send-text").classList.remove("hidden");
    $("#send-text-message").focus();
  }

  export function textDriverPhone(rawPhone, prefilledMessage) {
    openSendTextModal([{ name: null, phone: rawPhone }], prefilledMessage);
  }

  // Marks Pre Shift Text Sent (+ timestamp) on the given shifts, both in the
  // DB and in any matching rows already loaded in this tab, so the alert
  // scanner won't immediately re-flag them on its next pass.
  async function markPreShiftTextSent(shiftDbIds) {
    if (!shiftDbIds || !shiftDbIds.length || !supabaseClient) return;
    const nowIso = new Date().toISOString();
    try {
      await supabaseClient.from(SHIFTS_TABLE)
        .update({ pre_shift_text_sent: true, pre_shift_text_sent_at: nowIso })
        .in("id", shiftDbIds);
    } catch (e) {
      console.error("markPreShiftTextSent failed:", e);
    }
    const idSet = new Set(shiftDbIds.map(String));
    for (const k in state.sheets) {
      state.sheets[k].forEach((r) => {
        if (idSet.has(String(r.dbId))) {
          r.preShiftTextSent = true;
          r.preShiftTextSentAt = nowIso;
        }
      });
    }
  }

  async function submitSendTextModal() {
    if (!sendTextModalState) return;
    const message = $("#send-text-message").value.trim();
    if (!message) { $("#send-text-status").textContent = "Type a message first."; return; }
    const sendBtn = $("#send-text-submit");
    sendBtn.disabled = true;
    $("#send-text-status").textContent = "Sending…";
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/send-text`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phones: sendTextModalState.recipients.map((r) => r.phone), message }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || `Send failed (${res.status})`);
      if (sendTextModalState.markShiftIdsOnSent) await markPreShiftTextSent(sendTextModalState.markShiftIdsOnSent);
      $("#modal-send-text").classList.add("hidden");
      setDriverSyncStatus("Text sent.", "success");
    } catch (e) {
      console.error("send-text failed, falling back to email client:", e);
      $("#send-text-status").innerHTML = `Couldn't send automatically (${escapeHtml(String(e.message || e))}). <button type="button" class="btn btn-ghost" id="send-text-fallback" style="margin-left:6px;">Open in email instead</button>`;
      const fallbackBtn = $("#send-text-fallback");
      if (fallbackBtn) fallbackBtn.addEventListener("click", async () => {
        const addrs = sendTextModalState.recipients.map((r) => formatTextAddress(r.phone)).join(",");
        const a = document.createElement("a");
        a.href = `mailto:${addrs}?body=${encodeURIComponent(message)}`;
        a.click();
        // Falling back to the Outlook draft still counts as "sent" for
        // tracking purposes -- the dispatcher still has to actually hit
        // send in Outlook, but there's no way to detect that from here,
        // so this marks it the moment they choose the fallback path.
        if (sendTextModalState.markShiftIdsOnSent) await markPreShiftTextSent(sendTextModalState.markShiftIdsOnSent);
        $("#modal-send-text").classList.add("hidden");
      });
    } finally {
      sendBtn.disabled = false;
    }
  }

  /* ---------------- group texting (Driver List page) ---------------- */
  const GROUP_BATCH_SIZE = 9;
  let groupTextState = null; // { groupKey, message, batches: [[driver,...],...], batchIndex, skipped, totalSent }

  // Same reasoning as resetCalendarViewMonth() above — houston.js needs to
  // clear this before opening its own text-selected modal, but can't
  // reassign an imported `let` binding directly.
  export function resetGroupTextState() { groupTextState = null; }

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

  export function beginTextBatchFlow(members, label, message) {
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
        <div class="subtext" style="font-weight:700; font-size:14px;">All done — ${s.totalSent} driver(s) in ${escapeHtml(s.groupKey)} texted across ${s.batches.length} batch(es).</div>
        ${skipNote}`;
      $("#tg-send-now").classList.add("hidden");
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
      <div class="calc-note" style="margin-top:10px;" id="tg-batch-status">Click "Send Now" to send this batch automatically, or fall back to Outlook if needed.</div>
    `;
    $("#tg-send-now").classList.remove("hidden");
    $("#tg-send-now").disabled = false;
    $("#tg-open-batch").classList.remove("hidden");
    $("#tg-confirm-sent").classList.add("hidden");
    $("#tg-finish").classList.add("hidden");
  }

  export async function sendCurrentGroupBatchDirect() {
    const s = groupTextState;
    if (!s) return;
    const batch = s.batches[s.batchIndex];
    const btn = $("#tg-send-now");
    const statusEl = $("#tg-batch-status");
    btn.disabled = true;
    if (statusEl) statusEl.textContent = "Sending…";
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/send-text`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phones: batch.map((d) => d.phone), message: s.message }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || `Send failed (${res.status})`);
      s.totalSent += batch.length;
      s.batchIndex += 1;
      renderGroupTextProgress();
    } catch (e) {
      console.error("Group batch direct-send failed:", e);
      if (statusEl) statusEl.innerHTML = `Couldn't send automatically (${escapeHtml(String(e.message || e))}) — use "Open in Outlook Instead" below.`;
      btn.disabled = false;
    }
  }

  export function openCurrentGroupBatch() {
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

  export function confirmGroupBatchSent() {
    const s = groupTextState;
    if (!s) return;
    s.totalSent += s.batches[s.batchIndex].length;
    s.batchIndex += 1;
    renderGroupTextProgress();
  }

  /* ---------------- right-click context menu ---------------- */

  export function closeContextMenu() {
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
      { label: "Load Details", action: () => openLoadDetailsModal(rowId) },
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

  /* ---------------- Load Details modal (PRO#/Trip ID popup) ---------------- */

  export let loadDetailsState = null; // { rowId, activeTab, attachments, history }

  export async function openLoadDetailsFromAccounting(accountingRecordId, tripDbId) {
    const acctRec = getAccountingRecordById(accountingRecordId);
    if (!acctRec) return;
    if (!acctRec.source_shift_id) { setDriverSyncStatus("This load doesn't have a linked board record to open (likely a Houston load).", "error"); return; }
    if (!supabaseClient) return;
    try {
      const { data: shiftRows, error: shiftErr } = await supabaseClient.from(SHIFTS_TABLE).select("*").eq("id", acctRec.source_shift_id);
      if (shiftErr || !shiftRows || !shiftRows[0]) throw shiftErr || new Error("Load not found");
      const row = shiftFromDbRow(shiftRows[0]);
      const { data: tripRows } = await supabaseClient.from(TRIPS_TABLE).select("*").eq("shift_id", row.dbId);
      const sortedTrips = (tripRows || []).sort((a, b) => a.trip_number - b.trip_number).map(tripFromDbRow);
      row.trips = sortedTrips.length ? sortedTrips : [blankTrip()];
      standaloneLoadedRows[row.id] = row;
      state.activeLocation = row.location || state.activeLocation;
      refreshDriverDatalist();
      const targetTrip = tripDbId ? row.trips.find((t) => String(t.dbId) === String(tripDbId)) : null;
      await openLoadDetailsModal(row.id, targetTrip ? targetTrip.id : null);
    } catch (e) {
      console.error("openLoadDetailsFromAccounting failed:", e);
      setDriverSyncStatus(`Couldn't open this load (${e.message || e}).`, "error");
    }
  }

  async function openLoadDetailsModal(rowId, jumpToTripId, forceTab) {
    const found = findRowAnywhere(rowId);
    const modal = $("#modal-load-details");
    if (!found || !modal) return;
    const row = found.row;
    loadDetailsState = {
      rowId,
      activeTab: forceTab || (jumpToTripId ? `trip-${jumpToTripId}` : "overview"),
      attachments: [],
      history: [],
      stopsByTrip: {}, // trip.id (local) -> [{stopNumber, timeIn, timeOut, dbId}]
      editMode: null, // "overview" | trip.id | null
      editDraft: null, // scratch copy of the fields being edited, discarded on Cancel
    };
    $("#ld-title").textContent = `Load ${row.proNumber || "(no PRO# yet)"}`;
    modal.classList.remove("hidden");
    renderLoadDetailsTabs();

    if (supabaseClient && row.dbId) {
      const tripDbIds = row.trips.filter((t) => t.dbId).map((t) => t.dbId);
      const [{ data: attachments }, { data: history }, stopsResult] = await Promise.all([
        supabaseClient.from("load_attachments").select("*").eq("shift_id", row.dbId),
        supabaseClient.from("load_change_history").select("*").eq("shift_id", row.dbId),
        tripDbIds.length ? supabaseClient.from("trip_stops").select("*").in("trip_id", tripDbIds) : Promise.resolve({ data: [] }),
      ]).catch(() => [{ data: [] }, { data: [] }, { data: [] }]);
      loadDetailsState.attachments = attachments || [];
      loadDetailsState.history = (history || []).sort((a, b) => (a.changed_at < b.changed_at ? 1 : -1));
      const stopRows = stopsResult.data || [];
      row.trips.forEach((t) => {
        if (!t.dbId) return;
        loadDetailsState.stopsByTrip[t.id] = stopRows
          .filter((s) => s.trip_id === t.dbId)
          .sort((a, b) => a.stop_number - b.stop_number)
          .map((s) => ({ dbId: s.id, stopNumber: s.stop_number, timeIn: s.time_in || "", timeOut: s.time_out || "" }));
      });
      renderLoadDetailsTabContent();
    }
  }

  export function closeLoadDetailsModal() {
    $("#modal-load-details").classList.add("hidden");
    loadDetailsState = null;
  }

  function loadDetailsTabs(row) {
    const realTrips = row.trips.filter((t) => String(t.routeId || "").trim() || String(t.tripId || "").trim());
    return [
      { key: "overview", label: "Overview" },
      { key: "notes", label: "Notes" },
      ...realTrips.map((t, i) => ({ key: `trip-${t.id}`, label: t.routeId || t.tripId || `Route ${i + 1}` })),
      { key: "images", label: "Trip Sheet Images" },
      { key: "history", label: "Change History" },
    ];
  }

  export function renderLoadDetailsTabs() {
    if (!loadDetailsState) return;
    const found = findRowAnywhere(loadDetailsState.rowId);
    if (!found) return;
    const tabs = loadDetailsTabs(found.row);
    $("#ld-tabs").innerHTML = tabs.map((t) =>
      `<button type="button" class="ld-tab ${t.key === loadDetailsState.activeTab ? "is-active" : ""}" data-tab="${t.key}">${escapeHtml(t.label)}</button>`
    ).join("");
    renderLoadDetailsTabContent();
  }

  export function stopFieldsHtml(stopCount, existingStops) {
    const rows = Array.from({ length: stopCount }, (_, i) => {
      const s = existingStops[i] || { stopNumber: i + 1, timeIn: "", timeOut: "" };
      return `<div class="ld-stop-edit-row">
        <span>Stop ${i + 1}</span>
        <input class="cell-input small" placeholder="Time In" data-stop-field="timeIn" data-stop-index="${i}" value="${escapeHtml(s.timeIn)}">
        <input class="cell-input small" placeholder="Time Out" data-stop-field="timeOut" data-stop-index="${i}" value="${escapeHtml(s.timeOut)}">
      </div>`;
    }).join("");
    return rows || `<div class="subtext">Set a stop count above to add time fields.</div>`;
  }

  // Renders the whole Rate block, styled as a boxed card for the Overview
  // tab's right-side sidebar: this location's editable default rates
  // (mileage tiers for Atlanta, flat/hourly figures elsewhere) each drawn
  // as its own titled box per the sketch, the total-rate box (overridable),
  // and a line-by-line breakdown of how that total was reached. One
  // generic renderer for all four locations — calcLoadRateBreakdown()
  // normalizes the shape so this doesn't need to branch much.
  function rateTierBox(label, inputHtml, overridden) {
    return `<fieldset class="rate-tier-box${overridden ? " is-overridden" : ""}"><legend>${label}${overridden ? ' <span class="rate-override-dot" title="Different from the default for this location">●</span>' : ""}</legend>${inputHtml}</fieldset>`;
  }

  function rateSectionHtml(row) {
    const locationKey = row.location || state.activeLocation || "atlanta";
    const tiers = (getBoardRateTiers() && getBoardRateTiers()[locationKey]) || [];
    const breakdown = calcLoadRateBreakdown(locationKey, row);
    const val = (key, fallback) => effectiveSetting(row, locationKey, key, fallback);
    const isOv = (key) => isSettingOverridden(row, key);

    let defaultsHtml;
    if (locationKey === "atlanta") {
      const overMax = tiers.length ? tiers[tiers.length - 1].max : 187;
      defaultsHtml = `
        <div class="rate-tier-grid">
          ${tiers.map((t) => rateTierBox(
            `${t.min}-${t.max}MI`,
            `<input type="number" step="0.01" data-rate-tier-id="${t.id}" value="${effectiveTierRate(row, t)}">`,
            isTierOverridden(row, t.id)
          )).join("")}
          ${rateTierBox(`Over ${overMax}MI ($/mi)`, `<input type="number" step="0.01" data-rate-setting-key="over_tier_per_mile" value="${val("over_tier_per_mile", 2.4)}">`, isOv("over_tier_per_mile"))}
          ${rateTierBox("Stops", `<input type="number" step="1" data-rate-setting-key="stop_charge_free_stops" value="${val("stop_charge_free_stops", 2)}">`, isOv("stop_charge_free_stops"))}
          ${rateTierBox("$/extra stop", `<input type="number" step="0.01" data-rate-setting-key="stop_charge_per_stop" value="${val("stop_charge_per_stop", 20)}">`, isOv("stop_charge_per_stop"))}
          ${rateTierBox("TONU flat", `<input type="number" step="0.01" data-rate-setting-key="tonu_flat" value="${val("tonu_flat", 150)}">`, isOv("tonu_flat"))}
        </div>`;
    } else if (locationKey === "delaware") {
      defaultsHtml = `
        <div class="rate-tier-grid">
          ${rateTierBox("Flat minimum", `<input type="number" step="0.01" data-rate-setting-key="flat_minimum" value="${val("flat_minimum", 1000)}">`, isOv("flat_minimum"))}
          ${rateTierBox("$/mile", `<input type="number" step="0.01" data-rate-setting-key="per_mile" value="${val("per_mile", 4)}">`, isOv("per_mile"))}
        </div>`;
    } else if (locationKey === "buildingc") {
      const routeType = row.routeType || "birm";
      defaultsHtml = `
        <div class="rate-tier-grid">
          ${rateTierBox("BIRM flat", `<input type="number" step="0.01" data-rate-setting-key="birm_flat" value="${val("birm_flat", 800)}">`, isOv("birm_flat"))}
          ${rateTierBox("Hostler $/hr", `<input type="number" step="0.01" data-rate-setting-key="hostler_hourly" value="${val("hostler_hourly", 100)}">`, isOv("hostler_hourly"))}
        </div>
        <div class="field" style="margin-top:4px;">
          <label>Route Type</label>
          <select class="cell-input" id="ld-route-type-select">
            <option value="birm" ${routeType === "birm" ? "selected" : ""}>BIRM</option>
            <option value="hostler" ${routeType === "hostler" ? "selected" : ""}>Hostler</option>
            <option value="na" ${routeType === "na" ? "selected" : ""}>N/A</option>
          </select>
        </div>
        ${routeType === "hostler" ? `
        <div class="field" style="margin-top:8px;">
          <label>Shift Length (hours)</label>
          <input class="cell-input" type="number" step="0.25" id="ld-hostler-hours" value="${escapeHtml(row.hostlerHours || "")}" placeholder="e.g. 8">
        </div>` : ""}`;
    } else {
      defaultsHtml = `<div class="subtext">No editable rate defaults for this location yet.</div>`;
    }

    const linesHtml = breakdown.lines.length
      ? breakdown.lines.map((l) => `
          <div class="rate-breakdown-row">
            <span>${escapeHtml(l.label)}</span>
            <span class="subtext">${escapeHtml(l.detail || "")}</span>
            <span>${fmtRateMoney(l.amount)}</span>
          </div>`).join("")
      : `<div class="subtext" style="padding:6px 0;">${escapeHtml(breakdown.note || "Nothing to calculate yet.")}</div>`;

    return `
      <fieldset class="rate-section">
        <legend class="rate-section-header">Rate</legend>
        <div class="subtext" style="margin: -4px 0 10px;">These boxes apply to this load only — a dot means it's different from the ${escapeHtml(locationKey)} default.</div>
        ${defaultsHtml}

        <div class="rate-total-box">
          <label>Total Rate for this load${row.rateManual ? ' <span class="subtext">(manually overridden)</span>' : ""}</label>
          <input class="cell-input" id="ld-rate-total" type="text" value="${escapeHtml(row.rate || "")}" placeholder="${fmtRateMoney(breakdown.total)}">
          ${row.rateManual ? `<button type="button" class="inline-add-driver" id="ld-rate-reset">Reset to calculated</button>` : ""}
        </div>

        <div class="rate-breakdown">
          <div class="rate-section-subheader">How this was calculated</div>
          ${linesHtml}
          ${breakdown.lines.length ? `<div class="rate-breakdown-row rate-breakdown-total"><span>Total</span><span></span><span>${fmtRateMoney(breakdown.total)}</span></div>` : ""}
        </div>
      </fieldset>`;
  }

  function renderLoadDetailsTabContent() {
    if (!loadDetailsState) return;
    const found = findRowAnywhere(loadDetailsState.rowId);
    const body = $("#ld-tab-content");
    if (!found || !body) return;
    const row = found.row;
    const tab = loadDetailsState.activeTab;
    const drv = row.driverId ? findDriver(row.driverId) : null;

    if (tab === "overview") {
      const editing = loadDetailsState.editMode === "overview";
      let mainHtml;
      if (!editing) {
        mainHtml = `
          <div class="ld-edit-bar"><button type="button" class="btn btn-ghost" data-ld-edit="overview">Edit</button></div>
          <div class="field-box-grid">
            <fieldset class="field-box"><legend>Driver</legend><div class="static-text">${escapeHtml(drv ? drv.name : (row.driverNameText || "—"))}</div></fieldset>
            <fieldset class="field-box"><legend>Status</legend><div class="static-text">${row.shiftComplete ? "Complete" : "Active"}</div></fieldset>
            <fieldset class="field-box"><legend>Trips</legend><div class="static-text">${row.trips.length}</div></fieldset>
            <fieldset class="field-box" style="grid-column: span 2;">
              <legend>Time Sheet</legend>
              <div class="ov-timesheet-row">
                <div><label>Received</label><div class="static-text">${row.timesheetReceived ? "Yes" : "—"}</div></div>
                <div><label>Start</label><div class="static-text">${escapeHtml(row.timesheetStartTime || "—")}</div></div>
                <div><label>Finish</label><div class="static-text">${escapeHtml(row.timesheetEndTime || "—")}</div></div>
              </div>
            </fieldset>
            <fieldset class="field-box"><legend>Trailer Drop Location</legend><div class="static-text">${escapeHtml(row.trailerDropLocation || "—")}</div></fieldset>
          </div>
          <div class="calc-note" style="margin-top:10px;">Time sheet info travels with this load — visible here and on the Accounting page once it's sent over.</div>
        `;
      } else {
        const d = loadDetailsState.editDraft;
        mainHtml = `
          <div class="field-box-grid">
            <fieldset class="field-box"><legend>Driver</legend><input class="cell-input" id="ld-ov-driver" list="driverNamesList" value="${escapeHtml(d.driverName)}"></fieldset>
            <fieldset class="field-box" style="grid-column: span 2;">
              <legend>Time Sheet</legend>
              <div class="ov-timesheet-row">
                <div style="display:flex; align-items:center; gap:6px;">
                  <input type="checkbox" id="ld-ov-timesheet-received" ${d.timesheetReceived ? "checked" : ""}>
                  <label for="ld-ov-timesheet-received" style="margin:0;">Received</label>
                </div>
                <div><label>Start</label><input class="cell-input" id="ld-ov-timesheet-start" placeholder="--:--" value="${escapeHtml(d.timesheetStartTime)}"></div>
                <div><label>Finish</label><input class="cell-input" id="ld-ov-timesheet-end" placeholder="--:--" value="${escapeHtml(d.timesheetEndTime)}"></div>
              </div>
            </fieldset>
            <fieldset class="field-box"><legend>Trailer Drop Location</legend><input class="cell-input" id="ld-ov-trailer-drop-location" value="${escapeHtml(d.trailerDropLocation)}"></fieldset>
          </div>
          <div class="ld-edit-bar">
            <button type="button" class="btn btn-ghost" data-ld-cancel="overview">Cancel</button>
            <button type="button" class="btn" data-ld-save="overview">Save</button>
          </div>
        `;
      }
      recomputeRowRate(row); // guarantees the board's Rate column can't drift from what this panel is about to show
      body.innerHTML = `
        <div class="ld-overview-grid">
          <div class="ld-overview-main">${mainHtml}</div>
          <div class="ld-overview-side">${rateSectionHtml(row)}</div>
        </div>`;
    } else if (tab === "notes") {
      const editing = loadDetailsState.editMode === "notes";
      if (!editing) {
        body.innerHTML = `
          <div class="ld-edit-bar"><button type="button" class="btn btn-ghost" data-ld-edit="notes">Edit</button></div>
          <div class="field"><label>Notes on this load</label><div class="static-text" style="white-space:pre-wrap;">${escapeHtml(row.notes || "—")}</div></div>
          <div class="calc-note" style="margin-top:10px;">These notes travel with the load — visible here and on the Accounting page once it's sent over.</div>
        `;
      } else {
        const d = loadDetailsState.editDraft;
        body.innerHTML = `
          <div class="field"><label>Notes on this load</label><textarea class="cell-input" id="ld-notes-text" rows="6" style="width:100%;">${escapeHtml(d.notes)}</textarea></div>
          <div class="ld-edit-bar">
            <button type="button" class="btn btn-ghost" data-ld-cancel="notes">Cancel</button>
            <button type="button" class="btn" data-ld-save="notes">Save</button>
          </div>
        `;
      }
    } else if (tab.startsWith("trip-")) {
      const tripLocalId = tab.slice(5);
      const trip = row.trips.find((t) => t.id === tripLocalId);
      if (!trip) { body.innerHTML = `<div class="subtext">Trip not found.</div>`; return; }
      const editing = loadDetailsState.editMode === tripLocalId;
      const stops = loadDetailsState.stopsByTrip[tripLocalId] || [];

      if (!editing) {
        const tripDrv = trip.driverId ? findDriver(trip.driverId) : null;
        const stopsHtml = stops.length
          ? stops.map((s) => `<div class="ld-stop-row"><span>Stop ${s.stopNumber}</span><span>In: ${escapeHtml(s.timeIn || "—")}</span><span>Out: ${escapeHtml(s.timeOut || "—")}</span></div>`).join("")
          : `<div class="subtext">No stop times recorded yet.</div>`;
        body.innerHTML = `
          <div class="ld-edit-bar"><button type="button" class="btn btn-ghost" data-ld-edit="${tripLocalId}">Edit</button></div>
          <div class="field-box-grid">
            <fieldset class="field-box"><legend>Route ID</legend><div class="static-text">${escapeHtml(trip.routeId || "—")}</div></fieldset>
            <fieldset class="field-box"><legend>Trip ID</legend><div class="static-text">${escapeHtml(trip.tripId || "—")}</div></fieldset>
            <fieldset class="field-box"><legend>Trailer #</legend><div class="static-text">${escapeHtml(trip.trailerOut || "—")}</div></fieldset>
            <fieldset class="field-box"><legend>Route Miles</legend><div class="static-text">${escapeHtml(trip.routeMiles || "—")}</div></fieldset>
            <fieldset class="field-box"><legend>Stops</legend><div class="static-text">${escapeHtml(trip.stopCount || "—")}</div></fieldset>
            <fieldset class="field-box"><legend>Status</legend><div class="static-text">${trip.minimized ? "Completed" : "Active"}</div></fieldset>
            <fieldset class="field-box" style="grid-column: span 2;"><legend>Driver on this trip</legend><div class="static-text">${escapeHtml(tripDrv ? tripDrv.name : (drv ? drv.name : (row.driverNameText || "—")))}</div></fieldset>
            <fieldset class="field-box" style="grid-column: span 2;"><legend>Notes on this route</legend><div class="static-text" style="white-space:pre-wrap;">${escapeHtml(trip.notes || "—")}</div></fieldset>
            <fieldset class="field-box" style="grid-column: span 2;"><legend>Stop In/Out Times</legend>${stopsHtml}</fieldset>
          </div>
        `;
      } else {
        const d = loadDetailsState.editDraft;
        const stopCount = Math.max(0, parseInt(d.stopCount, 10) || 0);
        body.innerHTML = `
          <div class="field-box-grid">
            <fieldset class="field-box"><legend>Route ID</legend><input class="cell-input" id="ld-tr-routeId" value="${escapeHtml(d.routeId)}"></fieldset>
            <fieldset class="field-box"><legend>Trip ID</legend><input class="cell-input" id="ld-tr-tripId" value="${escapeHtml(d.tripId)}"></fieldset>
            <fieldset class="field-box"><legend>Trailer #</legend><input class="cell-input" id="ld-tr-trailerOut" value="${escapeHtml(d.trailerOut)}"></fieldset>
            <fieldset class="field-box"><legend>Route Miles</legend><input class="cell-input" id="ld-tr-routeMiles" value="${escapeHtml(d.routeMiles)}"></fieldset>
            <fieldset class="field-box"><legend>Stops</legend><input class="cell-input" id="ld-tr-stopCount" value="${escapeHtml(d.stopCount)}"></fieldset>
            <fieldset class="field-box"><legend>Reassign Driver</legend><input class="cell-input" id="ld-tr-driver" list="driverNamesList" value="${escapeHtml(d.driverName)}"><div class="subtext" style="margin-top:4px;">Leave blank to keep the load's driver</div></fieldset>
            <fieldset class="field-box" style="grid-column: span 2;"><legend>Notes on this route</legend><textarea class="cell-input" id="ld-tr-notes" rows="3" style="width:100%;">${escapeHtml(d.notes)}</textarea></fieldset>
            <fieldset class="field-box" style="grid-column: span 2;"><legend>Stop In/Out Times</legend><div id="ld-stop-fields">${stopFieldsHtml(stopCount, d.stops)}</div></fieldset>
          </div>
          <div class="ld-edit-bar">
            <button type="button" class="btn btn-ghost" data-ld-cancel="${tripLocalId}">Cancel</button>
            <button type="button" class="btn" data-ld-save="${tripLocalId}">Save</button>
          </div>
        `;
      }
    } else if (tab === "images") {
      const gallery = loadDetailsState.attachments.length
        ? loadDetailsState.attachments.map((a) => `
            <div class="ld-image-item">
              <img class="ld-image-thumb" src="${escapeHtml(a.publicUrl || "")}" alt="${escapeHtml(a.file_name)}">
              <button type="button" class="ld-image-remove" data-remove-attachment="${a.id}" title="Remove">&times;</button>
            </div>`).join("")
        : `<div class="subtext">No trip sheet images uploaded yet.</div>`;
      body.innerHTML = `
        <input type="file" id="ld-file-input" accept="image/*" multiple>
        <div class="ld-image-gallery" id="ld-image-gallery">${gallery}</div>
      `;
    } else if (tab === "history") {
      const rows = loadDetailsState.history;
      body.innerHTML = `
        <div class="ld-history-row ld-history-row-5col"><div>When</div><div>By</div><div>Field</div><div>Was</div><div>Now</div></div>
        ${rows.length ? rows.map((h) => `
          <div class="ld-history-row ld-history-row-5col">
            <div>${new Date(h.changed_at).toLocaleString()}</div>
            <div>${escapeHtml(h.changed_by || "—")}</div>
            <div>${escapeHtml(h.field_name)}</div>
            <div class="ld-history-old">${escapeHtml(h.old_value || "—")}</div>
            <div class="ld-history-new">${escapeHtml(h.new_value || "—")}</div>
          </div>`).join("") : `<div class="subtext" style="padding:10px 0;">No changes recorded yet.</div>`}
      `;
    }
  }

  export function startLoadDetailsEdit(tabKey) {
    if (!loadDetailsState) return;
    const found = findRowAnywhere(loadDetailsState.rowId);
    if (!found) return;
    const row = found.row;
    loadDetailsState.editMode = tabKey;
    if (tabKey === "overview") {
      const drv = row.driverId ? findDriver(row.driverId) : null;
      loadDetailsState.editDraft = {
        driverName: drv ? drv.name : (row.driverNameText || ""),
        timesheetReceived: !!row.timesheetReceived, timesheetStartTime: row.timesheetStartTime || "", timesheetEndTime: row.timesheetEndTime || "",
        trailerDropLocation: row.trailerDropLocation || "",
      };
    } else if (tabKey === "notes") {
      loadDetailsState.editDraft = { notes: row.notes || "" };
    } else {
      const trip = row.trips.find((t) => t.id === tabKey);
      const tripDrv = trip.driverId ? findDriver(trip.driverId) : null;
      loadDetailsState.editDraft = {
        routeId: trip.routeId || "", tripId: trip.tripId || "", trailerOut: trip.trailerOut || "",
        routeMiles: trip.routeMiles || "", stopCount: trip.stopCount || "",
        driverName: tripDrv ? tripDrv.name : "", notes: trip.notes || "",
        stops: (loadDetailsState.stopsByTrip[tabKey] || []).map((s) => ({ ...s })),
      };
    }
    renderLoadDetailsTabContent();
  }

  export function cancelLoadDetailsEdit() {
    if (!loadDetailsState) return;
    loadDetailsState.editMode = null;
    loadDetailsState.editDraft = null;
    renderLoadDetailsTabContent();
  }

  // Global default-rate edits happen directly in Supabase now (rare
  // enough — once a year or so — that a UI for it wasn't worth the extra
  // surface area). Per-load tweaks go through commitRateBoxOverride()
  // below, which never touches the shared board_rate_tiers /
  // board_rate_settings tables.

  // Everyday path: type a different number into any tier/setting box and
  // it's saved as an override scoped to THIS load only (row.rateOverrides,
  // persisted as the rate_overrides jsonb column) — the shared
  // board_rate_tiers / board_rate_settings tables are never touched.
  // Clearing a box back to empty removes the override, reverting that one
  // figure back to the location's normal default.
  export async function commitRateBoxOverride(kind, idOrKey, rawValue) {
    if (!loadDetailsState) return;
    const found = findRowAnywhere(loadDetailsState.rowId);
    if (!found) return;
    const row = found.row;
    if (!row.rateOverrides) row.rateOverrides = { tiers: {}, settings: {} };
    const bucket = kind === "tier" ? row.rateOverrides.tiers : row.rateOverrides.settings;
    const before = bucket[idOrKey];

    if (String(rawValue).trim() === "") {
      if (before == null) return; // nothing to clear
      delete bucket[idOrKey];
    } else {
      const num = Number(rawValue);
      if (isNaN(num)) return;
      if (before === num) return;
      bucket[idOrKey] = num;
    }

    await saveShiftNow(row);
    recomputeRowRate(row);
    logChange(
      row.dbId, labelForRow(row), `rate_override_${kind}_${idOrKey}`,
      before != null ? String(before) : "(default)",
      bucket[idOrKey] != null ? String(bucket[idOrKey]) : "(default)"
    );
    renderLoadDetailsTabContent();
    renderBoardTable();
  }

  export async function commitRateOverride(newValue) {
    if (!loadDetailsState) return;
    const found = findRowAnywhere(loadDetailsState.rowId);
    if (!found) return;
    const row = found.row;
    const before = row.rate;
    if (String(newValue).trim() === "") {
      row.rate = "";
      row.rateManual = false;
      await saveShiftNow(row);
      recomputeRowRate(row);
    } else {
      row.rate = String(newValue).trim();
      row.rateManual = true;
      await saveShiftNow(row);
    }
    if (before !== row.rate) logChange(row.dbId, labelForRow(row), "rate", before, row.rate);
    renderLoadDetailsTabContent();
    renderBoardTable();
  }

  export function resetRateToCalculated() {
    if (!loadDetailsState) return;
    const found = findRowAnywhere(loadDetailsState.rowId);
    if (!found) return;
    const row = found.row;
    const before = row.rate;
    row.rateManual = false;
    recomputeRowRate(row);
    if (before !== row.rate) logChange(row.dbId, labelForRow(row), "rate", before, row.rate);
    renderLoadDetailsTabContent();
    renderBoardTable();
  }

  export async function saveLoadDetailsEdit(tabKey) {
    if (!loadDetailsState) return;
    const found = findRowAnywhere(loadDetailsState.rowId);
    if (!found) return;
    const row = found.row;
    const d = loadDetailsState.editDraft;

    if (tabKey === "overview") {
      const nameVal = $("#ld-ov-driver").value.trim();
      row.driverNameText = nameVal;
      row.driverId = null;
      const match = driversForLocation(row.location || state.activeLocation || "atlanta").find((x) => x.name.toLowerCase() === nameVal.toLowerCase());
      if (match) row.driverId = match.id;
      row.timesheetReceived = $("#ld-ov-timesheet-received").checked;
      row.timesheetStartTime = $("#ld-ov-timesheet-start").value.trim();
      row.timesheetEndTime = $("#ld-ov-timesheet-end").value.trim();
      row.trailerDropLocation = $("#ld-ov-trailer-drop-location").value.trim();
      await saveShiftNow(row);
    } else if (tabKey === "notes") {
      row.notes = $("#ld-notes-text").value.trim();
      await saveShiftNow(row);
    } else {
      const trip = row.trips.find((t) => t.id === tabKey);
      if (!trip) return;
      trip.routeId = $("#ld-tr-routeId").value.trim();
      trip.tripId = $("#ld-tr-tripId").value.trim();
      trip.trailerOut = $("#ld-tr-trailerOut").value.trim();
      trip.routeMiles = $("#ld-tr-routeMiles").value.trim();
      trip.stopCount = $("#ld-tr-stopCount").value.trim();
      trip.notes = $("#ld-tr-notes").value.trim();
      const driverNameVal = $("#ld-tr-driver").value.trim();
      trip.driverId = null;
      if (driverNameVal) {
        const match = driversForLocation(row.location || state.activeLocation || "atlanta").find((x) => x.name.toLowerCase() === driverNameVal.toLowerCase());
        if (match) trip.driverId = match.id;
      }
      await saveTripNow(row, trip, row.trips.indexOf(trip) + 1);
      recomputeRowRate(row);

      const stopCount = Math.max(0, parseInt(trip.stopCount, 10) || 0);
      const newStops = [];
      for (let i = 0; i < stopCount; i++) {
        const timeIn = document.querySelector(`[data-stop-field="timeIn"][data-stop-index="${i}"]`);
        const timeOut = document.querySelector(`[data-stop-field="timeOut"][data-stop-index="${i}"]`);
        newStops.push({ stopNumber: i + 1, timeIn: timeIn ? timeIn.value.trim() : "", timeOut: timeOut ? timeOut.value.trim() : "" });
      }
      if (supabaseClient && trip.dbId) {
        try {
          for (const s of newStops) {
            const existing = (loadDetailsState.stopsByTrip[tabKey] || []).find((x) => x.stopNumber === s.stopNumber);
            const payload = { trip_id: trip.dbId, stop_number: s.stopNumber, time_in: s.timeIn || null, time_out: s.timeOut || null };
            if (existing && existing.dbId) {
              await supabaseClient.from("trip_stops").update(payload).eq("id", existing.dbId);
            } else {
              await supabaseClient.from("trip_stops").insert(payload);
            }
          }
        } catch (e) {
          setDriverSyncStatus(`Saved the trip, but couldn't save stop times (${e.message || e}).`, "error");
        }
        const { data: freshStops } = await supabaseClient.from("trip_stops").select("*").eq("trip_id", trip.dbId);
        loadDetailsState.stopsByTrip[tabKey] = (freshStops || []).sort((a, b) => a.stop_number - b.stop_number)
          .map((s) => ({ dbId: s.id, stopNumber: s.stop_number, timeIn: s.time_in || "", timeOut: s.time_out || "" }));
      }
    }

    loadDetailsState.editMode = null;
    loadDetailsState.editDraft = null;
    renderLoadDetailsTabs();
    renderBoardTable();
  }

  export async function uploadTripSheetImages(fileList) {
    const found = findRowAnywhere(loadDetailsState.rowId);
    if (!found || !supabaseClient) return;
    const row = found.row;
    if (!row.dbId) { setDriverSyncStatus("Save this load first (enter a driver or PRO#) before uploading images.", "error"); return; }
    for (const file of fileList) {
      const path = `${row.dbId}/${Date.now()}_${file.name}`;
      try {
        const { error: upErr } = await supabaseClient.storage.from("trip-sheets").upload(path, file);
        if (upErr) throw upErr;
        const { data: urlData } = supabaseClient.storage.from("trip-sheets").getPublicUrl(path);
        const { data: inserted, error: insErr } = await supabaseClient.from("load_attachments")
          .insert({ shift_id: row.dbId, file_path: path, file_name: file.name }).select();
        if (insErr) throw insErr;
        loadDetailsState.attachments.push({ ...inserted[0], publicUrl: urlData.publicUrl });
      } catch (e) {
        console.error("uploadTripSheetImages failed:", e);
        setDriverSyncStatus(`Couldn't upload ${file.name} (${e.message || e}).`, "error");
      }
    }
    renderLoadDetailsTabContent();
  }

  export async function removeTripSheetImage(attachmentId) {
    const att = loadDetailsState.attachments.find((a) => String(a.id) === String(attachmentId));
    if (!att || !confirm(`Remove ${att.file_name}?`)) return;
    try {
      await supabaseClient.storage.from("trip-sheets").remove([att.file_path]);
      await supabaseClient.from("load_attachments").delete().eq("id", att.id);
      loadDetailsState.attachments = loadDetailsState.attachments.filter((a) => a.id !== att.id);
      renderLoadDetailsTabContent();
    } catch (e) {
      setDriverSyncStatus(`Couldn't remove that image (${e.message || e}).`, "error");
    }
  }

  async function openLoadHistoryModal(rowId) {
    const found = findRowAnywhere(rowId);
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
      ${getOrderedTripSubcols().map(item).join("")}
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

  export function openAddDriverModal(nestedFromLoad) {
    const modalEl = $("#modal-add-driver");
    if (!modalEl) { console.error('openAddDriverModal: #modal-add-driver not found on this page.'); return; }
    state.addDriverNestedFromLoad = !!nestedFromLoad;
    state.editingDriverId = null;
    modalEl.classList.remove("hidden"); // open first — a missing field below should never block this
    ["ad-name", "ad-phone", "ad-mc", "ad-dispatcher-phone", "ad-email", "ad-email2", "ad-rating", "ad-preference", "ad-carrier", "ad-rate-booking", "ad-notes", "ad-tii-amount"]
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
    setVal("ad-preference", d.preference || "");
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
      preference: $("#ad-preference").value || null,
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

  export function openAddLoadModal() {
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
  export function closeAddLoadModal() { $("#modal-add-load").classList.add("hidden"); }

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

  /* ---------------- midnight rollover (board pages only) ---------------- */

  /* ---------------- "Available" list — persisted, scoped to whichever
     location + date is currently on screen. A name entered against a
     given day stays on that day permanently (through midnight and
     beyond) and simply never shows up on any other day — no active
     clearing needed, the date scoping does that on its own. ---------------- */

  export const AVAILABLE_TABLE = "board_available_drivers";

  function blankAvailableRow() {
    return { id: uid("avail"), dbId: null, driverId: null, driverName: "" };
  }

  function availableRowToDbRow(row, locationKey, dKey) {
    return {
      location: locationKey,
      shift_date: dKey,
      driver_id: row.driverId ? Number(row.driverId) : null,
      driver_name: row.driverName || null,
    };
  }
  function availableRowFromDbRow(dbRow) {
    return {
      id: uid("avail"),
      dbId: dbRow.id,
      driverId: dbRow.driver_id != null ? String(dbRow.driver_id) : null,
      driverName: dbRow.driver_name || "",
    };
  }

  function availableSheetKey(locationKey, dKey) { return `${locationKey}__${dKey}`; }
  function getAvailableSheet(locationKey, dKey) {
    const k = availableSheetKey(locationKey, dKey);
    if (!state.availableSheets[k]) state.availableSheets[k] = [];
    return state.availableSheets[k];
  }

  // Fetches this location+date's Available rows the first time it's
  // viewed this session, same caching pattern as ensureSheetLoaded(). An
  // empty result still gets one blank row so there's always something
  // ready to type into.
  async function ensureAvailableSheetLoaded(locationKey, dKey) {
    const k = availableSheetKey(locationKey, dKey);
    if (state.availableSheets[k]) return;
    if (!supabaseClient) {
      state.availableSheets[k] = [blankAvailableRow()];
      return;
    }
    const { data, error } = await supabaseClient
      .from(AVAILABLE_TABLE).select("*").eq("location", locationKey).eq("shift_date", dKey);
    if (error) {
      console.error("Failed to load Available list:", error);
      state.availableSheets[k] = [blankAvailableRow()];
      return;
    }
    const rows = (data || []).map(availableRowFromDbRow);
    state.availableSheets[k] = rows.length ? rows : [blankAvailableRow()];
  }

  async function saveAvailableRowNow(row, locationKey, dKey) {
    if (!supabaseClient) return null;
    try {
      const payload = availableRowToDbRow(row, locationKey, dKey);
      if (row.dbId) {
        const { error } = await supabaseClient.from(AVAILABLE_TABLE).update(payload).eq("id", row.dbId);
        if (error) { console.error("Failed to save Available row:", error); return null; }
        return row.dbId;
      }
      const { data, error } = await supabaseClient.from(AVAILABLE_TABLE).insert(payload).select();
      if (error) { console.error("Failed to create Available row:", error); return null; }
      row.dbId = data[0].id;
      return row.dbId;
    } catch (e) {
      console.error("saveAvailableRowNow threw:", e);
      return null;
    }
  }

  const availableSaveTimers = new Map();
  function scheduleAvailableRowSave(row, locationKey, dKey) {
    clearTimeout(availableSaveTimers.get(row.id));
    availableSaveTimers.set(row.id, setTimeout(() => saveAvailableRowNow(row, locationKey, dKey), SAVE_DEBOUNCE_MS));
  }

  function availableRowHtml(row) {
    const drv = row.driverId ? findDriver(row.driverId) : null;
    const displayName = drv ? drv.name : row.driverName;
    return `<tr id="${row.id}">
      <td class="col-availDriver">
        <input class="cell-input" list="driverNamesList" placeholder="Type driver name…" data-avail-row="${row.id}" value="${escapeHtml(displayName)}">
      </td>
      <td class="col-cell"><span class="static-text">${escapeHtml(drv && drv.phone ? drv.phone : "—")}</span></td>
      <td class="col-dispatcherPhone"><span class="static-text">${escapeHtml(drv && drv.dispatcherPhone ? drv.dispatcherPhone : "—")}</span></td>
      <td class="col-email"><span class="static-text">${escapeHtml(drv && drv.email ? drv.email : "—")}</span></td>
      <td class="col-mc"><span class="static-text">${escapeHtml(drv && drv.mc ? drv.mc : "—")}</span></td>
      <td class="col-rating"><span class="static-text">${escapeHtml(drv && drv.rating ? drv.rating : "—")}</span></td>
      <td class="col-availRemove"><button type="button" class="available-remove-btn" data-avail-remove="${row.id}" title="Remove">&times;</button></td>
    </tr>`;
  }

  function renderAvailableTable() {
    const body = $("#available-table-body");
    if (!body) return;
    body.innerHTML = getAvailableSheet(state.activeLocation, state.activeDate).map(availableRowHtml).join("");
    const titleEl = $(".available-title");
    if (titleEl) {
      const isToday = state.activeDate === state.todayKey;
      titleEl.textContent = `Available — ${humanDate(keyToDate(state.activeDate))}${isToday ? " (today)" : ""}`;
    }
  }

  function addAvailableRow() {
    getAvailableSheet(state.activeLocation, state.activeDate).push(blankAvailableRow());
    renderAvailableTable();
  }

  async function removeAvailableRow(rowId) {
    const sheet = getAvailableSheet(state.activeLocation, state.activeDate);
    const row = sheet.find((r) => r.id === rowId);
    const idx = sheet.findIndex((r) => r.id === rowId);
    if (idx !== -1) sheet.splice(idx, 1);
    renderAvailableTable();
    if (row && row.dbId && supabaseClient) {
      try { await supabaseClient.from(AVAILABLE_TABLE).delete().eq("id", row.dbId); }
      catch (e) { console.error("Failed to delete Available row:", e); }
    }
  }

  // Called whenever the board switches to a different day (or on first
  // load) — loads that day's Available rows if they aren't cached yet and
  // redraws the section. Exported so houston.js's own date navigation can
  // trigger the same refresh.
  export async function refreshAvailableSection() {
    if (!$("#available-table-body")) return; // not every page has this section
    await ensureAvailableSheetLoaded(state.activeLocation, state.activeDate);
    renderAvailableTable();
  }

  // Keeps the Available list in sync when a second dispatcher adds,
  // edits, or removes a name on the same day — without this, each tab
  // only ever sees its own edits until the page is reloaded.
  function handleRealtimeAvailableChange(payload) {
    const locationKey = state.activeLocation;
    if (!locationKey) return;
    if (payload.eventType === "DELETE") {
      const oldRow = payload.old;
      if (!oldRow) return;
      for (const k in state.availableSheets) {
        const sheet = state.availableSheets[k];
        const idx = sheet.findIndex((r) => r.dbId === oldRow.id);
        if (idx !== -1) { sheet.splice(idx, 1); if (k === availableSheetKey(state.activeLocation, state.activeDate)) renderAvailableTable(); break; }
      }
      return;
    }
    const dbRow = payload.new;
    if (!dbRow || dbRow.location !== locationKey) return;
    const k = availableSheetKey(dbRow.location, dbRow.shift_date);
    if (!state.availableSheets[k]) return; // that day isn't cached in this tab yet — nothing to merge into
    const sheet = state.availableSheets[k];
    const existing = sheet.find((r) => r.dbId === dbRow.id);
    if (existing) {
      Object.assign(existing, availableRowFromDbRow(dbRow), { id: existing.id });
    } else {
      // Drop the lone starting blank row once real data arrives, same as the board's own sheets do
      const onlyBlank = sheet.length === 1 && !sheet[0].dbId && !sheet[0].driverName.trim();
      if (onlyBlank) sheet.length = 0;
      sheet.push(availableRowFromDbRow(dbRow));
    }
    if (k === availableSheetKey(state.activeLocation, state.activeDate)) renderAvailableTable();
  }

  export function setupAvailableRealtimeSync(locationKey) {
    if (!supabaseClient) return;
    const channel = supabaseClient.channel(`available-${locationKey}`);
    channel.on("postgres_changes", { event: "*", schema: "public", table: AVAILABLE_TABLE, filter: `location=eq.${locationKey}` }, handleRealtimeAvailableChange);
    channel.subscribe();
  }

  export function initAvailableSection() {
    if (!$("#available-table-body")) return; // not every page has this section
    refreshAvailableSection();
    setupAvailableRealtimeSync(state.activeLocation || "atlanta");

    on("btn-available-add-row", "click", addAvailableRow);

    const table = $("#available-table");
    table.addEventListener("click", (e) => {
      const rmBtn = e.target.closest("[data-avail-remove]");
      if (rmBtn) removeAvailableRow(rmBtn.dataset.availRemove);
    });
    table.addEventListener("input", (e) => {
      const t = e.target;
      if (!t.dataset.availRow) return;
      const row = getAvailableSheet(state.activeLocation, state.activeDate).find((r) => r.id === t.dataset.availRow);
      if (!row) return;
      row.driverName = t.value;
      row.driverId = null;
      const match = driversForLocation(state.activeLocation || "atlanta").find((d) => d.name.toLowerCase() === t.value.trim().toLowerCase());
      if (match) row.driverId = match.id;
      scheduleAvailableRowSave(row, state.activeLocation, state.activeDate);
    });
    table.addEventListener("focusout", (e) => {
      const t = e.target;
      if (!t.dataset.availRow) return;
      renderAvailableTable(); // refresh the driver-linked columns now that typing is done, without disrupting the datalist mid-type
    });
  }

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

  export function on(id, event, handler) {
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
    if ($("#modal-send-text")) {
      const closeSendText = () => { $("#modal-send-text").classList.add("hidden"); sendTextModalState = null; };
      on("send-text-close", "click", closeSendText);
      on("send-text-cancel", "click", closeSendText);
      on("send-text-submit", "click", submitSendTextModal);
      $("#modal-send-text").addEventListener("click", (e) => { if (e.target.id === "modal-send-text") closeSendText(); });
      const msgInput = $("#send-text-message");
      if (msgInput) msgInput.addEventListener("input", updateSendTextCounter);
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
    initAvailableSection();

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
      on("tg-send-now", "click", sendCurrentGroupBatchDirect);
      on("tg-open-batch", "click", openCurrentGroupBatch);
      on("tg-confirm-sent", "click", confirmGroupBatchSent);
      on("tg-finish", "click", () => $("#modal-text-group").classList.add("hidden"));
      $("#modal-text-group").addEventListener("click", (e) => { if (e.target.id === "modal-text-group") $("#modal-text-group").classList.add("hidden"); });
    }

    if ($("#modal-stop-times")) {
      on("st-close", "click", closeStopTimesModal);
      on("st-skip", "click", () => finalizeTripCompletion(false));
      on("st-confirm", "click", () => finalizeTripCompletion(true));
      $("#modal-stop-times").addEventListener("click", (e) => { if (e.target.id === "modal-stop-times") closeStopTimesModal(); });
    }

    if ($("#modal-timesheet-complete")) {
      on("tsc-close", "click", skipTimesheetModal);
      on("tsc-cancel", "click", skipTimesheetModal);
      on("tsc-confirm", "click", submitTimesheetModal);
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
      });
      $("#ld-tab-content").addEventListener("input", (e) => {
        if (e.target.id === "ld-tr-stopCount" && loadDetailsState && loadDetailsState.editDraft) {
          loadDetailsState.editDraft.stopCount = e.target.value;
          const container = $("#ld-stop-fields");
          if (container) container.innerHTML = stopFieldsHtml(Math.max(0, parseInt(e.target.value, 10) || 0), loadDetailsState.editDraft.stops);
        }
      });
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
      if (e.target.closest("#btn-quick-add-row")) quickAddBlankRow();
      const minimizeBtn = e.target.closest('[data-action="minimize-trip"]');
      if (minimizeBtn) minimizeTrip(minimizeBtn.dataset.row, minimizeBtn.dataset.trip);
      const restoreBtn = e.target.closest('[data-action="restore-trip"]');
      if (restoreBtn) restoreTrip(restoreBtn.dataset.row, restoreBtn.dataset.trip);
      const addTripBtn = e.target.closest('[data-action="add-trip"]');
      if (addTripBtn) addNewTrip(addTripBtn.dataset.row);
      const completeBtn = e.target.closest('[data-action="complete-trip"]');
      if (completeBtn && !completeBtn.disabled) completeTrip(completeBtn.dataset.row, completeBtn.dataset.trip);
      const openProBtn = e.target.closest('[data-open-pro]');
      if (openProBtn) openLoadDetailsModal(openProBtn.dataset.openPro, openProBtn.dataset.trip || null);
    });
    boardTable.addEventListener("focusin", (e) => {
      const field = e.target.dataset && e.target.dataset.field;
      const rowId = e.target.dataset && e.target.dataset.row;
      if (!rowId || (field !== "notes" && field !== "driverName")) return;
      focusValueSnapshots.set(`${rowId}:${field}`, e.target.value);
    });
    boardTable.addEventListener("focusout", (e) => {
      const t = e.target;
      const field = t.dataset && t.dataset.field;
      const rowId = t.dataset && t.dataset.row;
      if (rowId && (field === "notes" || field === "driverName")) {
        const snapKey = `${rowId}:${field}`;
        const before = focusValueSnapshots.get(snapKey);
        focusValueSnapshots.delete(snapKey);
        if (before !== undefined && before !== t.value) {
          const found = findRowAnywhere(rowId);
          if (found) {
            if (field === "notes") {
              logChange(found.row.dbId, labelForRow(found.row), "notes", before, t.value);
            } else if (before.trim()) {
              // driverName: only a REASSIGNMENT if it already had a driver — first-time entry isn't logged as a change
              logChange(found.row.dbId, labelForRow(found.row), "driver_reassigned", before, t.value);
            }
          }
        }
      }
      if (field === "routeId") {
        const tr = t.closest("tr");
        const completeBtn = tr ? tr.querySelector('[data-action="complete-trip"]') : null;
        if (completeBtn) {
          const hasRoute = !!t.value.trim();
          completeBtn.disabled = !hasRoute;
          completeBtn.title = hasRoute ? "Mark closed out" : "Enter a Route ID first";
        }
        // fall through — routeId also owns the open-details link button now
      }
      if (field !== "proNumber" && field !== "routeId") return;
      const wrap = t.closest(".cell-with-link");
      if (!wrap) return;
      let btn = wrap.querySelector(".cell-link-btn");
      if (t.value.trim()) {
        if (!btn) {
          btn = document.createElement("button");
          btn.type = "button";
          btn.className = "cell-link-btn";
          btn.title = field === "proNumber" ? "Open load details" : "Open route details";
          btn.textContent = "↗";
          btn.dataset.openPro = t.dataset.row;
          if (field === "routeId") btn.dataset.trip = t.dataset.trip;
          wrap.appendChild(btn);
        }
      } else if (btn) {
        btn.remove();
      }
    });
    boardTable.addEventListener("contextmenu", (e) => {
      const tr = e.target.closest("tr");
      if (!tr || !tr.id) return; // header row has no id — let the browser's normal menu show there
      e.preventDefault();
      openRowContextMenu(tr.id, e.clientX, e.clientY);
    });
    let draggedColKey = null;
    boardTable.addEventListener("dragstart", (e) => {
      const th = e.target.closest("[data-col-key]");
      if (!th) return;
      draggedColKey = th.dataset.colKey;
      e.dataTransfer.effectAllowed = "move";
    });
    boardTable.addEventListener("dragover", (e) => {
      const th = e.target.closest("[data-col-key]");
      if (!th || !draggedColKey) return;
      e.preventDefault(); // required to allow a drop
      $all(".col-drop-target", boardTable).forEach((el) => el.classList.remove("col-drop-target"));
      if (th.dataset.colKey !== draggedColKey) th.classList.add("col-drop-target");
    });
    boardTable.addEventListener("dragleave", (e) => {
      const th = e.target.closest("[data-col-key]");
      if (th) th.classList.remove("col-drop-target");
    });
    boardTable.addEventListener("drop", (e) => {
      const th = e.target.closest("[data-col-key]");
      $all(".col-drop-target", boardTable).forEach((el) => el.classList.remove("col-drop-target"));
      if (!th || !draggedColKey) return;
      e.preventDefault();
      const targetKey = th.dataset.colKey;
      if (targetKey !== draggedColKey) moveTripCol(draggedColKey, targetKey);
      draggedColKey = null;
    });
    boardTable.addEventListener("dragend", () => {
      draggedColKey = null;
      $all(".col-drop-target", boardTable).forEach((el) => el.classList.remove("col-drop-target"));
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
        if (t.value.trim() === "") {
          found.row.rateManual = false;
          recomputeRowRate(found.row);
        } else {
          found.row.rateManual = true;
          scheduleShiftSave(found.row);
        }
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
      if (["etaShiftReport", "notes", "revLevel"].includes(t.dataset.field) && !t.dataset.trip) {
        found.row[t.dataset.field] = t.value;
        scheduleShiftSave(found.row);
        return;
      }
      if (t.dataset.trip && t.dataset.field) {
        const trip = found.row.trips.find((tr) => tr.id === t.dataset.trip);
        if (trip) {
          trip[t.dataset.field] = t.value;
          if (t.dataset.field === "dispatchTime" || t.dataset.field === "routeMiles") autoFillCalcTimes(rowId, trip);
          recalcRowCalcCellsInPlace(rowId);
          scheduleTripSave(found.row, trip, found.row.trips.indexOf(trip) + 1);
          if (t.dataset.field === "routeMiles" || t.dataset.field === "stopCount") recomputeRowRate(found.row);
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
      if (t.dataset.action === "change-route-type") {
        changeRouteType(t.dataset.row, t.value);
        return;
      }
      if (t.type === "checkbox" && !t.dataset.trip && t.dataset.field === "preShiftTextSent") {
        const found = findRowAnywhere(t.dataset.row);
        if (!found) return;
        found.row[t.dataset.field] = t.checked;
        found.row.preShiftTextSentAt = t.checked ? new Date().toISOString() : null;
        scheduleShiftSave(found.row);
        return;
      }
      if (t.type === "checkbox" && t.dataset.trip) {
        const found = findRowAnywhere(t.dataset.row);
        if (!found) return;
        const trip = found.row.trips.find((tr) => tr.id === t.dataset.trip);
        if (trip) {
          trip[t.dataset.field] = t.checked;
          const td = t.closest("td");
          td.classList.toggle(t.dataset.field === "backhaul" ? "flag-backhaul" : "flag-yes", t.checked);
          saveTripNow(found.row, trip, found.row.trips.indexOf(trip) + 1);

          if (t.checked && (t.dataset.field === "salvage" || t.dataset.field === "backhaul")) {
            const drv = trip.driverId ? findDriver(trip.driverId) : (found.row.driverId ? findDriver(found.row.driverId) : null);
            const phone = drv ? drv.phone : found.row.cellSnapshot;
            const message = t.dataset.field === "salvage" ? SALVAGE_MESSAGE : BACKHAUL_MESSAGE;
            if (phone) textDriverPhone(phone, message);
            else setDriverSyncStatus(`Marked as ${t.dataset.field} — no phone on file for this driver to send the heads-up text.`, "error");
          }
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
    on("tg-send-now", "click", sendCurrentGroupBatchDirect);
      on("tg-open-batch", "click", openCurrentGroupBatch);
    on("tg-confirm-sent", "click", confirmGroupBatchSent);
    const closeTextGroupModal = () => $("#modal-text-group").classList.add("hidden");
    on("tg-finish", "click", closeTextGroupModal);
    on("tg-cancel", "click", closeTextGroupModal);
    on("tg-close", "click", closeTextGroupModal);
    if ($("#modal-text-group")) $("#modal-text-group").addEventListener("click", (e) => { if (e.target.id === "modal-text-group") closeTextGroupModal(); });
  }

  
  



  /* ---------------- init ---------------- */

  async function init() {
    const ok = await requireAuth();
    if (!ok) return; // requireAuth() already redirected to login.html

    const info = PAGE_MAP[currentFile()];
    if (info && info.type === "accounting" && !isAccountingUser()) {
      window.location.href = "index.html";
      return;
    }

    try { renderNav(); } catch (e) { console.error("renderNav() failed:", e); }
    try { startAlertScanning(); } catch (e) { console.error("startAlertScanning() failed:", e); }
    try { wireModals(); } catch (e) { console.error("wireModals() failed:", e); }
    try { await loadBoardRateData(); } catch (e) { console.error("loadBoardRateData() failed:", e); }
    try {
      if (info.type === "board") initBoardPage(info);
      else if (info.type === "houston-board") initHoustonBoardPage(info);
      else if (info.type === "mondelez") initMondelezPage();
      else if (info.type === "driverlist") initDriverListPage();
      else if (info.type === "accounting") initAccountingPage();
    } catch (e) { console.error("page-specific init failed:", e); }
    loadDriversFromSupabase().catch((e) => console.error("loadDriversFromSupabase() failed:", e));
  }

  document.addEventListener("DOMContentLoaded", init);