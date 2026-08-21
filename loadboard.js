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
import { initDriverAnalyticsPage } from './analytics-drivers.js';
import { initVolumePage } from './analytics-volume.js';
import { initLocationAnalyticsPage } from './location-analytics.js';
import { renderNav, startAlertScanning, IDLE_THRESHOLD_MIN, PRE_SHIFT_TEXT_LEAD_MIN, PRE_SHIFT_CALL_FOLLOWUP_MIN, PRE_SHIFT_ESCALATION_MIN, LAST_STOP_RETURN_FOLLOWUP_MIN } from './alerts.js';
import { loadBoardRateData, getBoardRateTiers, getBoardRateSettings, calcLoadRateBreakdown, effectiveTierRate, effectiveSetting, isTierOverridden, isSettingOverridden, isDriverTierOverridden, isDriverSettingOverridden, saveTierRate, saveSetting } from './boardrates.js';

  /* ---------------- page map (single source of truth for nav) ---------------- */

  export const PAGE_MAP = {
    "index.html":      { type: "board",       key: "atlanta",   label: "Atlanta",    title: "Atlanta Spreadsheet"    },
    "dalaware.html":   { type: "board",       key: "delaware",  label: "Delaware",   title: "Delaware Spreadsheet"   },
    "buildingc.html":  { type: "board",       key: "buildingc", label: "Building C", title: "Building C Spreadsheet" },
    "houston.html":    { type: "houston-board", key: "houston",   label: "Houston",    title: "Houston Spreadsheet"    },
    "mondelez.html":   { type: "mondelez",    label: "Mondelez" },
    "accounting.html": { type: "accounting",  label: "Accounting" },
    "driverlist.html": { type: "driverlist",  label: "Driver List" },
    "analytics-drivers.html": { type: "driver-analytics", label: "Driver Analytics" },
    "analytics-volume.html": { type: "volume", label: "Volume" },
    "location-analytics.html": { type: "location-analytics", label: "Location Analytics" },
    "historics.html":  { type: "historics",   label: "Historics" },
  };
  export const NAV_ORDER = ["index.html", "dalaware.html", "buildingc.html", "houston.html", "mondelez.html", "accounting.html", "driverlist.html", "analytics-drivers.html", "location-analytics.html", "analytics-volume.html"];
  const LOCATIONS = NAV_ORDER
    .filter((f) => PAGE_MAP[f].type === "board" || PAGE_MAP[f].type === "houston-board")
    .map((f) => ({ file: f, ...PAGE_MAP[f] }));

  export function currentFile() {
    const p = location.pathname.split("/").pop();
    return p && PAGE_MAP[p] ? p : "index.html";
  }

  /* ---------------- constants ---------------- */

  const HIGHLIGHT_MS = 30 * 60 * 1000; // 30 minutes, per spec
  const HISTORY_DAYS = 730;             // ~2 years back — covers all imported historic data with room to spare, no separate Historics page needed
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
    { key: "lastStopDepart",  label: "Last Stop Depart",   type: "time", pistachio: true, excludeLocations: ["delaware"] },
    { key: "returnToDC",      label: "Return to DC",       type: "time", pistachio: true, excludeLocations: ["delaware"] },
    { key: "salvage",     label: "Salvage",            type: "checkbox", group: "backhaul", pistachio: true, excludeLocations: ["delaware"] },
    { key: "backhaul",    label: "B/Haul",             type: "checkbox", group: "backhaul", pistachio: true, excludeLocations: ["delaware"] },
    { key: "salvageBhaulRefusedBy",  label: "Refused By",          type: "text", group: "backhaul", pistachio: true, excludeLocations: ["delaware"] },
    { key: "backhaulTrailerNumber",  label: "B/Haul Trailer #",    type: "text", group: "backhaul", pistachio: true, excludeLocations: ["delaware"] },
    { key: "returnEtaToDc",          label: "Return ETA to DC",    type: "time", group: "backhaul", pistachio: true, excludeLocations: ["delaware"] },
    { key: "routeImage",      label: "Image",              type: "image" },
    { key: "routeEstHours",   label: "Route Est Hours",    type: "text", small: true, inputmode: "decimal", group: "estimate", excludeLocations: ["delaware"] },
    { key: "timeToFinalStop", label: "Time to Last Stop",  type: "text", small: true, inputmode: "decimal", group: "estimate", excludeLocations: ["delaware"] },
    { key: "timeToDc",        label: "Time to DC",         type: "text", small: true, inputmode: "decimal", group: "estimate", excludeLocations: ["delaware"] },
    // Not in the latest specified order -- kept available (hidden by
    // default) rather than deleted, since removal wasn't explicit. Flagged
    // in chat; say the word if any of these should actually go.
    { key: "backhaulType",           label: "B/Haul Type",         type: "text", group: "backhaul", excludeLocations: ["delaware"] },
    { key: "etaToFinalStop",         label: "ETA to Final Stop",   type: "time", group: "estimate", excludeLocations: ["delaware"] },
    { key: "estRouteComplete",       label: "Est Route Complete",  type: "time", group: "estimate", excludeLocations: ["delaware"] },
    { key: "etaNextDispatch", label: "ETA Next Dispatch",  type: "calc", excludeLocations: ["delaware"] },
    { key: "tripCallTime",    label: "Trip Call Time",     type: "calc", excludeLocations: ["delaware"] },
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
    return tripColOrder.map((k) => byKey[k]).filter(Boolean)
      .filter((c) => !c.excludeLocations || !c.excludeLocations.includes(state.activeLocation));
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
  // Same bucket Mondelez's route-image feature already uses -- reused here
  // rather than a new one, since storage paths are namespaced by each row's
  // own dbId regardless of which board it came from, so there's no
  // collision risk, and it avoids needing a second bucket created in Supabase.
  export const BOARD_IMAGE_BUCKET = "mondelez-routes";
  const SIGNED_URL_EXPIRY_SECONDS = 3600; // 1 hour -- long enough to cover a normal session; refreshed on every reload anyway

  // Private-bucket signed URLs, batched -- call once per sheet load with
  // every image path that needs a URL and the object each one belongs on,
  // in matching order. A public bucket could just build the URL directly
  // with no network call; a private one has to ask Supabase to mint a
  // temporary, expiring link for each file instead, since nothing is
  // viewable without one.
  export async function batchSignImageUrls(bucket, paths, targets) {
    if (!paths.length || !supabaseClient) return;
    try {
      const { data, error } = await supabaseClient.storage.from(bucket).createSignedUrls(paths, SIGNED_URL_EXPIRY_SECONDS);
      if (error) throw error;
      (data || []).forEach((entry, i) => {
        if (entry && entry.signedUrl && targets[i]) targets[i].routeImageUrl = entry.signedUrl;
      });
    } catch (e) {
      console.error("batchSignImageUrls failed:", e);
    }
  }

  export const ACCOUNTING_TABLE = "loads_accounting";
  export const ACCOUNTING_ROUTES_TABLE = "loads_accounting_routes";

  // Shared editable "notes" system — a small free-form textarea, same idea
  // on every page: rate cards, reminders, anything worth having on hand
  // right next to the page title. One row per key in location_notes —
  // accounting uses its location tabs ("atlanta" etc) as the key, board
  // pages use their own page-based key.
  let sharedNotesCache = {}; // key -> notes text

  export async function loadLocationNotes() {
    if (!supabaseClient) return;
    const { data, error } = await supabaseClient.from("location_notes").select("*");
    if (error) { console.error("Failed to load location notes:", error); return; }
    sharedNotesCache = {};
    (data || []).forEach((r) => { sharedNotesCache[r.location] = r.notes || ""; });
  }

  export function openLocationNotesModal(key, label) {
    const modal = $("#modal-location-notes");
    if (!modal) return;
    if ($("#ln-title")) $("#ln-title").textContent = `${label || key} — Notes`;
    if ($("#ln-textarea")) $("#ln-textarea").value = sharedNotesCache[key] || "";
    modal.dataset.location = key;
    modal.classList.remove("hidden");
  }

  export function closeLocationNotesModal() {
    const modal = $("#modal-location-notes");
    if (modal) modal.classList.add("hidden");
  }

  export async function saveLocationNotes() {
    const modal = $("#modal-location-notes");
    if (!modal) return;
    const key = modal.dataset.location;
    const notes = $("#ln-textarea") ? $("#ln-textarea").value : "";
    sharedNotesCache[key] = notes;
    closeLocationNotesModal();
    try {
      const { error } = await supabaseClient.from("location_notes").upsert({ location: key, notes, updated_at: new Date().toISOString() }, { onConflict: "location" });
      if (error) throw error;
    } catch (e) {
      console.error("saveLocationNotes failed:", e);
      setDriverSyncStatus(`Couldn't save the notes (${e.message || e}).`, "error");
    }
  }

  // Starts as null so module evaluation itself never blocks or waits on
  // anything — initSupabaseClient() (called from init(), after
  // DOMContentLoaded) does the actual waiting for the CDN script and
  // assigns this. Every usage across every file is inside a function
  // body that only ever runs after init() has completed, so this being
  // temporarily null at module-load time is safe — nothing reads it that
  // early. `let` + export gives every importer a live binding, so they
  // all see the real client the moment it's assigned here.
  export let supabaseClient = null;

  async function initSupabaseClient() {
    if (typeof window === "undefined") return;
    const start = Date.now();
    while (!window.supabase && Date.now() - start < 4000) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (window.supabase) {
      supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, storageKey: "dl-dispatch-auth" },
      });
    }
  }

  let currentUserRole = null; // set by requireAuth() before any page-specific init runs
  let currentUserLabel = null; // "username" (the @dltransport.local suffix stripped) — used for audit logging

  async function requireAuth() {
    if (!supabaseClient) return true; // no client configured (e.g. local test) — don't block
    let sessionResult;
    try {
      sessionResult = await Promise.race([
        supabaseClient.auth.getSession(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timed out checking login session")), 6000)),
      ]);
    } catch (e) {
      // getSession() hanging or erroring should never leave the app stuck
      // forever with zero feedback — treat it the same as "not logged in"
      // and send to login, but log it clearly since a hang here usually
      // means something's actually wrong (stale/corrupted auth token in
      // local storage is the most common cause).
      console.error("requireAuth(): session check failed or timed out —", e);
      window.location.href = "login.html";
      return false;
    }
    const { data } = sessionResult;
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

  export function isAccountingUser() { return currentUserRole === "accounting" || currentUserRole === "admin"; }
  export function isAdminUser() { return currentUserRole === "admin"; }

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
      "normal_rate": d.normalRate !== "" && d.normalRate != null ? Number(d.normalRate) : null,
      "runs_out_of": d.runsOutOf && d.runsOutOf.length ? d.runsOutOf : null,
      "atlanta_rate_overrides": d.atlantaRateOverrides && (Object.keys(d.atlantaRateOverrides.tiers || {}).length || Object.keys(d.atlantaRateOverrides.settings || {}).length) ? d.atlantaRateOverrides : null,
    };
  }
  export function driverFromDbRow(row) {
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
      runsOutOf: row["runs_out_of"] || [],
      atlantaRateOverrides: row["atlanta_rate_overrides"] ? { tiers: row["atlanta_rate_overrides"].tiers || {}, settings: row["atlanta_rate_overrides"].settings || {} } : { tiers: {}, settings: {} },
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
      called_off: !!row.calledOff,
      called_off_reason: row.calledOffReason || null,
      called_off_notes: row.calledOffNotes || null,
      called_off_at: row.calledOffAt || null,
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
      sentToAccounting: !!dbRow.sent_to_accounting,
      calledOff: !!dbRow.called_off,
      calledOffReason: dbRow.called_off_reason || "",
      calledOffNotes: dbRow.called_off_notes || "",
      calledOffAt: dbRow.called_off_at || null,
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
      completed_at: trip.completedAt || null,
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
      checked_in: !!trip.checkedIn,
      timesheet_start_time: trip.timesheetStartTime || null,
      timesheet_end_time: trip.timesheetEndTime || null,
      drop_location_text: trip.dropLocationText || null,
      return_to_dc_text: trip.returnToDcText || null,
      route_est_hours: trip.routeEstHours !== "" && trip.routeEstHours != null ? Number(trip.routeEstHours) : null,
      time_to_final_stop: trip.timeToFinalStop || null,
      time_to_dc: trip.timeToDc !== "" && trip.timeToDc != null ? Number(trip.timeToDc) : null,
      eta_to_final_stop: trip.etaToFinalStop || null,
      est_route_complete: trip.estRouteComplete || null,
      route_image_path: trip.routeImagePath || null,
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
      checkedIn: !!dbRow.checked_in,
      timesheetStartTime: dbRow.timesheet_start_time || "",
      timesheetEndTime: dbRow.timesheet_end_time || "",
      dropLocationText: dbRow.drop_location_text || "",
      returnToDcText: dbRow.return_to_dc_text || "",
      routeEstHours: dbRow.route_est_hours != null ? String(dbRow.route_est_hours) : "",
      timeToFinalStop: dbRow.time_to_final_stop || "",
      timeToDc: dbRow.time_to_dc != null ? String(dbRow.time_to_dc) : "",
      etaToFinalStop: dbRow.eta_to_final_stop || "",
      estRouteComplete: dbRow.est_route_complete || "",
      hasStopTimes: false, // computed client-side after loading, see ensureSheetLoaded — not a real DB column
      routeImagePath: dbRow.route_image_path || "",
      routeImageUrl: "", // filled in by batchSignImageUrls after loading — see ensureSheetLoaded
      completedAt: dbRow.completed_at || null,
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
    const m = /^(\d{1,2}):?(\d{2})$/.exec(String(str).trim());
    if (!m) return null;
    const h = Number(m[1]), mm = Number(m[2]);
    if (h > 23 || mm > 59) return null;
    return h * 60 + mm;
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
    driverSort: { key: "rating", dir: "asc" },
    boardSort: { key: "shiftStart", dir: "asc" },
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

  // What "the rate" means for a driver depends on which Driver List tab
  // you're looking at. On Atlanta (which shares its pool with Building C),
  // dispatchers actually mean the 61-140mi tier rate when they say "a
  // driver's rate" — not the flat normalRate field, which is really just
  // a cross-location fallback. Everywhere else (Delaware, Houston,
  // Mondelez), there's no mileage-tier structure, so normalRate IS the
  // rate. This is the single place that distinction gets made, so the
  // sort and the displayed column can never disagree with each other.
  function getDriverDisplayRate(d) {
    if (state.driverListTab === "atlanta") {
      const tiers = (getBoardRateTiers() && getBoardRateTiers().atlanta) || [];
      const tier = tiers.find((t) => t.min === 61 && t.max === 140);
      if (tier) {
        const override = d.atlantaRateOverrides && d.atlantaRateOverrides.tiers ? d.atlantaRateOverrides.tiers[tier.id] : undefined;
        return override != null ? override : tier.rate;
      }
    }
    return d.normalRate !== "" && d.normalRate != null ? Number(d.normalRate) : null;
  }

  function compareForSort(a, b, key, dir) {
    let av, bv;
    if (key === "displayRate") {
      av = getDriverDisplayRate(a);
      bv = getDriverDisplayRate(b);
    } else {
      av = a[key]; bv = b[key];
    }
    const aEmpty = av === null || av === undefined || av === "";
    const bEmpty = bv === null || bv === undefined || bv === "";
    if (aEmpty && bEmpty) return 0;
    if (aEmpty) return 1;  // blanks always sort last, regardless of direction
    if (bEmpty) return -1;
    const cmp = (key === "mc" || key === "normalRate" || key === "displayRate")
      ? Number(av) - Number(bv)
      : String(av).localeCompare(String(bv), undefined, { sensitivity: "base", numeric: true });
    return dir === "desc" ? -cmp : cmp;
  }

  // Board grid sort — Driver sorts alphabetically; Shift Start / ETA /
  // Next Call Time sort chronologically (parsed as HH:MM, not as plain
  // text, so "9:00" and "09:00" both land in the right place and "13:00"
  // doesn't sort before "9:00" the way it would as a string).
  function compareRowsForSort(a, b, key, dir) {
    let av, bv;
    if (key === "driverName") {
      const da = a.driverId ? findDriver(a.driverId) : null;
      const db = b.driverId ? findDriver(b.driverId) : null;
      av = (da ? da.name : a.driverNameText) || "";
      bv = (db ? db.name : b.driverNameText) || "";
      const aEmpty = !av.trim(), bEmpty = !bv.trim();
      if (aEmpty && bEmpty) return 0;
      if (aEmpty) return 1;
      if (bEmpty) return -1;
      const cmp = av.localeCompare(bv, undefined, { sensitivity: "base", numeric: true });
      return dir === "desc" ? -cmp : cmp;
    }
    if (key === "nextCallTimeCalc") { av = parseHHMM(computeNextCallTimeForRow(a)); bv = parseHHMM(computeNextCallTimeForRow(b)); }
    else { av = parseHHMM(a[key]); bv = parseHHMM(b[key]); }
    const aEmpty = av == null, bEmpty = bv == null;
    if (aEmpty && bEmpty) return 0;
    if (aEmpty) return 1;
    if (bEmpty) return -1;
    const cmp = av - bv;
    return dir === "desc" ? -cmp : cmp;
  }

  function locationGroupFor(locationKey) {
    if (locationKey === "buildingc") return ["atlanta"]; // shares Atlanta's pool
    return [locationKey];
  }
  export function driversForLocation(locationKey) {
    // Mondelez drivers aren't tagged via the single `location` field the other
    // boards use — they're tagged in runs_out_of instead (a driver can run
    // Mondelez alongside their normal home base), so this needs its own check.
    if (locationKey === "mondelez") {
      return state.drivers.filter((d) => Array.isArray(d.runsOutOf) && d.runsOutOf.includes("mondelez"));
    }
    // Houston works the same way as Mondelez now — a driver shows up here
    // if EITHER their primary location is houston OR the Houston box is
    // checked in runs_out_of, so checking the box is enough on its own
    // without needing to also flip their primary location (and risk
    // knocking them off whichever board that used to put them on).
    if (locationKey === "houston") {
      return state.drivers.filter((d) => d.location === "houston" || (Array.isArray(d.runsOutOf) && d.runsOutOf.includes("houston")));
    }
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
      returnEtaToDc: "", returnDropLocation: "", ppwkReceived: false, checkedIn: false, timesheetStartTime: "", timesheetEndTime: "", dropLocationText: "", returnToDcText: "",
      routeEstHours: "", timeToFinalStop: "", timeToDc: "", etaToFinalStop: "", estRouteComplete: "",
      hasStopTimes: false, // client-side only, not persisted -- computed from trip_stops presence, see ensureSheetLoaded / the Stop Times save flow
      routeImagePath: "", routeImageUrl: "", completedAt: null,
    };
  }
  function blankRow(driverId, driverNameText) {
    return {
      id: uid("row"), dbId: null, location: state.activeLocation || null, shiftDate: state.activeDate || null,
      driverId: driverId || null, driverNameText: driverNameText || "",
      proNumber: "", tonu: false, highlighted: false, shiftStart: "", shiftComplete: false, shiftCompleteAt: null, rate: "", notes: "", selected: false,
      preShiftTextSent: false, preShiftCall: false, etaShiftReport: "", actualShiftReport: "", revLevel: "",
      timesheetReceived: false, timesheetStartTime: "", timesheetEndTime: "", trailerDropLocation: "", preShiftTextSentAt: null,
      createdAt: null, updatedAt: null, addedAt: null, sentToAccounting: false,
      calledOff: false, calledOffReason: "", calledOffNotes: "", calledOffAt: null,
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
        // Which trips have REAL stop in/out times recorded -- used to flag
        // a completed-but-undocumented trip's pill red (see
        // routesChipsHtml). This has to check actual time_in/time_out
        // values, not just whether a trip_stops row exists at all -- the
        // save flow creates a row for every stop position as soon as a
        // stop count is set, even before any time gets typed into it, so
        // "row exists" alone would call an entirely blank trip "documented".
        const tripDbIds = tripRows.map((t) => t.id);
        let stopsByTripId = {};
        if (tripDbIds.length) {
          const { data: stopRows } = await supabaseClient.from("trip_stops").select("trip_id, time_in, time_out").in("trip_id", tripDbIds);
          (stopRows || []).forEach((sr) => { if (sr.time_in || sr.time_out) stopsByTripId[sr.trip_id] = true; });
        }
        rows.forEach((row, i) => {
          const dbId = shiftRows[i].id;
          const mine = tripRows.filter((t) => t.shift_id === dbId).sort((a, b) => a.trip_number - b.trip_number);
          row.trips = mine.map((t) => {
            const trip = tripFromDbRow(t);
            trip.hasStopTimes = !!stopsByTripId[t.id];
            return trip;
          });
          if (!row.trips.length || row.trips[row.trips.length - 1].minimized) row.trips.push(blankTrip());
        });
        // Every trip with an uploaded image needs a fresh signed URL each
        // load, since the bucket is private -- collect them all and sign
        // in one batch call rather than one request per trip.
        const imagePaths = [];
        const imageTargets = [];
        rows.forEach((row) => row.trips.forEach((t) => {
          if (t.routeImagePath) { imagePaths.push(t.routeImagePath); imageTargets.push(t); }
        }));
        await batchSignImageUrls(BOARD_IMAGE_BUCKET, imagePaths, imageTargets);
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

  // Same idea as findRowAnywhere, but for a trip specifically — needed
  // because saveTripNow wants the parent row and the trip's position
  // (1-based) alongside the trip itself, not just the trip in isolation.
  function findTripAnywhere(tripId) {
    for (const k in state.sheets) {
      for (const r of state.sheets[k]) {
        const idx = r.trips.findIndex((t) => t.id === tripId);
        if (idx !== -1) return { row: r, trip: r.trips[idx], tripNumber: idx + 1 };
      }
    }
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
  // ---------------- shared route-image upload/view/delete (all boards) ----------------
  // Generic across every board's row type — takes the row's own save and
  // render functions as callbacks rather than assuming any one board's
  // shape, since Atlanta/Delaware/Building C, Houston, and Mondelez each
  // have their own save/render pair.
  export async function uploadRowImage(row, file, saveRowFn, renderFn) {
    if (!supabaseClient) return;
    if (!row.dbId) await saveRowFn(row);
    if (!row.dbId) { setDriverSyncStatus("Couldn't save this load before uploading — try again.", "error"); return; }
    const path = `${row.dbId}/${Date.now()}_${file.name}`;
    try {
      const { error: upErr } = await supabaseClient.storage.from(BOARD_IMAGE_BUCKET).upload(path, file);
      if (upErr) throw upErr;
      row.routeImagePath = path;
      const { data: signed, error: signErr } = await supabaseClient.storage.from(BOARD_IMAGE_BUCKET).createSignedUrl(path, SIGNED_URL_EXPIRY_SECONDS);
      if (signErr) throw signErr;
      row.routeImageUrl = signed.signedUrl;
      await saveRowFn(row);
      renderFn();
    } catch (e) {
      console.error("uploadRowImage failed:", e);
      setDriverSyncStatus(`Couldn't upload that image (${e.message || e}).`, "error");
    }
  }

  export async function deleteRowImage(row, saveRowFn, renderFn) {
    if (!row.routeImageUrl) return;
    const oldPath = row.routeImagePath;
    row.routeImagePath = "";
    row.routeImageUrl = "";
    renderFn();
    try {
      if (oldPath && supabaseClient) {
        const { error } = await supabaseClient.storage.from(BOARD_IMAGE_BUCKET).remove([oldPath]);
        if (error) throw error;
      }
      await saveRowFn(row);
    } catch (e) {
      console.error("deleteRowImage failed:", e);
      setDriverSyncStatus(`Image removed here, but couldn't delete it from storage (${e.message || e}).`, "error");
    }
  }

  export function viewRowImage(row, label) {
    if (!row.routeImageUrl) return;
    const overlay = document.createElement("div");
    overlay.className = "overlay image-lightbox-overlay";
    overlay.id = "board-image-overlay";
    overlay.innerHTML = `
      <div class="modal image-lightbox-content">
        <div class="modal-header"><h3>Route — ${escapeHtml(label || "")}</h3><button class="modal-close" id="board-image-close">&times;</button></div>
        <div class="modal-body" style="text-align:center; padding:12px;"><img src="${escapeHtml(row.routeImageUrl)}" alt="Route image"></div>
        <div class="modal-footer"><button type="button" class="btn btn-ghost" id="board-image-delete" style="color:#b91c1c; border-color:#b91c1c;">Delete Image</button></div>
      </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    $("#board-image-close").addEventListener("click", close);
    document.addEventListener("keydown", function escHandler(e) {
      if (e.key === "Escape") { close(); document.removeEventListener("keydown", escHandler); }
    });
    return close; // caller wires the Delete button itself, since it needs board-specific save/render callbacks
  }

  // Shared HTML for the image dropzone cell — same markup/behavior on
  // every board, just parameterized by which row it belongs to.
  export function rowImageDropzoneHtml(row, rowIdAttr) {
    return `
      <div class="mdz-image-dropzone" tabindex="0" data-action="row-image-dropzone" data-row-image-id="${rowIdAttr}" title="Click to browse, or drag/paste an image here">
        ${row.routeImageUrl
          ? `<div class="mdz-thumb-wrap">
               <img src="${escapeHtml(row.routeImageUrl)}" class="mdz-route-thumb" data-action="view-row-image" data-row-image-id="${rowIdAttr}" alt="Route image" title="Click to view full size">
               <button type="button" class="mdz-thumb-delete" data-action="delete-row-image" data-row-image-id="${rowIdAttr}" title="Delete image">&times;</button>
             </div>`
          : `<span class="mdz-upload-hint">Drop / paste / click</span>`}
        <input type="file" accept="image/*" data-action="upload-row-image" data-row-image-id="${rowIdAttr}" class="mdz-hidden-file-input">
      </div>`;
  }

  // Shared wiring for the dropzone's click/drag/drop/paste/change behavior
  // — call once per table with a getRow(id) lookup and the board's own
  // save/render functions, and every dropzone cell in that table works.
  export function wireRowImageDropzone(table, getRowFn, saveRowFn, renderFn, labelFn) {
    table.addEventListener("click", (e) => {
      const viewBtn = e.target.closest("[data-action='view-row-image']");
      const deleteBtn = e.target.closest("[data-action='delete-row-image']");
      if (viewBtn) {
        const row = getRowFn(viewBtn.dataset.rowImageId);
        if (row) viewRowImage(row, labelFn ? labelFn(row) : "");
        const delHandler = (ev) => {
          if (ev.target.id === "board-image-delete") {
            const overlay = document.getElementById("board-image-overlay");
            if (overlay && confirm("Delete this route image? This can't be undone.")) {
              overlay.remove();
              if (row) deleteRowImage(row, saveRowFn, renderFn);
            }
          }
        };
        document.addEventListener("click", delHandler, { once: true });
        return;
      }
      if (deleteBtn) {
        const row = getRowFn(deleteBtn.dataset.rowImageId);
        if (row && confirm("Delete this route image? This can't be undone.")) deleteRowImage(row, saveRowFn, renderFn);
        return;
      }
      const dropzone = e.target.closest("[data-action='row-image-dropzone']");
      if (dropzone && !viewBtn && !deleteBtn) {
        const fileInput = dropzone.querySelector('input[type="file"]');
        if (fileInput) fileInput.click();
      }
    });
    table.addEventListener("change", (e) => {
      if (e.target.dataset.action === "upload-row-image" && e.target.files && e.target.files[0]) {
        const row = getRowFn(e.target.dataset.rowImageId);
        if (row) uploadRowImage(row, e.target.files[0], saveRowFn, renderFn);
      }
    });
    table.addEventListener("dragover", (e) => {
      const dropzone = e.target.closest("[data-action='row-image-dropzone']");
      if (!dropzone) return;
      e.preventDefault();
      dropzone.classList.add("mdz-dropzone-active");
    });
    table.addEventListener("dragleave", (e) => {
      const dropzone = e.target.closest("[data-action='row-image-dropzone']");
      if (dropzone) dropzone.classList.remove("mdz-dropzone-active");
    });
    table.addEventListener("drop", (e) => {
      const dropzone = e.target.closest("[data-action='row-image-dropzone']");
      if (!dropzone) return;
      e.preventDefault();
      dropzone.classList.remove("mdz-dropzone-active");
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      const row = getRowFn(dropzone.dataset.rowImageId);
      if (file && file.type.startsWith("image/") && row) uploadRowImage(row, file, saveRowFn, renderFn);
    });
    table.addEventListener("paste", (e) => {
      const dropzone = e.target.closest("[data-action='row-image-dropzone']");
      if (!dropzone) return;
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          e.preventDefault();
          const file = item.getAsFile();
          const row = getRowFn(dropzone.dataset.rowImageId);
          if (file && row) uploadRowImage(row, file, saveRowFn, renderFn);
          break;
        }
      }
    });
  }


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
    // Only a genuine CHANGE gets tracked — not the first time a value is
    // entered into a field that was previously blank. Filling in an empty
    // start time isn't a change; 15:00 -> 22:00 is. A boolean toggle's
    // "before" (the literal string "false") still counts as a real prior
    // value, so those keep logging correctly either way — this only
    // suppresses the case where there was genuinely nothing there yet.
    const oldIsBlank = oldValue === null || oldValue === undefined || String(oldValue).trim() === "";
    if (oldIsBlank) return;
    if (String(oldValue) === String(newValue)) return;
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

  const ROUTE_TYPE_LABELS = { birm: "BIRM", hostler: "Hostler", na: "N/A" };

  // Turns a raw Change History row into one plain-language sentence —
  // covers every field_name actually logged anywhere in the app. Falls
  // back to a readable-but-generic sentence for anything not explicitly
  // covered here, rather than showing nothing.
  // Shared phrasing for every "from X to Y" style entry. Handles a
  // genuinely blank old value gracefully (falls back to "set to Y"
  // instead of an awkward "changed from  to Y") — this path only
  // matters for entries logged before the blank-check fix went into
  // logChange(); nothing new can ever have a blank "from" going forward,
  // since logChange() skips logging that case entirely now.
  function fromToPhrase(label, ov, nv, prefix) {
    prefix = prefix || "";
    const boldNv = `<strong>${prefix}${escapeHtml(nv)}</strong>`;
    if (!ov) return `${label} set to ${boldNv}`;
    return `${label} changed from ${prefix}${escapeHtml(ov)} to ${boldNv}`;
  }

  // Returns a small HTML string (not plain text) — the changed value
  // itself is wrapped in <strong> so it stands out from the surrounding
  // description. Every dynamic value gets escaped individually here,
  // since the caller no longer escapes the whole result (that would
  // strip the bold tags right back out).
  function formatChangeHistoryEntry(fieldName, oldValue, newValue) {
    const nv = newValue == null ? "" : String(newValue);
    const ov = oldValue == null ? "" : String(oldValue);
    switch (fieldName) {
      case "ppwk_received": return nv === "true" ? "Paperwork received" : "Paperwork marked not received";
      case "route_complete": return nv === "true" ? "Route marked complete" : "Route marked incomplete";
      case "tonu": return nv === "true" ? "Marked TONU" : "TONU removed";
      case "shift_complete": return nv === "true" ? "Shift marked complete" : "Shift marked incomplete";
      case "called_off": return nv === "true" ? "Marked as cancellation" : "Cancellation removed";
      case "timesheet_received": return "Time sheet received";
      case "pre_shift_text_sent": return "Pre-shift text sent";
      case "deleted": return "Load deleted";
      case "route_deleted": return "Route deleted";
      case "route_type": return `Route type changed to <strong>${escapeHtml(ROUTE_TYPE_LABELS[nv] || nv)}</strong>`;
      case "hostler_hours": return fromToPhrase("Hostler hours", ov, nv);
      case "carrier_rate_manual":
      case "rate": return fromToPhrase("Carrier rate", ov, nv, "$");
      case "route_id": return fromToPhrase("Route ID", ov, nv || "(blank)");
      case "trailer_out": return fromToPhrase("Trailer #", ov, nv || "(blank)");
      case "driver_reassigned": return ov ? `Driver changed from ${escapeHtml(ov)} to <strong>${escapeHtml(nv)}</strong>` : `Driver assigned: <strong>${escapeHtml(nv)}</strong>`;
      case "driver_id": {
        // Older entries logged the raw numeric driver id directly rather
        // than a name — resolve both sides to real names at display
        // time so this reads correctly no matter how long ago it was logged.
        const newDrv = findDriver(nv);
        const newName = newDrv ? newDrv.name : `driver #${nv}`;
        if (!ov) return `Driver assigned: <strong>${escapeHtml(newName)}</strong>`;
        const oldDrv = findDriver(ov);
        const oldName = oldDrv ? oldDrv.name : `driver #${ov}`;
        return `Driver changed from ${escapeHtml(oldName)} to <strong>${escapeHtml(newName)}</strong>`;
      }
      default:
        if (fieldName.startsWith("rate_override_")) return fromToPhrase("Rate override", ov, nv, "$");
        // Generic fallback so a future field_name that's added later
        // without a hand-written sentence here still reads reasonably.
        return fromToPhrase(fieldName.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()), ov, nv);
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
    const trip = found.row.trips.find((t) => t.id === tripId);
    if (!trip) return;
    // Opens straight into Load Details on this trip's tab rather than
    // un-minimizing it back onto the active row — matches what the pill's
    // own tooltip already promises ("click to fix" / "click to view").
    await openLoadDetailsModal(rowId, tripId);
    if (tripMissingFields(trip, found.row.location).length) startLoadDetailsEdit(tripId);
  }

  function addNewTrip(rowId) {
    const found = findRowAnywhere(rowId);
    if (!found) return;
    found.row.trips.push(blankTrip());
    renderBoardTable();
  }

  async function completeTrip(rowId, tripId) {
    const found = findRowAnywhere(rowId);
    if (!found) return;
    const trip = found.row.trips.find((t) => t.id === tripId);
    if (!trip || !String(trip.routeId || "").trim()) return;
    await openLoadDetailsModal(rowId, tripId);
    startLoadDetailsEdit(tripId);
  }

  let stopTimesModalState = null; // { rowId, tripId, stopCount }

  async function openStopTimesModal(rowId, tripId) {
    const found = findRowAnywhere(rowId);
    if (!found) return;
    const trip = found.row.trips.find((t) => t.id === tripId);
    if (!trip || !$("#modal-stop-times")) return;
    const stopCount = Math.max(0, parseInt(trip.stopCount, 10) || 0);
    let existingStops = [];
    let existingAttachments = [];
    if (trip.dbId && supabaseClient) {
      const [stopsResult, attachResult] = await Promise.all([
        supabaseClient.from("trip_stops").select("*").eq("trip_id", trip.dbId),
        found.row.dbId ? supabaseClient.from("load_attachments").select("*").eq("shift_id", found.row.dbId) : Promise.resolve({ data: [] }),
      ]);
      existingStops = (stopsResult.data || []).sort((a, b) => a.stop_number - b.stop_number)
        .map((s) => ({ dbId: s.id, stopNumber: s.stop_number, timeIn: s.time_in || "", timeOut: s.time_out || "" }));
      existingAttachments = attachResult.data || [];
    }
    stopTimesModalState = { rowId, tripId, stopCount, existingStops };
    const dispatchInfoEl = $("#st-dispatch-info");
    if (dispatchInfoEl) dispatchInfoEl.textContent = trip.dispatchTime ? `Dispatch Time: ${trip.dispatchTime}` : "";
    $("#st-stop-fields").innerHTML = stopCount
      ? stopFieldsHtml(stopCount, existingStops)
      : `<div class="subtext">No stop count set on this trip — nothing to fill in, but you can still confirm or skip.</div>`;
    const returnInfoEl = $("#st-return-info");
    if (returnInfoEl) {
      const returnTime = trip.returnEtaToDc || trip.returnToDC || "";
      const parts = [];
      if (returnTime) parts.push(`Return to DC: ${returnTime}`);
      if (trip.tripId) parts.push(`Trip ID: ${trip.tripId}`);
      if (trip.trailerOut) parts.push(`Trailer Out: ${trip.trailerOut}`);
      if (trip.backhaulTrailerNumber) parts.push(`B/Haul Trailer #: ${trip.backhaulTrailerNumber}`);
      returnInfoEl.textContent = parts.join("   ·   ");
    }
    const ppwkCheckbox = $("#st-ppwk-received");
    if (ppwkCheckbox) ppwkCheckbox.checked = !!trip.ppwkReceived;
    const checkedInCheckbox = $("#st-checked-in");
    if (checkedInCheckbox) checkedInCheckbox.checked = !!trip.checkedIn;
    const uploadInput = $("#st-ppwk-upload");
    if (uploadInput) uploadInput.value = "";
    const dropLocationInput = $("#st-trailer-drop-location");
    if (dropLocationInput) dropLocationInput.value = trip.returnDropLocation || "";
    const imageSlot = $("#st-image-slot");
    if (imageSlot) imageSlot.innerHTML = rowImageDropzoneHtml(trip, trip.id);
    const statusEl = $("#st-upload-status");
    if (statusEl) {
      statusEl.textContent = existingAttachments.length ? "Already on file: " : "";
      if (existingAttachments.length && supabaseClient) {
        const paths = existingAttachments.map((a) => a.file_path);
        const { data: signedList } = await supabaseClient.storage.from("trip-sheets").createSignedUrls(paths, 3600);
        (signedList || []).forEach((entry, i) => {
          const a = document.createElement("a");
          a.href = entry.signedUrl || "#";
          a.target = "_blank";
          a.rel = "noopener";
          a.textContent = existingAttachments[i].file_name;
          a.style.marginRight = "8px";
          statusEl.appendChild(a);
        });
      }
    }
    $("#modal-stop-times").classList.remove("hidden");
  }

  function closeStopTimesModal() {
    if ($("#modal-stop-times")) $("#modal-stop-times").classList.add("hidden");
    stopTimesModalState = null;
  }

  async function uploadPaperworkImage(file) {
    if (!stopTimesModalState || !supabaseClient) return;
    const found = findRowAnywhere(stopTimesModalState.rowId);
    if (!found) return;
    const row = found.row;
    if (!row.dbId) { setDriverSyncStatus("Save this load first (enter a driver or PRO#) before uploading paperwork.", "error"); return; }
    const statusEl = $("#st-upload-status");
    if (statusEl) statusEl.textContent = "Uploading…";
    const path = `${row.dbId}/${Date.now()}_${file.name}`;
    try {
      const { error: upErr } = await supabaseClient.storage.from("trip-sheets").upload(path, file);
      if (upErr) throw upErr;
      const { error: insErr } = await supabaseClient.from("load_attachments").insert({ shift_id: row.dbId, file_path: path, file_name: file.name });
      if (insErr) throw insErr;
      if (statusEl) statusEl.textContent = `Uploaded: ${file.name}`;
    } catch (e) {
      console.error("uploadPaperworkImage failed:", e);
      if (statusEl) statusEl.textContent = "";
      setDriverSyncStatus(`Couldn't upload that image (${e.message || e}).`, "error");
    }
  }

  async function finalizeTripCompletion(saveStopTimes) {
    if (!stopTimesModalState) return;
    const { rowId, tripId, stopCount, existingStops } = stopTimesModalState;
    const found = findRowAnywhere(rowId);
    if (!found) { closeStopTimesModal(); return; }
    const row = found.row;
    const trip = row.trips.find((t) => t.id === tripId);
    if (!trip) { closeStopTimesModal(); return; }

    if (saveStopTimes && stopCount > 0 && supabaseClient && trip.dbId) {
      trip.hasStopTimes = false;
      for (let i = 0; i < stopCount; i++) {
        const timeInEl = document.querySelector(`#modal-stop-times [data-stop-field="timeIn"][data-stop-index="${i}"]`);
        const timeOutEl = document.querySelector(`#modal-stop-times [data-stop-field="timeOut"][data-stop-index="${i}"]`);
        const timeIn = timeInEl ? timeInEl.value.trim() : "";
        const timeOut = timeOutEl ? timeOutEl.value.trim() : "";
        const existing = (existingStops || []).find((s) => s.stopNumber === i + 1);
        if (!timeIn && !timeOut && !existing) continue; // nothing entered and no prior record — don't create an empty one
        try {
          const payload = { trip_id: trip.dbId, stop_number: i + 1, time_in: timeIn || null, time_out: timeOut || null };
          if (existing && existing.dbId) {
            await supabaseClient.from("trip_stops").update(payload).eq("id", existing.dbId);
          } else {
            await supabaseClient.from("trip_stops").insert(payload);
          }
          if (timeIn || timeOut) trip.hasStopTimes = true; // at least one real stop record now exists — clears the red pill once paperwork's also in
        } catch (e) {
          console.error("Saving stop time failed:", e);
        }
      }
    }

    const ppwkCheckbox = $("#st-ppwk-received");
    if (ppwkCheckbox) {
      const beforePpwk = trip.ppwkReceived;
      trip.ppwkReceived = ppwkCheckbox.checked;
      if (beforePpwk !== trip.ppwkReceived) {
        logChange(row.dbId, `${labelForRow(row)} — ${trip.routeId || trip.tripId || "route"}`, "ppwk_received", beforePpwk, trip.ppwkReceived);
      }
    }
    const checkedInCheckbox = $("#st-checked-in");
    if (checkedInCheckbox) trip.checkedIn = checkedInCheckbox.checked;
    const dropLocationInput = $("#st-trailer-drop-location");
    if (dropLocationInput) trip.returnDropLocation = dropLocationInput.value.trim();

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
  // Same idea as alerts.js's minsSinceMidnightNow, but for an arbitrary
  // timestamp instead of always "now" -- needed to compare a trip's
  // completedAt against its returnEtaToDc on the same Atlanta-local clock.
  function minsSinceMidnightAtlanta(isoString) {
    if (!isoString) return null;
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", hour: "numeric", minute: "numeric", hour12: false,
    }).formatToParts(new Date(isoString));
    const hour = Number(parts.find((p) => p.type === "hour").value) % 24;
    const minute = Number(parts.find((p) => p.type === "minute").value);
    return hour * 60 + minute;
  }

  // A driver is "at the DC" once every trip on the shift is closed out and
  // the shift itself isn't complete yet -- the pause between routes. The
  // reference time is whichever is later: the ETA they actually provided,
  // or the moment the last trip got marked complete (covers the case
  // where nobody gave an ETA at all, or showed up earlier than promised).
  function atDcSinceMinForRow(row) {
    const hasRealTrip = row.trips.some((t) => (t.routeId || "").trim() || (t.tripId || "").trim());
    if (row.shiftComplete || !hasRealTrip) return null;
    const allDone = row.trips.every((t) => t.minimized || !String(t.routeId || t.tripId || "").trim());
    if (!allDone) return null;
    const lastReal = [...row.trips].reverse().find((t) => String(t.routeId || t.tripId || "").trim());
    if (!lastReal) return null;
    const etaMin = parseHHMM(lastReal.returnEtaToDc);
    const completedMin = minsSinceMidnightAtlanta(lastReal.completedAt);
    if (etaMin == null && completedMin == null) return null;
    if (etaMin == null) return completedMin;
    if (completedMin == null) return etaMin;
    return Math.max(etaMin, completedMin);
  }

  function computeNextCallTimeForRow(row) {
    if (row.shiftComplete) return "";
    const atDcMin = atDcSinceMinForRow(row);
    if (atDcMin != null) return minsToClock(atDcMin);
    const candidates = [];
    const shiftStartMin = parseHHMM(row.shiftStart);
    const hasRealTrip = row.trips.some((t) => (t.routeId || "").trim() || (t.tripId || "").trim());
    const hasEta = !!(row.etaShiftReport || "").trim();

    // Stages 1-3: pre-shift ETA cascade -- gated on the ETA being blank AND
    // the driver not already having a real dispatched trip. A dispatched
    // trip is proof they showed up, even if nobody filled in the ETA field
    // itself, so tracking moves on instead of continuing to ask.
    if (shiftStartMin != null && !hasEta && !hasRealTrip) {
      candidates.push(shiftStartMin - PRE_SHIFT_TEXT_LEAD_MIN);
      candidates.push(shiftStartMin - PRE_SHIFT_CALL_FOLLOWUP_MIN);
      candidates.push(shiftStartMin - PRE_SHIFT_ESCALATION_MIN);
    }

    // Stage 4: dispatch check, only once the ETA is actually confirmed
    if (shiftStartMin != null && !hasRealTrip && hasEta) {
      candidates.push(shiftStartMin + IDLE_THRESHOLD_MIN);
    }

    // Stages 5-6: per active dispatched trip that isn't superseded by a
    // later one. Stage 5 (Last Stop Depart, asking for a return ETA) only
    // applies while Return ETA to DC is still blank; Stage 6 (paperwork /
    // drop-spot) only applies once we actually have that return ETA.
    row.trips.forEach((t, idx) => {
      if (t.minimized || t.complete || !String(t.routeId || t.tripId || "").trim()) return;
      const laterDispatched = row.trips.some((t2, idx2) => idx2 > idx && String(t2.routeId || t2.tripId || "").trim());
      if (laterDispatched) return;
      const lastStopMin = parseHHMM(t.lastStopDepart);
      const returnEtaMin = parseHHMM(t.returnEtaToDc);
      if (lastStopMin != null && returnEtaMin == null) candidates.push(lastStopMin);
      else if (returnEtaMin != null) candidates.push(returnEtaMin);
    });

    if (!candidates.length) return "";
    return minsToClock(Math.min(...candidates));
  }

  // Display version of the above — same value, sortable Next Call Time
  // stays a plain clock string for parseHHMM, but what actually shows in
  // the cell gets the "At DC since:" label when that's the situation.
  function nextCallTimeDisplayForRow(row) {
    if (row.shiftComplete) return "Complete";
    const atDcMin = atDcSinceMinForRow(row);
    if (atDcMin != null) return `At DC since: ${minsToClock(atDcMin)}`;
    return computeNextCallTimeForRow(row);
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

  // Priority for what a load's rate actually is: (1) a manual override
  // typed directly on this load — highest priority, most specific intent
  // wins; (2) for Atlanta, the assigned driver's own tier/setting rate
  // card, if any of those boxes are filled in on their profile — some
  // drivers run a negotiated structure instead of one flat number, so
  // this lets calcLoadRateBreakdown() apply it tier-by-tier via
  // effectiveTierRate()/effectiveSetting() in boardrates.js; (3) the
  // driver's flat usual rate, for locations where a single number is the
  // right shape (or as a fallback if an Atlanta driver has a flat rate
  // but no tier boxes filled in); (4) the location's calculated
  // tier/flat engine. This is the one place that priority gets decided,
  // so recomputeRowRate() and the Rate panel's live breakdown can't
  // drift from each other.
  function getEffectiveRateInfo(row) {
    const locationKey = row.location || state.activeLocation || "atlanta";
    const drv = row.driverId ? findDriver(row.driverId) : null;
    const driverOv = drv && drv.atlantaRateOverrides;
    const hasAtlantaOverrides = driverOv && (Object.keys(driverOv.tiers || {}).length || Object.keys(driverOv.settings || {}).length);
    if (locationKey === "atlanta" && hasAtlantaOverrides) {
      return calcLoadRateBreakdown(locationKey, row); // picks up the driver's tier/setting overrides itself
    }
    if (drv && drv.normalRate) {
      const amount = Number(drv.normalRate);
      return {
        total: amount, mode: "driver-usual-rate",
        lines: [{ label: "Driver's usual rate", detail: drv.name, amount }],
        note: null,
      };
    }
    return calcLoadRateBreakdown(locationKey, row);
  }

  // Recomputes the Rate column from getEffectiveRateInfo() above and
  // writes it into row.rate — unless the dispatcher has typed a manual
  // override into that field, in which case this is a no-op so we never
  // silently clobber what they typed. Updates the live DOM cell in place
  // when present, rather than forcing a full board redraw.
  function recomputeRowRate(row) {
    if (row.rateManual) return;
    const breakdown = getEffectiveRateInfo(row);
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
    if (open.length) return open;
    // Every trip is minimized/collapsed — rather than showing nothing
    // (which would leave no way to add another route), start a genuinely
    // new blank one. This is a real, not-minimized trip, unlike the old
    // behavior that just displayed a completed trip as if it were open.
    const fresh = blankTrip();
    row.trips.push(fresh);
    return [fresh];
  }

  // What a trip needs before it's genuinely "done" — shared by the board
  // pill (routesChipsHtml) and the Load Details trip tab's banner/field
  // highlighting, so the two can never disagree about what's missing.
  function tripMissingFields(trip, locationKey) {
    const missing = [];
    if (locationKey === "delaware") {
      // Delaware collects trip info after the fact rather than tracking
      // it live during the shift — paperwork confirmation, stop times,
      // check-in, and drop location genuinely don't apply the way they
      // do for Atlanta or Building C. Only the image is actually required.
      if (!trip.routeImagePath) missing.push({ key: "image", label: "an image" });
      return missing;
    }
    if (!trip.ppwkReceived) missing.push({ key: "ppwk", label: "paperwork confirmation" });
    if (!trip.hasStopTimes) missing.push({ key: "stops", label: "stop times" });
    if (!trip.routeImagePath) missing.push({ key: "image", label: "an image" });
    if (!String(trip.returnDropLocation || "").trim()) missing.push({ key: "dropLocation", label: "a drop location" });
    if (!trip.checkedIn) missing.push({ key: "checkedIn", label: "load checked in" });
    return missing;
  }

  function routesChipsHtml(row) {
    // A minimized trip only counts as a "route" worth showing here if it
    // actually has a Route ID or Trip ID — an empty trip that got
    // collapsed (nothing entered, or collapsed by mistake) shouldn't
    // leave a meaningless placeholder chip behind. This column is
    // exclusively for routes that have been completed or minimized with
    // real data on them — nothing else belongs here.
    const done = row.trips.filter((t) => t.minimized && (String(t.routeId || "").trim() || String(t.tripId || "").trim()));
    return done.length
      ? done.map((t) => {
          const missing = tripMissingFields(t, row.location).map((m) => m.label);
          const undocumented = t.complete && missing.length > 0;
          const statusCls = [t.complete ? "trip-segment-done" : "", undocumented ? "trip-chip-undocumented" : ""].filter(Boolean).join(" ");
          const title = undocumented
            ? `Closed out but missing: ${missing.join(", ")} — click to fix`
            : (t.complete ? "Closed out — click to view" : "Click to view or edit");
          return `<button type="button" class="trip-chip ${statusCls}" data-action="restore-trip" data-row="${row.id}" data-trip="${t.id}" title="${title}">${escapeHtml(t.routeId || t.tripId)}</button>`;
        }).join(" ")
      : `<span class="subtext" style="font-size:11px;">—</span>`;
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
      if (col.type === "image") {
        return `<td class="col-${col.key}${pistachioCls}">${rowImageDropzoneHtml(trip, trip.id)}</td>`;
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
        <button type="button" class="tc-btn" data-action="delete-trip" data-row="${row.id}" data-trip="${trip.id}" title="Delete this route" style="color: var(--red-600, #dc2626);">&times;</button>
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
    const allTripsDocumented = row.trips.every((t) => !t.complete || tripMissingFields(t, row.location).length === 0);
    const fullyDocumented = row.shiftComplete && allTripsDocumented;
    return `
      <td class="pin pin-select"${rs}>
        <input type="checkbox" class="chk" data-action="toggle-row-select" data-row="${row.id}" ${row.selected ? "checked" : ""} title="Select">
      </td>
      <td class="pin pin-text"${rs}>
        <button class="text-btn" data-action="text-driver" data-row="${row.id}" title="Text this driver">Text</button>
      </td>
      <td class="col-email"${rs}><span class="static-text">${escapeHtml(pick(drv && drv.email, row.emailSnapshot))}</span></td>
      <td class="col-dispatcherPhone"${rs}><span class="static-text">${escapeHtml(pick(drv && drv.dispatcherPhone, row.dispatcherPhoneSnapshot))}</span></td>
      <td class="pin pin-pro${row.shiftComplete ? " shift-complete-tint" : ""}${fullyDocumented ? " pro-fully-documented" : ""}"${rs} title="${fullyDocumented ? "All trips documented and time sheet complete" : ""}">
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
          <input class="cell-input" data-driver-ac="true" placeholder="Type driver name…"
            data-row="${row.id}" data-field="driverName" value="${escapeHtml(displayName)}">
          ${row.calledOff ? `<span title="${escapeHtml(row.calledOffNotes || "")}" style="display:inline-block; margin-left:4px; padding:1px 6px; border-radius:4px; background:#dc2626; color:#fff; font-size:10px; font-weight:700; white-space:nowrap; vertical-align:middle;">CANCELLED</span>` : ""}
        </div>
      </td>
        <td class="col-rate"${rs}>
          <input class="cell-input small" style="width:46px;" placeholder="Rate" data-row="${row.id}" data-field="rate" value="${escapeHtml(row.rate)}">
      </td>
      <td class="col-cell"${rs}><span class="static-text">${escapeHtml(pick(drv && drv.phone, row.cellSnapshot))}</span></td>
      <td class="col-shiftStart"${rs}><input class="cell-input small" style="width:46px;" placeholder="--:--" data-row="${row.id}" data-field="shiftStart" value="${escapeHtml(row.shiftStart)}"></td>
      <td class="col-etaShiftReport"${rs}><input class="cell-input small" style="width:46px;" placeholder="--:--" data-row="${row.id}" data-field="etaShiftReport" value="${escapeHtml(row.etaShiftReport)}"></td>
      <td class="col-shiftHosLeft"${rs}><input class="cell-input calc" data-row="${row.id}" data-field="shiftHosLeft" value="${escapeHtml(computeShiftLevelHosLeft(row))}" readonly tabindex="-1"></td>
      <td class="col-nextCallTimeCalc"${rs}><input class="cell-input calc" data-row="${row.id}" data-field="nextCallTimeCalc" value="${escapeHtml(nextCallTimeDisplayForRow(row))}" readonly tabindex="-1"></td>
      <td class="col-revLevel"${rs}><input class="cell-input small" style="width:42px;" placeholder="Rev" data-row="${row.id}" data-field="revLevel" value="${escapeHtml(row.revLevel)}"></td>
      ${row.location === "buildingc" ? `
      <td class="col-birm"${rs}>
          <select class="cell-input small" data-action="change-route-type" data-row="${row.id}">
            <option value="birm" ${row.routeType === "birm" ? "selected" : ""}>BIRM</option>
            <option value="hostler" ${row.routeType === "hostler" ? "selected" : ""}>Hostler</option>
            <option value="na" ${row.routeType === "na" ? "selected" : ""}>N/A</option>
          </select>
      </td>` : ""}
      <td class="col-notes"${rs}><input class="cell-input" placeholder="Notes" data-row="${row.id}" data-field="notes" value="${escapeHtml(row.notes)}"></td>
      <td class="col-routes" style="white-space:normal;"${rs}>${routesChipsHtml(row)}</td>`;
  }

  function rowsToHtml(row) {
    const open = openTripsFor(row);
    const rowClasses = [
      row.tonu ? "is-tonu" : "",
      row.calledOff ? "is-called-off" : "",
      row.highlighted ? "is-row-pinned" : "",
      row.selected ? "is-row-selected" : "",
      row.addedAt ? "is-new" : "",
    ].join(" ");
    if (!open.length) {
      // Every trip is minimized — still need exactly one <tr> so the
      // shift-level info (PRO#, driver, etc.) has somewhere to render;
      // the trip-specific columns just stay blank rather than forcing a
      // completed trip to display as if it were still open.
      const shiftCells = shiftInfoCellsHtml(row, 1);
      const blankTripCells = getOrderedTripSubcols().map((col) => `<td class="col-${col.key}${col.pistachio ? " col-pistachio" : ""}"></td>`).join("") + `<td class="col-trip-actions"></td>`;
      return `<tr id="${row.id}" class="${rowClasses}">${shiftCells}${blankTripCells}</tr>`;
    }
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
    const sortKey = state.boardSort.key;
    const displayRows = [...rows].sort((a, b) => {
      const completeDiff = (a.shiftComplete ? 1 : 0) - (b.shiftComplete ? 1 : 0); // completed shifts always sink to the bottom
      if (completeDiff !== 0) return completeDiff;
      if (!sortKey) return 0;
      return compareRowsForSort(a, b, sortKey, state.boardSort.dir);
    });
    const tripHeaderCells = getOrderedTripSubcols().map((c) => {
      const pistachioCls = c.pistachio ? " col-pistachio" : "";
      return `<th class="col-${c.key}${pistachioCls} col-draggable" draggable="true" data-col-key="${c.key}" title="Drag to reorder">${c.label}</th>`;
    }).join("");
    const thead = `<thead>
      <tr>
        <th class="pin pin-select"><div id="board-select-count" class="board-select-count"></div><input type="checkbox" class="chk" id="select-all-rows" title="Select all"></th>
        <th class="pin pin-text"></th>
        <th class="col-email">Email</th>
        <th class="col-dispatcherPhone">Dispatcher Phone</th>
        <th class="pin pin-pro">PRO#</th>
        <th class="col-shiftDate">Date</th>
        <th class="col-mc">MC #</th>
        <th class="col-rating">Rating</th>
        <th class="col-driverPreference">Driver Preference</th>
        <th class="pin pin-driver board-sortable" data-board-sort="driverName">Driver<span class="sort-arrow"></span></th>
        <th class="col-rate">Rate</th>
        <th class="col-cell">Cell</th>
        <th class="col-shiftStart board-sortable" data-board-sort="shiftStart">Shift Start<span class="sort-arrow"></span></th>
        <th class="col-etaShiftReport board-sortable" data-board-sort="etaShiftReport">ETA<span class="sort-arrow"></span></th>
        <th class="col-shiftHosLeft">HOS Left</th>
        <th class="col-nextCallTimeCalc board-sortable" data-board-sort="nextCallTimeCalc">Next Call Time<span class="sort-arrow"></span></th>
        <th class="col-revLevel">Rev Level</th>
        ${state.activeLocation === "buildingc" ? `<th class="col-birm" title="Building C only">Route</th>` : ""}
        <th class="col-notes">Notes</th>
        <th class="col-routes">Routes</th>
        ${tripHeaderCells}
        <th class="col-trip-actions"></th>
      </tr>
    </thead>`;
    const totalCols = 20 + getOrderedTripSubcols().length + 1 + (state.activeLocation === "buildingc" ? 1 : 0);
    const addRowHtml = `<tr class="quick-add-row"><td colspan="${totalCols}">
      <button type="button" class="quick-add-btn" id="btn-quick-add-row"><span class="quick-add-btn-label">+ Add Row</span></button>
      <button type="button" class="quick-add-btn quick-add-btn-secondary" id="btn-add-time-slots"><span class="quick-add-btn-label">+ Add Time Slots</span></button>
    </td></tr>`;
    const tbody = `<tbody>${displayRows.map(rowsToHtml).join("")}${addRowHtml}</tbody>`;

    $("#board-table").innerHTML = thead + tbody;
    const emptyState = $("#board-empty-state");
    if (emptyState) emptyState.classList.toggle("hidden", rows.length > 0);
    refreshDriverDatalist();
    updateBulkActionButtonsVisibility();
    updateBoardSelectCount();
    $all("th[data-board-sort]").forEach((th) => {
      const arrow = th.querySelector(".sort-arrow");
      if (!arrow) return;
      arrow.textContent = state.boardSort.key === th.dataset.boardSort ? (state.boardSort.dir === "asc" ? " ▲" : " ▼") : "";
    });
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
    if (nextCallEl) nextCallEl.value = nextCallTimeDisplayForRow(row);
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

  // Realtime updates (including echoes of the user's own save) sometimes have
  // to fall back to a full table re-render — which replaces every row's DOM
  // nodes, including whichever one the user is currently typing in. A fresh
  // node with the same value isn't the same element, so the browser doesn't
  // keep it focused, and the user gets silently kicked out of the field
  // mid-sentence. Call this right before a re-render that might do that;
  // it hands back a function that re-focuses (and restores cursor position
  // in) the equivalent field afterward, if there was one to restore.
  export function captureFocusForRerender() {
    const el = document.activeElement;
    if (!el || !("value" in el)) return () => {};
    const ds = el.dataset || {};
    let selector = null;
    if (ds.row && ds.field) selector = `[data-row="${ds.row}"][data-field="${ds.field}"]`;
    else if (ds.mdzRow && ds.mdzField) selector = `[data-mdz-row="${ds.mdzRow}"][data-mdz-field="${ds.mdzField}"]`;
    else if (ds.availRow) selector = `[data-avail-row="${ds.availRow}"]`;
    else if (el.id) selector = `#${el.id}`;
    if (!selector) return () => {};
    const selStart = typeof el.selectionStart === "number" ? el.selectionStart : null;
    const selEnd = typeof el.selectionEnd === "number" ? el.selectionEnd : null;
    return () => {
      const fresh = document.querySelector(selector);
      if (!fresh) return;
      fresh.focus();
      if (selStart != null && fresh.setSelectionRange) {
        try { fresh.setSelectionRange(selStart, selEnd); } catch (e) { /* not a text-selectable input type */ }
      }
    };
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
      const restoreFocus = captureFocusForRerender();
      renderBoardTable(); // a whole new row appeared — simplest to redraw
      restoreFocus();
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
      const restoreFocus = captureFocusForRerender();
      renderBoardTable(); // needs to move to the top/bottom — a single-row rebuild can't reposition it
      restoreFocus();
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
    const preservedHasStopTimes = localTrip.hasStopTimes;
    const preservedImagePath = localTrip.routeImagePath;
    const preservedImageUrl = localTrip.routeImageUrl;
    const fresh = tripFromDbRow(dbTrip);
    Object.assign(localTrip, fresh, { id: localTrip.id });
    if (domField) localTrip[domField] = preserved;
    // tripFromDbRow always resets these two to defaults (false / "") since
    // neither is a real column -- hasStopTimes is computed separately from
    // trip_stops, and routeImageUrl has to be freshly signed, not just read
    // off the row. An unrelated field changing elsewhere on this trip
    // shouldn't silently undo either one.
    localTrip.hasStopTimes = preservedHasStopTimes;
    if (localTrip.routeImagePath === preservedImagePath) localTrip.routeImageUrl = preservedImageUrl;
    recalcRowCalcCellsInPlace(parentRow.id);
  }

  // Handles inserts, updates, AND deletes for atlanta_drivers — deletes
  // used to be silently ignored here (`if (payload.eventType === "DELETE")
  // return;`), so removing a driver on one device never removed them from
  // anyone else's state.drivers until they refreshed. Deletes carry the
  // old row in payload.old (Supabase never sends payload.new for a DELETE),
  // so that's what has to be matched against instead.
  export function handleRealtimeDriverChange(payload) {
    if (payload.eventType === "DELETE") {
      const oldDriver = payload.old;
      if (!oldDriver) return;
      const idx = state.drivers.findIndex((d) => String(d.id) === String(oldDriver.id));
      if (idx !== -1) state.drivers.splice(idx, 1);
      refreshDriverDatalist();
      if (currentFile() === "driverlist.html") renderDriverList();
      else if (state.activeLocation) {
        const restoreFocus = captureFocusForRerender();
        renderBoardTable(); // a deleted driver may still be showing on a row elsewhere
        restoreFocus();
      }
      return;
    }
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
    else if (state.activeLocation) {
      const restoreFocus = captureFocusForRerender();
      renderBoardTable(); // driver-linked display cells may need refreshing
      restoreFocus();
    }
  }

  // Reused for both postgres_changes sync and the "someone's typing here"
  // broadcast below — one channel per location, not two.
  let boardChannel = null;
  const editingSessionId = uid("session"); // distinguishes our own broadcasts from other tabs' so we don't highlight our own row

  function setupRealtimeSync(locationKey) {
    if (!supabaseClient) return;
    const channel = supabaseClient.channel(`board-${locationKey}`);
    channel.on("postgres_changes", { event: "*", schema: "public", table: "loads_shifts", filter: `location=eq.${locationKey}` }, handleRealtimeShiftChange);
    channel.on("postgres_changes", { event: "*", schema: "public", table: "loads_trips" }, handleRealtimeTripChange);
    channel.on("postgres_changes", { event: "*", schema: "public", table: "atlanta_drivers" }, handleRealtimeDriverChange);
    channel.on("broadcast", { event: "row-editing" }, ({ payload }) => handleRemoteRowEditing(payload));
    channel.subscribe((status, err) => {
      if (status === "SUBSCRIBED") {
        console.log(`Realtime connected for board-${locationKey}`);
        setDriverSyncStatus(""); // clears any earlier "not connected" banner now that it's back
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        console.error(`Realtime subscription problem for board-${locationKey}:`, status, err);
        setDriverSyncStatus("Live updates aren't connected right now — you may need to refresh to see changes from other dispatchers.", "error");
      }
    });
    boardChannel = channel;
  }

  function setupDriverListRealtimeSync() {
    if (!supabaseClient) return;
    const channel = supabaseClient.channel("driverlist");
    channel.on("postgres_changes", { event: "*", schema: "public", table: "atlanta_drivers" }, handleRealtimeDriverChange);
    channel.subscribe();
  }

  /* ---------------- live "someone's typing here" row highlight ----------------
     Ephemeral broadcast, not stored anywhere — a row highlights for every
     other dispatcher on the same board while anyone has a field in it
     focused, and un-highlights shortly after they leave. A repeating
     ping while focus stays in the row means a dropped "stopped editing"
     event (tab closed, network hiccup) can't leave a row stuck
     highlighted forever — the receiving side times it out on its own.

     Broadcasts the row's real database id (dbId), not the local DOM id —
     each browser session generates its own local ids independently
     (uid("row") just counts up from 1000 fresh every load), so the same
     database row can easily have completely different local ids on two
     different devices. Broadcasting the local id meant the other side's
     document.getElementById() could never find a match — this never
     actually worked across devices, only within a single tab. dbId is
     the one identifier both sides actually share. */
  let editingRowId = null; // this session's own local DOM id for whichever row it's editing
  let editingPingInterval = null;
  const remoteEditingTimeouts = new Map(); // dbId -> timeout handle

  // Same lookup shape as findRowAnywhere, but by database id instead of
  // local DOM id — needed to translate an incoming broadcast's dbId back
  // into whatever local row/DOM element this session happens to have it under.
  function findRowByDbId(dbId) {
    for (const k in state.sheets) {
      const r = state.sheets[k].find((x) => x.dbId === dbId);
      if (r) return r;
    }
    return null;
  }

  function broadcastEditingState(dbId, editing) {
    if (!boardChannel || dbId == null) return;
    boardChannel.send({ type: "broadcast", event: "row-editing", payload: { dbId, editing, from: editingSessionId } });
  }

  function handleRowFocusIn(e) {
    const tr = e.target.closest("tr[id]");
    if (!tr || !tr.id || tr.id === editingRowId) return;
    const found = findRowAnywhere(tr.id);
    if (!found || !found.row.dbId) return; // unsaved row — nothing stable to broadcast yet
    editingRowId = tr.id;
    tr.classList.add("is-being-edited"); // shows locally too — helps the person typing track which row they're in, same as everyone else sees
    broadcastEditingState(found.row.dbId, true);
    clearInterval(editingPingInterval);
    editingPingInterval = setInterval(() => broadcastEditingState(found.row.dbId, true), 4000);
  }

  function handleRowFocusOut(e) {
    const tr = e.target.closest("tr[id]");
    if (!tr || tr.id !== editingRowId) return;
    if (e.relatedTarget && tr.contains(e.relatedTarget)) return; // focus just moved to another field in the same row
    tr.classList.remove("is-being-edited");
    const found = findRowAnywhere(tr.id);
    if (found && found.row.dbId) broadcastEditingState(found.row.dbId, false);
    editingRowId = null;
    clearInterval(editingPingInterval);
  }

  function handleRemoteRowEditing(payload) {
    if (!payload || payload.from === editingSessionId) return; // ignore our own broadcasts
    const { dbId, editing } = payload;
    if (dbId == null) return;
    const localRow = findRowByDbId(dbId);
    if (!localRow) return; // this dbId isn't part of the currently-loaded day on this device
    const tr = document.getElementById(localRow.id);
    clearTimeout(remoteEditingTimeouts.get(dbId));
    if (editing) {
      if (tr) tr.classList.add("is-being-edited");
      remoteEditingTimeouts.set(dbId, setTimeout(() => {
        const freshRow = findRowByDbId(dbId);
        const el = freshRow ? document.getElementById(freshRow.id) : null;
        if (el) el.classList.remove("is-being-edited");
      }, 8000));
    } else if (tr) {
      tr.classList.remove("is-being-edited");
    }
  }

  /* ---------------- rendering: driver list ---------------- */

  export function refreshDriverDatalist() {
    let dl = document.getElementById("driverNamesList");
    if (!dl) { dl = document.createElement("datalist"); dl.id = "driverNamesList"; document.body.appendChild(dl); }
    const contextLocation = state.activeLocation || state.driverListTab || "atlanta";
    dl.innerHTML = driversForLocation(contextLocation).map((d) => `<option value="${escapeHtml(d.name)}">`).join("");
  }

  /* ---------------- shared driver-name autocomplete (all driver-name fields site-wide) ----------------
     Replaces the native <datalist> popup everywhere it was used. A native
     datalist's open/close timing and on-screen position are entirely up to
     the browser -- a page has no control over either, which is why it was
     closing on its own and not consistently appearing under the field. This
     is one floating dropdown, positioned in JS under whichever input is
     currently focused (so it always tracks it correctly regardless of which
     table/page it's in, or whether that table scrolls), and it only ever
     closes on a real dismissal: picking an option, clicking elsewhere, or
     pressing Escape -- never on its own after a few seconds. */
  let driverAcBox = null;
  let driverAcOnPick = null; // (driver) => void
  let driverAcMatches = [];
  let driverAcHighlight = -1;
  let driverAcInput = null;

  function ensureDriverAcBox() {
    if (driverAcBox) return driverAcBox;
    const box = document.createElement("div");
    box.className = "autocomplete-list hidden driver-ac-floating";
    box.id = "driver-ac-floating";
    document.body.appendChild(box);
    // mousedown fires before the input's blur/focusout, so a pick registers
    // before closeDriverAutocomplete() would otherwise hide the box first
    box.addEventListener("mousedown", (e) => {
      const item = e.target.closest("[data-pick-driver]");
      if (!item) return;
      e.preventDefault();
      const drv = findDriver(item.dataset.pickDriver);
      if (drv && driverAcOnPick) driverAcOnPick(drv);
      closeDriverAutocomplete();
    });
    driverAcBox = box;
    return box;
  }

  function positionDriverAcBox(inputEl) {
    const box = ensureDriverAcBox();
    const rect = inputEl.getBoundingClientRect();
    box.style.position = "fixed";
    box.style.left = rect.left + "px";
    box.style.top = rect.bottom + 2 + "px";
    box.style.width = Math.max(rect.width, 220) + "px";
  }

  function renderDriverAcOptions(query, locationKey) {
    const box = ensureDriverAcBox();
    const q = (query || "").trim().toLowerCase();
    const pool = driversForLocation(locationKey || "atlanta");
    driverAcMatches = (q ? pool.filter((d) => d.name.toLowerCase().includes(q)) : pool).slice(0, 8);
    driverAcHighlight = -1;
    box.innerHTML = driverAcMatches.length
      ? driverAcMatches.map((d, i) => `
          <div class="autocomplete-item" data-pick-driver="${d.id}" data-ac-index="${i}">
            ${escapeHtml(d.name)}<div class="ac-sub">${escapeHtml(d.mc)} · ${escapeHtml(d.phone)}</div>
          </div>`).join("")
      : `<div class="autocomplete-item" style="color:var(--slate-500);">No matching driver.</div>`;
  }

  function setDriverAcHighlight(index) {
    if (!driverAcBox) return;
    driverAcHighlight = index;
    $all(".autocomplete-item[data-ac-index]", driverAcBox).forEach((el) => {
      const isHit = Number(el.dataset.acIndex) === index;
      el.classList.toggle("is-highlighted", isHit);
      if (isHit) el.scrollIntoView({ block: "nearest" });
    });
  }

  function handleDriverAcKeydown(e) {
    if (!driverAcBox || driverAcBox.classList.contains("hidden")) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (driverAcMatches.length) setDriverAcHighlight(Math.min(driverAcHighlight + 1, driverAcMatches.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (driverAcMatches.length) setDriverAcHighlight(Math.max(driverAcHighlight - 1, 0));
    } else if (e.key === "Enter") {
      if (driverAcHighlight >= 0 && driverAcMatches[driverAcHighlight]) {
        e.preventDefault();
        const drv = driverAcMatches[driverAcHighlight];
        if (driverAcOnPick) driverAcOnPick(drv);
        closeDriverAutocomplete();
      }
    } else if (e.key === "Escape") {
      closeDriverAutocomplete();
    }
  }

  // Call on focus (and again on every keystroke) for any driver-name field —
  // locationKey picks which driver pool to search (pass "mondelez" on the
  // Mondelez board, "houston" on Houston, etc; falls back to state.activeLocation).
  export function openDriverAutocomplete(inputEl, locationKey, onPick) {
    driverAcOnPick = onPick;
    positionDriverAcBox(inputEl);
    renderDriverAcOptions(inputEl.value, locationKey || state.activeLocation);
    ensureDriverAcBox().classList.remove("hidden");
    if (driverAcInput && driverAcInput !== inputEl) driverAcInput.removeEventListener("keydown", handleDriverAcKeydown);
    if (driverAcInput !== inputEl) inputEl.addEventListener("keydown", handleDriverAcKeydown);
    driverAcInput = inputEl;
  }
  export function updateDriverAutocomplete(inputEl, locationKey) {
    // If the box got closed for any reason (Escape, a stray blur/refocus
    // cycle, a realtime re-render swapping the DOM node) while the user is
    // still actively typing in this field, treat that as reopening it
    // rather than silently doing nothing — a user who's still typing
    // should always see live suggestions, not get stuck with a dead field
    // until they click away and back in.
    if (!driverAcBox || driverAcBox.classList.contains("hidden")) {
      if (document.activeElement === inputEl) openDriverAutocomplete(inputEl, locationKey, driverAcOnPick);
      return;
    }
    positionDriverAcBox(inputEl); // re-anchor in case the row shifted (e.g. a save-status change)
    renderDriverAcOptions(inputEl.value, locationKey || state.activeLocation);
  }
  export function closeDriverAutocomplete() {
    if (driverAcBox) driverAcBox.classList.add("hidden");
    // driverAcOnPick is deliberately NOT cleared here — it's only ever
    // invoked from the box's own click handler or the Enter-key handler,
    // both of which already check the box is visible first, so there's no
    // risk of a stale callback firing while closed. Keeping it around lets
    // updateDriverAutocomplete's self-heal-by-reopening path work correctly
    // if this field gets typed in again without a fresh focus event.
    if (driverAcInput) { driverAcInput.removeEventListener("keydown", handleDriverAcKeydown); driverAcInput = null; }
  }
  // Reposition on scroll rather than closing outright — closing here used to
  // fire immediately after opening, because focusing a field near the edge
  // of a scrolled table triggers the browser's own small auto-scroll to
  // bring it into view, and that scroll event was being caught (this
  // listener runs in the capture phase specifically so it catches scrolling
  // inside the table's own scroll container, not just the page) and
  // dismissing the dropdown before it was ever visible.
  document.addEventListener("scroll", () => {
    if (driverAcInput && driverAcBox && !driverAcBox.classList.contains("hidden")) {
      positionDriverAcBox(driverAcInput);
    }
  }, true);
  window.addEventListener("resize", () => closeDriverAutocomplete());

  // Tab, site-wide across every board table: move rightward through the
  // editable fields on the CURRENT row, then drop down to the first
  // editable field of the next row once the current row runs out.
  // Plain DOM tab order was jumping unpredictably, since each row mixes
  // many non-editable calculated cells (plain <span> text) in among the
  // real inputs, and pinned/sticky columns don't reorder tab flow to
  // match — this makes tab order explicit instead of relying on that.
  const EDITABLE_SELECTOR = 'input:not([disabled]):not([type="checkbox"]), textarea:not([disabled]), select:not([disabled])';
  export function handleRowAwareTab(e, tableSelector) {
    if (e.key !== "Tab") return;
    const el = e.target;
    if (!el.matches || !el.matches(EDITABLE_SELECTOR)) return;
    const table = el.closest(tableSelector);
    if (!table) return;
    const tr = el.closest("tr");
    if (!tr) return;
    const rowFields = $all(EDITABLE_SELECTOR, tr);
    const idx = rowFields.indexOf(el);
    if (idx === -1) return;
    const forward = !e.shiftKey;
    const nextInRow = forward ? rowFields[idx + 1] : rowFields[idx - 1];
    if (nextInRow) {
      e.preventDefault();
      nextInRow.focus();
      if (nextInRow.select && nextInRow.type !== "checkbox") nextInRow.select();
      return;
    }
    // ran out of fields on this row — drop to the next (or previous) row
    let sib = forward ? tr.nextElementSibling : tr.previousElementSibling;
    while (sib) {
      const fields = $all(EDITABLE_SELECTOR, sib);
      const target = forward ? fields[0] : fields[fields.length - 1];
      if (target) {
        e.preventDefault();
        target.focus();
        if (target.select && target.type !== "checkbox") target.select();
        return;
      }
      sib = forward ? sib.nextElementSibling : sib.previousElementSibling;
    }
    // no more rows either way — let the browser do its normal thing (tab out of the table)
  }

  function renderDriverList() {
    const body = $("#driverlist-table-body");
    if (!body) return;
    const tbody = getSortedDrivers().map((d) => {
      const displayRate = getDriverDisplayRate(d);
      return `
      <tr id="dl-${d.id}" class="${d.addedAt ? "is-new" : ""}">
        <td><button type="button" class="cell-link-btn" data-action="edit-driver" data-driver-id="${d.id}" title="Open driver profile">↗</button></td>
        <td>${escapeHtml(d.name)}</td>
        <td>${escapeHtml(d.phone || "—")}</td>
        <td>${escapeHtml(d.mc || "—")}</td>
        <td>${escapeHtml(d.dispatcherPhone || "—")}</td>
        <td>${escapeHtml(d.email)}</td>
        <td>${escapeHtml(d.email2 || "—")}</td>
        <td>${escapeHtml(d.rating || "—")}</td>
        <td>${displayRate != null ? `$${Number(displayRate).toLocaleString()}` : "—"}</td>
        <td>${escapeHtml(d.carrier || "—")}</td>
        <td>${escapeHtml(d.rateBooking || "—")}</td>
        <td><span class="badge ${d.tia ? "badge-yes" : "badge-no"}">${d.tia ? "Yes" : "No"}</span></td>
        <td>${d.tiiAmount != null ? `$${Number(d.tiiAmount).toLocaleString()}` : "—"}</td>
        <td>${escapeHtml(d.notes || "—")}</td>
      </tr>`;
    }).join("");
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

  // Alerts are always about today (scanForBoardAlerts only ever looks at
  // today's shifts) — if the board happens to be showing a different date
  // when one gets clicked, switch to today first and wait for that render
  // before trying to find the row, otherwise it wouldn't exist in the DOM yet.
  export async function scrollToAndOutlineShiftRow(dbId) {
    if (state.activeDate !== state.todayKey) {
      state.activeDate = state.todayKey;
      await loadAndRenderBoard();
    }
    const rows = getSheet(state.activeLocation, state.activeDate);
    const row = rows.find((r) => r.dbId === dbId);
    if (!row) return;
    const tr = document.getElementById(row.id);
    if (!tr) return;
    tr.scrollIntoView({ behavior: "smooth", block: "center" });
    tr.classList.add("alert-outline-flash");
    setTimeout(() => tr.classList.remove("alert-outline-flash"), 3000);
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

  // "Called off" is a distinct event from TONU — TONU is a load falling
  // through after dispatch; this is a driver calling in unable to make
  // the shift at all (breakdown, family emergency, or no reason given).
  // Needs a reason captured, so this opens a small modal rather than
  // toggling instantly like TONU does.
  function openCalledOffModal(rowId) {
    const found = findRowAnywhere(rowId);
    if (!found) return;
    const row = found.row;
    const drv = row.driverId ? findDriver(row.driverId) : null;
    const driverLabel = drv ? drv.name : (row.driverNameText || "This driver");
    const existing = document.getElementById("called-off-overlay");
    if (existing) existing.remove();
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    overlay.id = "called-off-overlay";
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-header">
          <h3>Cancellation</h3>
          <button class="modal-close" id="called-off-close">&times;</button>
        </div>
        <div class="modal-body">
          <p style="margin:0 0 10px;">${escapeHtml(driverLabel)} called in and can't make this shift.</p>
          <div class="field">
            <label for="called-off-notes">Reason for cancellation:</label>
            <textarea class="cell-input" id="called-off-notes" rows="3" style="width:100%;" placeholder="e.g. truck broke down, family emergency, no reason given"></textarea>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" id="called-off-cancel">Cancel</button>
          <button class="btn" id="called-off-submit">Mark Cancellation</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    $("#called-off-close").addEventListener("click", close);
    $("#called-off-cancel").addEventListener("click", close);
    $("#called-off-submit").addEventListener("click", async () => {
      const reasonText = ($("#called-off-notes").value || "").trim();
      row.calledOff = true;
      row.calledOffReason = reasonText;
      row.calledOffNotes = reasonText;
      row.calledOffAt = new Date().toISOString();
      await saveShiftNow(row);
      logChange(row.dbId, labelForRow(row), "called_off", "false", "true");
      close();
      renderBoardTable();
    });
  }

  async function unmarkDriverCalledOff(rowId) {
    const found = findRowAnywhere(rowId);
    if (!found) return;
    const row = found.row;
    row.calledOff = false;
    row.calledOffReason = "";
    row.calledOffNotes = "";
    row.calledOffAt = null;
    await saveShiftNow(row);
    logChange(row.dbId, labelForRow(row), "called_off", "true", "false");
    renderBoardTable();
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

  function updateBoardSelectCount() {
    const el = $("#board-select-count");
    if (!el) return;
    const rows = getSheet(state.activeLocation, state.activeDate);
    const selectedCount = rows.filter((r) => r.selected).length;
    el.textContent = `Count ${rows.length} (${selectedCount} selected)`;
  }

  function toggleRowSelected(rowId) {
    const found = findRowAnywhere(rowId);
    if (!found) return;
    found.row.selected = !found.row.selected;
    const tr = document.getElementById(rowId);
    if (tr) tr.classList.toggle("is-row-selected", found.row.selected);
    updateBulkActionButtonsVisibility();
    updateBoardSelectCount();
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
    updateBoardSelectCount();
  }

  let timesheetModalState = null; // { rowId, queue: [rowId, ...] } — queue is for bulk-complete chaining
  const focusValueSnapshots = new Map(); // "rowId:field" -> value at focus-in, for detecting a real committed change on blur

  // Hours elapsed since this shift's own start time (shift_date + shift_start
  // combined into a real moment), regardless of what today's date is. Returns
  // null when there's no shift_start to anchor to yet.
  function hoursSinceShiftStart(row) {
    const startMin = parseHHMM(row.shiftStart);
    if (startMin == null || !row.shiftDate) return null;
    const anchor = keyToDate(row.shiftDate);
    anchor.setMinutes(anchor.getMinutes() + startMin);
    return (Date.now() - anchor.getTime()) / (1000 * 60 * 60);
  }

  // The single gate every "should this shift be in Accounting yet" trigger
  // funnels through — explicitly marking a shift complete, filling in both
  // time sheet times, or the shift simply turning 12 hours old. Unlike the
  // explicit Shift Complete button, none of these three conditions forces
  // shift_complete itself to true — a shift can land in Accounting without
  // ever being marked complete (that's the whole reason
  // openLoadDetailsFromAccounting warns on open when that's the case).
  // Safe to call repeatedly: sentToAccounting (backed by the real
  // sent_to_accounting column) means a shift already sent is never
  // re-sent, which matters here specifically because sendShiftToAccounting()
  // unconditionally resets cost_level/revenue_level back to their 1/1
  // defaults on every call — re-triggering it after a dispatcher has since
  // changed those on the Accounting page would silently clobber that edit.
  async function maybeSendToAccounting(row) {
    if (!row.dbId || row.sentToAccounting) return;
    const timesheetComplete = row.timesheetReceived && !!String(row.timesheetStartTime || "").trim() && !!String(row.timesheetEndTime || "").trim();
    const hoursOld = hoursSinceShiftStart(row);
    const hasRealTrip = row.trips.some((t) => String(t.routeId || "").trim());
    // The 12-hour trigger is a blind timer, not a human assertion that the
    // shift is actually done — a shift that's 12 hours old but still has
    // zero real trips entered almost certainly just hasn't had its data
    // caught up yet, not "nothing happened." Sending it anyway would create
    // a permanently-blank Accounting record, since sentToAccounting blocks
    // ever re-sending it once real trips do get entered. Shift Complete and
    // a filled-in time sheet are both explicit human actions, so those two
    // stay trusted even with zero trips (matches how the board's own
    // Complete-shift confirmation already treats a genuinely trip-less shift).
    const twelveHoursOld = hoursOld != null && hoursOld >= 12 && hasRealTrip;
    const qualifies = row.shiftComplete || timesheetComplete || twelveHoursOld;
    if (!qualifies) return;
    try {
      await sendShiftToAccounting(row, row.location || state.activeLocation, row.shiftDate || state.activeDate);
      row.sentToAccounting = true;
    } catch (e) {
      console.error("maybeSendToAccounting failed:", e);
    }
  }

  // Runs periodically (see initBoardPage) over every shift currently cached
  // in this browser tab, catching the two conditions that aren't tied to a
  // specific save action: a shift quietly turning 12 hours old, or a time
  // sheet that got completed through some other path. This only runs while
  // someone actually has a board open — there's no server-side scheduler
  // behind this yet, so a day nobody opens the board won't auto-send on its
  // own. A guaranteed always-on version of this needs a Supabase Edge
  // Function on a schedule, which is a real but separate infrastructure step.
  async function scanForAutoAccountingSend() {
    for (const key in state.sheets) {
      for (const row of state.sheets[key]) {
        if (!row.dbId || row.sentToAccounting) continue;
        await maybeSendToAccounting(row);
      }
    }
  }

  async function finalizeShiftCompletion(row) {
    row.shiftComplete = true;
    row.shiftCompleteAt = new Date().toISOString();
    await saveShiftNow(row);
    logChange(row.dbId, labelForRow(row), "shift_complete", "false", "true");
    await discardBlankTrips(row);
    await minimizeAllTrips(row);
    recomputeRowRate(row);
    await maybeSendToAccounting(row);
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
    const wasTimesheetReceived = row.timesheetReceived;
    row.timesheetReceived = received;
    row.timesheetStartTime = start;
    row.timesheetEndTime = end;
    row.trailerDropLocation = dropLocation;
    if (!wasTimesheetReceived && row.timesheetReceived) logChange(row.dbId, labelForRow(row), "timesheet_received", "false", "true");
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

    if (state.activeLocation === "atlanta") {
      const [first, ...rest] = rows.map((r) => r.id);
      openTimesheetModal(first, rest);
    } else {
      // Atlanta is the only location that tracks routes live and needs
      // the time sheet gate before completion — every other location
      // just captures trip sheets and basic info after the fact.
      for (const row of rows) await finalizeShiftCompletion(row);
      renderBoardTable();
    }
  }

  function openTextSelectedModal() {
    const rows = getSheet(state.activeLocation, state.activeDate).filter((r) => r.selected);
    if (!rows.length) { setDriverSyncStatus("Nothing's checked yet — select some loads first.", "error"); return; }
    const modal = $("#modal-text-group");
    if (!modal) return;
    groupTextState = null;
    $("#tg-group-tabs-wrap").classList.add("hidden"); // no group to pick — the checkboxes already picked them
    $("#tg-message").value = "";
    const dispatchModeCheckbox = $("#tg-dispatch-mode");
    if (dispatchModeCheckbox) dispatchModeCheckbox.checked = true;
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
      return { name: drv ? drv.name : (r.driverNameText || "Unnamed"), phone: drv ? drv.phone : "", dispatcherPhone: drv ? drv.dispatcherPhone : "" };
    });
    beginTextBatchFlow(applyPhoneMode(members), "Selected Loads", message);
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

  async function unminimizeAllTrips(row) {
    for (const trip of row.trips) {
      if (!trip.minimized) continue;
      trip.minimized = false;
      await saveTripNow(row, trip, row.trips.indexOf(trip) + 1);
    }
  }

  async function toggleShiftComplete(rowId) {
    const found = findRowAnywhere(rowId);
    if (!found) return;
    const row = found.row;
    if (!row.shiftComplete) {
      const open = openTripsForRow(row);
      if (open.length) {
        const names = open.map((t, i) => t.routeId || t.tripId || `Route ${i + 1}`).join(", ");
        if (!confirm(`This load still has ${open.length} trip(s) not closed out yet (${names}) — likely still waiting on paperwork. Send it to Accounting anyway?`)) return;
      }
      // Atlanta is the only location that tracks routes live and needs
      // the time sheet gate before completion — every other location
      // just captures trip sheets and basic info after the fact, so
      // completing there skips the modal and finalizes directly.
      if ((row.location || state.activeLocation) === "atlanta") {
        openTimesheetModal(rowId, []);
      } else {
        await finalizeShiftCompletion(row);
      }
      return;
    }
    // Un-completing needs to bring the load back into active play — every
    // trip has to un-minimize too, or the row renders with no editable
    // route fields at all (see openTripsFor()'s "every trip minimized"
    // fallback, which shows blank cells with nothing to click into).
    row.shiftComplete = false;
    row.shiftCompleteAt = null;
    await saveShiftNow(row);
    await unminimizeAllTrips(row);
    renderBoardTable();
  }

  /* ---------------- Atlanta rate settings — minimizable modal ----------------
     Same layout idea as Mondelez's inline rate panel, but as a modal
     (injected via JS, no HTML changes needed) since Atlanta's board is
     already dense. Edits board_rate_tiers/board_rate_settings directly —
     the same tables the Load Details Rate panel and driver rate cards
     already read from, so there's nothing new to keep in sync. */
  function atlantaRateSettingsBodyHtml() {
    const tiers = (getBoardRateTiers() && getBoardRateTiers().atlanta) || [];
    const settings = (getBoardRateSettings() && getBoardRateSettings().atlanta) || {};
    const box = (label, inputHtml) => `<fieldset class="rate-tier-box"><legend>${label}</legend>${inputHtml}</fieldset>`;
    return `
      <div class="subtext" style="margin-bottom:10px;">These are the Atlanta board's shared default rates — a load or driver with its own override still wins over these.</div>
      <div class="rate-tier-grid" style="grid-template-columns: repeat(2, 1fr);">
        ${tiers.map((t) => box(`${t.min}-${t.max}MI`, `<input type="number" step="0.01" data-atlanta-tier-id="${t.id}" value="${t.rate}">`)).join("")}
        ${box("Over-tier ($/mi)", `<input type="number" step="0.01" data-atlanta-setting-key="over_tier_per_mile" value="${settings.over_tier_per_mile ?? 2.4}">`)}
        ${box("Free stops", `<input type="number" step="1" data-atlanta-setting-key="stop_charge_free_stops" value="${settings.stop_charge_free_stops ?? 2}">`)}
        ${box("$/extra stop", `<input type="number" step="0.01" data-atlanta-setting-key="stop_charge_per_stop" value="${settings.stop_charge_per_stop ?? 20}">`)}
        ${box("TONU flat", `<input type="number" step="0.01" data-atlanta-setting-key="tonu_flat" value="${settings.tonu_flat ?? 150}">`)}
      </div>`;
  }

  function openAtlantaRateSettingsModal() {
    const existing = document.getElementById("modal-atlanta-rate-settings");
    if (existing) existing.remove();
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    overlay.id = "modal-atlanta-rate-settings";
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-header">
          <h3>Atlanta Rate Settings</h3>
          <button class="modal-close" id="atl-rate-close">&times;</button>
        </div>
        <div class="modal-body" id="atl-rate-body">${atlantaRateSettingsBodyHtml()}</div>
        <div class="modal-footer">
          <button class="btn btn-ghost" id="atl-rate-minimize">Minimize</button>
          <button class="btn" id="atl-rate-done">Done</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    $("#atl-rate-close").addEventListener("click", close);
    $("#atl-rate-done").addEventListener("click", close);
    // Every box saves live as it's edited (see below), so Minimize and
    // Done both just close the modal — nothing is lost either way.
    $("#atl-rate-minimize").addEventListener("click", close);
    overlay.addEventListener("change", async (e) => {
      const t = e.target;
      if (t.dataset.atlantaTierId) {
        const ok = await saveTierRate(Number(t.dataset.atlantaTierId), Number(t.value));
        setDriverSyncStatus(ok ? "Rate saved." : "Couldn't save that rate.", ok ? "success" : "error");
        if (ok) renderBoardTable();
      } else if (t.dataset.atlantaSettingKey) {
        const ok = await saveSetting("atlanta", t.dataset.atlantaSettingKey, Number(t.value));
        setDriverSyncStatus(ok ? "Setting saved." : "Couldn't save that setting.", ok ? "success" : "error");
        if (ok) renderBoardTable();
      }
    });
  }

  function injectAtlantaRateSettingsButton() {
    const infoBtn = $("#btn-page-info");
    if (!infoBtn || document.getElementById("btn-atlanta-rate-settings")) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-ghost";
    btn.id = "btn-atlanta-rate-settings";
    btn.style.marginLeft = "8px";
    btn.textContent = "💲 Rate Settings";
    btn.addEventListener("click", openAtlantaRateSettingsModal);
    infoBtn.insertAdjacentElement("afterend", btn);
  }

  /* ---------------- driver-assignment warning modal ----------------
     Built via DOM injection rather than static HTML — works on every
     page (Atlanta/Delaware/Building C for now) without needing the same
     markup pasted into multiple HTML files. Exported since accounting.js
     reuses this same modal for its own "shift not marked complete" warning
     — same generic shape (title + lines + OK button), just a different
     trigger and an optional callback for what happens once it's dismissed. */
  export function showDriverAssignmentWarning(title, lines, onAcknowledge) {
    const existing = document.getElementById("driver-warning-overlay");
    if (existing) existing.remove();
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    overlay.id = "driver-warning-overlay";
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-header">
          <h3>${escapeHtml(title)}</h3>
          <button class="modal-close" id="driver-warning-close">&times;</button>
        </div>
        <div class="modal-body">
          ${lines.map((l) => `<p style="margin:0 0 10px;">${l}</p>`).join("")}
        </div>
        <div class="modal-footer">
          <button class="btn" id="driver-warning-ok">OK</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const close = () => { overlay.remove(); if (onAcknowledge) onAcknowledge(); };
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    document.getElementById("driver-warning-close").addEventListener("click", close);
    document.getElementById("driver-warning-ok").addEventListener("click", close);
  }

  // Fires whenever a real driver record gets assigned to a load anywhere
  // on the board — flags a missing Trailer Interchange Agreement and/or
  // missing Interchange Coverage (insurance) on that driver's profile.
  function checkDriverComplianceWarning(driver) {
    if (!driver) return;
    const missing = [];
    if (!driver.tia) missing.push("a Trailer Interchange Agreement");
    if (driver.tiiAmount == null) missing.push("Interchange Coverage (insurance) on file");
    if (!missing.length) return;
    showDriverAssignmentWarning(
      "Driver Missing Interchange Info",
      [`${escapeHtml(driver.name)} is missing ${missing.join(" and ")}. Double check before dispatching this load.`]
    );
  }

  // A driver showing up twice on the same day is usually a mistake, but
  // not always — so this just flags it rather than blocking the
  // assignment. Scoped to the current location + day, not across boards.
  function warnIfDriverAlreadyScheduled(row, driverId) {
    const sheet = getSheet(state.activeLocation, state.activeDate);
    const conflict = sheet.find((r) => r.id !== row.id && r.driverId && String(r.driverId) === String(driverId));
    if (!conflict) return;
    const drv = findDriver(driverId);
    const label = conflict.proNumber ? `PRO# ${conflict.proNumber}` : "another load";
    showDriverAssignmentWarning(
      "Driver Already Scheduled Today",
      [`${escapeHtml(drv ? drv.name : "This driver")} is already scheduled today on ${escapeHtml(label)}.`,
       `That's fine if it's intentional — just flagging it in case it's not.`]
    );
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

  async function deleteTrip(rowId, tripId) {
    const found = findRowAnywhere(rowId);
    if (!found) return;
    const row = found.row;
    const trip = row.trips.find((t) => t.id === tripId);
    if (!trip) return;
    if (row.trips.length <= 1) {
      alert("A load needs at least one route on it — clear its fields instead of deleting the only one.");
      return;
    }
    const label = trip.routeId || trip.tripId || "this route";
    if (!confirm(`Delete route ${label}? This can't be undone.`)) return;

    logChange(row.dbId, `${labelForRow(row)} — ${label}`, "route_deleted", "active", "deleted");

    const idx = row.trips.findIndex((t) => t.id === tripId);
    if (idx !== -1) row.trips.splice(idx, 1);
    renderBoardTable();
    recomputeRowRate(row);

    if (trip.dbId && supabaseClient) {
      try {
        const { error } = await supabaseClient.from(TRIPS_TABLE).delete().eq("id", trip.dbId);
        if (error) throw error;
      } catch (e) {
        console.error("deleteTrip failed:", e);
        setDriverSyncStatus(`Route removed here, but couldn't delete it from the database (${e.message || e}) — it may come back on refresh.`, "error");
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
    // De-dupe by normalized phone — several drivers can share the same
    // dispatcher (or even the same cell), and nobody should get texted
    // more than once just because multiple of their drivers were selected.
    const seen = new Set();
    const deduped = [];
    withPhone.forEach((r) => {
      const normalized = formatTextAddress(r.phone);
      if (seen.has(normalized)) return;
      seen.add(normalized);
      deduped.push(r);
    });
    if (!deduped.length) {
      setDriverSyncStatus("No phone number on file for this driver.", "error");
      return;
    }
    sendTextModalState = { recipients: deduped, markShiftIdsOnSent: markShiftIdsOnSent || null };
    $("#send-text-phone-display").textContent = deduped.map((r) => r.name || r.phone).join(", ");
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
          const wasSent = r.preShiftTextSent;
          r.preShiftTextSent = true;
          r.preShiftTextSentAt = nowIso;
          if (!wasSent) logChange(r.dbId, labelForRow(r), "pre_shift_text_sent", "false", "true");
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

  // Known classifications up front, in a sensible order — DNU checked before
  // the generic letter match, since "DNU" would otherwise match the same as
  // a plain "D" rating (both start with the same letter) and the two need
  // to stay separate: DNU means specifically not to use that driver.
  const KNOWN_DRIVER_CLASSES = ["A", "B", "C", "D", "DNU", "R"];
  function driverClassification(drv) {
    const rating = (drv.rating || "").trim().toUpperCase();
    if (!rating) return null;
    if (rating.startsWith("DNU")) return "DNU";
    const m = /^[A-Z]/.exec(rating);
    return m ? m[0] : null;
  }

  function availableDriverClasses() {
    const pool = driversForLocation(state.driverListTab || "atlanta");
    const found = new Set();
    pool.forEach((d) => { const k = driverClassification(d); if (k) found.add(k); });
    // known classes first (in their fixed order, even if no driver currently
    // has that rating -- picking it just sends to nobody, no harm), then
    // anything else actually present in the data that isn't in the known list
    const extras = [...found].filter((k) => !KNOWN_DRIVER_CLASSES.includes(k)).sort();
    return [...KNOWN_DRIVER_CLASSES, ...extras];
  }

  function openTextGroupModal() {
    const modal = $("#modal-text-group");
    if (!modal) return;
    groupTextState = null;
    const selectEl = $("#tg-group-select");
    if (selectEl) {
      const classes = availableDriverClasses();
      selectEl.innerHTML = [
        `<option value="ALL">All Drivers</option>`,
        ...classes.map((c) => `<option value="${c}">${c === "DNU" ? "DNU" : "Rating " + c}</option>`),
      ].join("");
      selectEl.value = "ALL";
    }
    const msgEl = $("#tg-message");
    if (msgEl) msgEl.value = "";
    const dispatchModeCheckbox = $("#tg-dispatch-mode");
    if (dispatchModeCheckbox) dispatchModeCheckbox.checked = true;
    $("#tg-setup-step").classList.remove("hidden");
    $("#tg-progress-step").classList.add("hidden");
    $("#tg-error").classList.add("hidden");
    modal.classList.remove("hidden");
  }

  // Shared by both Text Group flows (driver-list group texting and the
  // board's "text selected rows") — when dispatch mode is on, prefers
  // each member's dispatcher phone if one's on file, falling back to
  // their own cell if not. De-duplication for shared dispatcher numbers
  // happens downstream in beginTextBatchFlow, so this only needs to
  // pick the right number per member.
  function applyPhoneMode(members) {
    const checkbox = $("#tg-dispatch-mode");
    const dispatchMode = checkbox ? checkbox.checked : true;
    if (!dispatchMode) return members;
    return members.map((m) => {
      const dispatchPhone = m.dispatcherPhone && String(m.dispatcherPhone).trim();
      if (!dispatchPhone) return m;
      return { ...m, name: `${m.name} (dispatch)`, phone: dispatchPhone };
    });
  }

  export function beginTextBatchFlow(members, label, message) {
    const errEl = $("#tg-error");
    const withPhone = [];
    const skipped = [];
    const deduped = [];
    const seenPhones = new Set();
    members.forEach((d) => {
      const normalized = formatTextAddress(d.phone);
      if (!normalized) { skipped.push(d); return; }
      if (seenPhones.has(normalized)) { deduped.push(d); return; } // shares a number with someone already queued -- don't text it twice
      seenPhones.add(normalized);
      withPhone.push(d);
    });

    if (withPhone.length === 0) {
      errEl.textContent = `No one in ${label} has a phone number on file.`;
      errEl.classList.remove("hidden");
      return;
    }
    errEl.classList.add("hidden");

    const batches = [];
    for (let i = 0; i < withPhone.length; i += GROUP_BATCH_SIZE) batches.push(withPhone.slice(i, i + GROUP_BATCH_SIZE));

    groupTextState = { groupKey: label, message, batches, batchIndex: 0, skipped, deduped, totalSent: 0 };
    $("#tg-setup-step").classList.add("hidden");
    $("#tg-progress-step").classList.remove("hidden");
    renderGroupTextProgress();
  }

  function startGroupTexting() {
    const groupKey = ($("#tg-group-select") || {}).value || "";
    const message = $("#tg-message").value.trim();
    const errEl = $("#tg-error");
    if (!groupKey) { errEl.textContent = "Pick who to text first."; errEl.classList.remove("hidden"); return; }
    if (!message) { errEl.textContent = "Write a message first."; errEl.classList.remove("hidden"); return; }
    errEl.classList.add("hidden");

    const pool = driversForLocation(state.driverListTab || "atlanta");
    const rawMembers = groupKey === "ALL" ? pool : pool.filter((d) => driverClassification(d) === groupKey);
    const label = groupKey === "ALL" ? "All Drivers" : (groupKey === "DNU" ? "DNU" : `Rating ${groupKey}`);
    beginTextBatchFlow(applyPhoneMode(rawMembers), label, message);
  }

  function renderGroupTextProgress() {
    const s = groupTextState;
    if (!s) return;
    const isDone = s.batchIndex >= s.batches.length;
    const skipNote = s.skipped.length
      ? `<div class="calc-note" style="margin-top:8px;">${s.skipped.length} driver(s) in this group have no phone on file and were skipped: ${escapeHtml(s.skipped.map((d) => d.name).join(", "))}</div>`
      : "";
    const dedupedNote = s.deduped && s.deduped.length
      ? `<div class="calc-note" style="margin-top:4px;">${s.deduped.length} driver(s) share a number with someone already in this batch, so only one text went to that number: ${escapeHtml(s.deduped.map((d) => d.name).join(", "))}</div>`
      : "";

    if (isDone) {
      $("#tg-progress-body").innerHTML = `
        <div class="subtext" style="font-weight:700; font-size:14px;">All done — ${s.totalSent} driver(s) in ${escapeHtml(s.groupKey)} texted across ${s.batches.length} batch(es).</div>
        ${skipNote}${dedupedNote}`;
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
      ${skipNote}${dedupedNote}
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
      { label: row.calledOff ? "Un-mark Cancellation" : "Cancellation", action: () => row.calledOff ? unmarkDriverCalledOff(rowId) : openCalledOffModal(rowId) },
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

  // Routes column click-through from the Accounting page — routeIdText is
  // the third, optional way in: loads_accounting_routes has no real
  // foreign key back to a specific loads_trips row (route_id/trip_id there
  // are just text snapshots taken when the shift was completed), so when
  // tripDbId isn't available (Atlanta's own Routes column, unlike
  // Delaware's which does have a real trip dbId to work with), this falls
  // back to matching on that text instead.
  export async function openLoadDetailsFromAccounting(accountingRecordId, tripDbId, routeIdText) {
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
      let targetTrip = tripDbId ? row.trips.find((t) => String(t.dbId) === String(tripDbId)) : null;
      if (!targetTrip && routeIdText) targetTrip = row.trips.find((t) => String(t.routeId || "").trim() === String(routeIdText).trim());
      await openLoadDetailsModal(row.id, targetTrip ? targetTrip.id : null);
    } catch (e) {
      console.error("openLoadDetailsFromAccounting failed:", e);
      setDriverSyncStatus(`Couldn't open this load (${e.message || e}).`, "error");
    }
  }

  // Opens a load straight from the Driver Profile's History tab (PRO#/
  // Load# link). Reuses the same standaloneLoadedRows path Accounting's
  // opener uses above, and marks the modal to render above the driver
  // profile modal (#modal-add-driver is z-index 150 — see loadboard.css)
  // via the ld-in-front class, since the person is drilling in from a
  // modal that's already open rather than starting from a blank page.
  // Houston and Mondelez loads live in separate tables/modals that this
  // doesn't wire up to yet — flagged rather than guessed at.
  export async function openLoadFromDriverHistory(kind, dbId) {
    if (kind !== "shift") {
      setDriverSyncStatus("Opening Houston or Mondelez loads from driver history isn't wired up yet — Atlanta, Delaware, and Building C loads work.", "error");
      return;
    }
    if (!supabaseClient) return;
    try {
      const { data: shiftRows, error: shiftErr } = await supabaseClient.from(SHIFTS_TABLE).select("*").eq("id", dbId);
      if (shiftErr || !shiftRows || !shiftRows[0]) throw shiftErr || new Error("Load not found");
      const row = shiftFromDbRow(shiftRows[0]);
      const { data: tripRows } = await supabaseClient.from(TRIPS_TABLE).select("*").eq("shift_id", row.dbId);
      const sortedTrips = (tripRows || []).sort((a, b) => a.trip_number - b.trip_number).map(tripFromDbRow);
      row.trips = sortedTrips.length ? sortedTrips : [blankTrip()];
      standaloneLoadedRows[row.id] = row;
      state.activeLocation = row.location || state.activeLocation;
      refreshDriverDatalist();
      await openLoadDetailsModal(row.id);
      const ldModal = $("#modal-load-details");
      if (ldModal) ldModal.classList.add("ld-in-front");
    } catch (e) {
      console.error("openLoadFromDriverHistory failed:", e);
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
      loadNotes: [],
      stopsByTrip: {}, // trip.id (local) -> [{stopNumber, timeIn, timeOut, dbId}]
      editMode: null, // "overview" | trip.id | null
      editDraft: null, // scratch copy of the fields being edited, discarded on Cancel
    };
    const openedForRowId = rowId; // snapshot — guards against a stale async response clobbering a newer/closed state below
    $("#ld-title").textContent = `Load ${row.proNumber || "(no PRO# yet)"}`;
    modal.classList.remove("hidden");
    renderLoadDetailsTabs();

    if (supabaseClient && row.dbId) {
      const tripDbIds = row.trips.filter((t) => t.dbId).map((t) => t.dbId);
      const [{ data: attachments }, { data: history }, stopsResult, notesResult] = await Promise.all([
        supabaseClient.from("load_attachments").select("*").eq("shift_id", row.dbId),
        supabaseClient.from("load_change_history").select("*").eq("shift_id", row.dbId),
        tripDbIds.length ? supabaseClient.from("trip_stops").select("*").in("trip_id", tripDbIds) : Promise.resolve({ data: [] }),
        supabaseClient.from(LOAD_NOTES_TABLE).select("*").eq("shift_id", row.dbId).order("created_at", { ascending: true }),
      ]).catch(() => [{ data: [] }, { data: [] }, { data: [] }, { data: [] }]);
      // The modal may have been closed, or reopened for a different load,
      // while these requests were still in flight — writing into a stale
      // (or now-null) loadDetailsState here is exactly what threw "Cannot
      // set properties of null". Bail out silently if either happened.
      if (!loadDetailsState || loadDetailsState.rowId !== openedForRowId) return;
      loadDetailsState.attachments = attachments || [];
      loadDetailsState.history = (history || []).sort((a, b) => (a.changed_at < b.changed_at ? 1 : -1));
      loadDetailsState.loadNotes = notesResult.data || [];
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
    $("#modal-load-details").classList.remove("ld-in-front");
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
      const s = existingStops.find((x) => x.stopNumber === i + 1) || { stopNumber: i + 1, timeIn: "", timeOut: "" };
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
    const breakdown = getEffectiveRateInfo(row);
    const val = (key, fallback) => effectiveSetting(row, locationKey, key, fallback);
    const isOv = (key) => isSettingOverridden(row, key) || isDriverSettingOverridden(row, key);

    let defaultsHtml;
    if (locationKey === "atlanta") {
      const overMax = tiers.length ? tiers[tiers.length - 1].max : 187;
      defaultsHtml = `
        <div class="rate-tier-grid">
          ${tiers.map((t) => rateTierBox(
            `${t.min}-${t.max}MI`,
            `<input type="number" step="0.01" data-rate-tier-id="${t.id}" value="${effectiveTierRate(row, t)}">`,
            isTierOverridden(row, t.id) || isDriverTierOverridden(row, t.id)
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
      const isAtlanta = (row.location || state.activeLocation) === "atlanta";
      const timesheetMissing = isAtlanta && (!row.timesheetReceived || !String(row.timesheetStartTime || "").trim() || !String(row.timesheetEndTime || "").trim());
      const banner = row.shiftComplete
        ? `<div class="ld-status-banner ld-status-banner-green">Load Complete</div>`
        : `<div class="ld-status-banner ld-status-banner-red">Load Open</div>`;
      let mainHtml;
      if (!editing) {
        mainHtml = `
          ${banner}
          <div class="ld-edit-bar"><button type="button" class="btn btn-ghost" data-ld-edit="overview">Edit</button></div>
          <div class="field-box-grid">
            <fieldset class="field-box"><legend>Driver</legend><div class="static-text">${escapeHtml(drv ? drv.name : (row.driverNameText || "—"))}${drv ? ` <button type="button" class="cell-link-btn" data-action="edit-driver" data-driver-id="${drv.id}" title="Open driver profile">↗</button>` : (row.driverNameText ? ` <button type="button" class="cell-link-btn" data-action="link-driver" title="Not linked to a driver profile — click to fix">Link</button>` : "")}</div></fieldset>
            <fieldset class="field-box"><legend>Status</legend><div class="static-text">${row.shiftComplete ? "Complete" : "Active"}</div></fieldset>
            <fieldset class="field-box"><legend>Trips</legend><div class="static-text">${row.trips.length}</div></fieldset>
            ${isAtlanta ? `
            <fieldset class="field-box${timesheetMissing ? " field-box-missing" : ""}" style="grid-column: span 2;">
              <legend>Time Sheet</legend>
              <div class="ov-timesheet-row">
                <div><label>Received</label><div class="static-text">${row.timesheetReceived ? "Yes" : "—"}</div></div>
                <div><label>Start</label><div class="static-text">${escapeHtml(row.timesheetStartTime || "—")}</div></div>
                <div><label>Finish</label><div class="static-text">${escapeHtml(row.timesheetEndTime || "—")}</div></div>
              </div>
            </fieldset>` : ""}
          </div>
          <div class="calc-note" style="margin-top:10px;">${isAtlanta ? "Time sheet info travels with this load — visible here and on the Accounting page once it's sent over." : "This location captures trip sheets and basic load info only — no time sheet is tracked here."}</div>
        `;
      } else {
        const d = loadDetailsState.editDraft;
        mainHtml = `
          ${banner}
          <div class="field-box-grid">
            <fieldset class="field-box"><legend>Driver</legend><input class="cell-input" id="ld-ov-driver" data-driver-ac="true" value="${escapeHtml(d.driverName)}"></fieldset>
            ${isAtlanta ? `
            <fieldset class="field-box${timesheetMissing ? " field-box-missing" : ""}" style="grid-column: span 2;">
              <legend>Time Sheet</legend>
              <div class="ov-timesheet-row">
                <div style="display:flex; align-items:center; gap:6px;">
                  <input type="checkbox" id="ld-ov-timesheet-received" ${d.timesheetReceived ? "checked" : ""}>
                  <label for="ld-ov-timesheet-received" style="margin:0;">Received</label>
                </div>
                <div><label>Start</label><input class="cell-input" id="ld-ov-timesheet-start" placeholder="--:--" value="${escapeHtml(d.timesheetStartTime)}"></div>
                <div><label>Finish</label><input class="cell-input" id="ld-ov-timesheet-end" placeholder="--:--" value="${escapeHtml(d.timesheetEndTime)}"></div>
              </div>
            </fieldset>` : ""}
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
      const notes = loadDetailsState.loadNotes || [];
      const notesHtml = notes.length
        ? notes.map((n) => `
            <div class="ld-note-entry" style="margin-bottom:14px; padding-bottom:14px; border-bottom:1px solid var(--line, #e5e7eb);">
              <div style="white-space:pre-wrap;">"${escapeHtml(n.note_text)}"</div>
              <div class="subtext" style="margin-top:3px;">${escapeHtml(n.created_by || "unknown user")}${n.source === "board" ? " (board)" : ""} — ${new Date(n.created_at).toLocaleString()}</div>
            </div>`).join("")
        : `<div class="subtext">No notes on this load yet.</div>`;
      body.innerHTML = `
        <div class="field">
          <label for="ld-note-input">Add a note</label>
          <textarea class="cell-input" id="ld-note-input" rows="3" style="width:100%;" placeholder="Notes added here stay on this load's permanent log — they won't show up in the board's own Notes field."></textarea>
          <button type="button" class="btn btn-ghost" id="ld-note-submit" style="margin-top:6px;">Add Note</button>
        </div>
        <div class="calc-note" style="margin:10px 0;">The board's own Notes field is separate and quick-edit — anything typed there is automatically added here too, timestamped and attributed, even if it's later changed or cleared from the board.</div>
        <div style="margin-top:14px;">${notesHtml}</div>
      `;
    } else if (tab.startsWith("trip-")) {
      const tripLocalId = tab.slice(5);
      const trip = row.trips.find((t) => t.id === tripLocalId);
      if (!trip) { body.innerHTML = `<div class="subtext">Trip not found.</div>`; return; }
      const editing = loadDetailsState.editMode === tripLocalId;
      const stops = loadDetailsState.stopsByTrip[tripLocalId] || [];
      const missing = tripMissingFields(trip, row.location);
      const missingKeys = new Set(missing.map((m) => m.key));
      const missCls = (key) => missingKeys.has(key) ? " field-box-missing" : "";
      const banner = trip.checkedIn
        ? `<div class="ld-status-banner ld-status-banner-green">Checked Out</div>`
        : `<div class="ld-status-banner ld-status-banner-red">Not Checked Out${missing.length ? ` — missing: ${missing.map((m) => m.label).join(", ")}` : ""}</div>`;
      const returnTime = trip.returnEtaToDc || trip.returnToDC || "";

      if (!editing) {
        const tripDrv = trip.driverId ? findDriver(trip.driverId) : null;
        const stopsHtml = stops.length
          ? stops.map((s) => `<div class="ld-stop-row"><span>Stop ${s.stopNumber}</span><span>In: ${escapeHtml(s.timeIn || "—")}</span><span>Out: ${escapeHtml(s.timeOut || "—")}</span></div>`).join("")
          : `<div class="subtext">No stop times recorded yet.</div>`;
        body.innerHTML = `
          ${banner}
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
            <fieldset class="field-box${missCls("stops")}" style="grid-column: span 2;">
              <legend>Stop In/Out Times</legend>
              <div class="ld-stop-row" style="font-weight:700;"><span>Dispatch Time</span><span>${escapeHtml(trip.dispatchTime || "—")}</span><span></span></div>
              ${stopsHtml}
              <div class="ld-stop-row" style="font-weight:700; border-top:1px solid var(--line); margin-top:4px; padding-top:4px;"><span>Return to DC</span><span>${escapeHtml(returnTime || "—")}</span><span></span></div>
            </fieldset>
            <fieldset class="field-box"><legend>Complete</legend><div class="static-text">${trip.complete ? "Yes" : "—"}</div></fieldset>
            <fieldset class="field-box${missCls("ppwk")}"><legend>Paperwork Received</legend><div class="static-text">${trip.ppwkReceived ? "Yes" : "—"}</div></fieldset>
            <fieldset class="field-box${missCls("checkedIn")}"><legend>Load Checked In</legend><div class="static-text">${trip.checkedIn ? "Yes" : "—"}</div></fieldset>
            <fieldset class="field-box${missCls("dropLocation")}"><legend>Trailer Drop Location</legend><div class="static-text">${escapeHtml(trip.returnDropLocation || "—")}</div></fieldset>
            <fieldset class="field-box${missCls("image")}" style="grid-column: span 2;"><legend>Image</legend>${rowImageDropzoneHtml(trip, trip.id)}</fieldset>
          </div>
        `;
      } else {
        const d = loadDetailsState.editDraft;
        const stopCount = Math.max(0, parseInt(d.stopCount, 10) || 0);
        body.innerHTML = `
          ${banner}
          <div class="field-box-grid">
            <fieldset class="field-box"><legend>Route ID</legend><input class="cell-input" id="ld-tr-routeId" value="${escapeHtml(d.routeId)}"></fieldset>
            <fieldset class="field-box"><legend>Trip ID</legend><input class="cell-input" id="ld-tr-tripId" value="${escapeHtml(d.tripId)}"></fieldset>
            <fieldset class="field-box"><legend>Trailer #</legend><input class="cell-input" id="ld-tr-trailerOut" value="${escapeHtml(d.trailerOut)}"></fieldset>
            <fieldset class="field-box"><legend>Route Miles</legend><input class="cell-input" id="ld-tr-routeMiles" value="${escapeHtml(d.routeMiles)}"></fieldset>
            <fieldset class="field-box"><legend>Stops</legend><input class="cell-input" id="ld-tr-stopCount" value="${escapeHtml(d.stopCount)}"></fieldset>
            <fieldset class="field-box"><legend>Reassign Driver</legend><input class="cell-input" id="ld-tr-driver" data-driver-ac="true" value="${escapeHtml(d.driverName)}"><div class="subtext" style="margin-top:4px;">Leave blank to keep the load's driver</div></fieldset>
            <fieldset class="field-box" style="grid-column: span 2;"><legend>Notes on this route</legend><textarea class="cell-input" id="ld-tr-notes" rows="3" style="width:100%;">${escapeHtml(d.notes)}</textarea></fieldset>
            <fieldset class="field-box${missCls("stops")}" style="grid-column: span 2;">
              <legend>Stop In/Out Times</legend>
              <div class="ld-stop-row" style="font-weight:700;"><span>Dispatch Time</span><input class="cell-input" id="ld-tr-dispatch-time" placeholder="--:--" value="${escapeHtml(d.dispatchTime)}" style="max-width:90px;"><span></span></div>
              <div id="ld-stop-fields">${stopFieldsHtml(stopCount, d.stops)}</div>
              <div class="ld-stop-row" style="font-weight:700; border-top:1px solid var(--line); margin-top:4px; padding-top:4px;"><span>Return to DC</span><input class="cell-input" id="ld-tr-return-eta" placeholder="${escapeHtml(trip.returnToDC || '--:--')}" value="${escapeHtml(d.returnEtaToDc)}" style="max-width:90px;"><span></span></div>
            </fieldset>
            <fieldset class="field-box">
              <legend>Complete</legend>
              <label style="display:flex; align-items:center; gap:8px; margin:0;"><input type="checkbox" id="ld-tr-complete" ${d.complete ? "checked" : ""}><span>Complete</span></label>
            </fieldset>
            <fieldset class="field-box${missCls("ppwk")}">
              <legend>Paperwork Received</legend>
              <label style="display:flex; align-items:center; gap:8px; margin:0;"><input type="checkbox" id="ld-tr-ppwk-received" ${d.ppwkReceived ? "checked" : ""}><span>Received</span></label>
            </fieldset>
            <fieldset class="field-box${missCls("checkedIn")}">
              <legend>Load Checked In</legend>
              <label style="display:flex; align-items:center; gap:8px; margin:0;"><input type="checkbox" id="ld-tr-checked-in" ${d.checkedIn ? "checked" : ""}><span>Checked In</span></label>
            </fieldset>
            <fieldset class="field-box${missCls("dropLocation")}"><legend>Trailer Drop Location</legend><input class="cell-input" id="ld-tr-drop-location" placeholder="Where was the trailer dropped?" value="${escapeHtml(d.returnDropLocation)}"></fieldset>
            <fieldset class="field-box${missCls("image")}" style="grid-column: span 2;"><legend>Image</legend>${rowImageDropzoneHtml(trip, trip.id)}</fieldset>
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
        <div class="ld-edit-bar"><button type="button" class="btn btn-ghost" id="ld-hist-notes-save-all">Save Notes</button></div>
        <div class="ld-history-row" style="grid-template-columns: 130px 110px 1fr 200px;"><div>When</div><div>By</div><div>What</div><div>Note</div></div>
        ${rows.length ? rows.map((h) => `
          <div class="ld-history-row" style="grid-template-columns: 130px 110px 1fr 200px; align-items:start;">
            <div>${new Date(h.changed_at).toLocaleString()}</div>
            <div>${escapeHtml(h.changed_by || "Unknown user")}</div>
            <div>${formatChangeHistoryEntry(h.field_name, h.old_value, h.new_value)}</div>
            <div><input type="text" class="cell-input" style="width:100%;" data-hist-note-id="${h.id}" value="${escapeHtml(h.note || "")}" placeholder="Why was this changed?"></div>
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
    } else {
      const trip = row.trips.find((t) => t.id === tabKey);
      const tripDrv = trip.driverId ? findDriver(trip.driverId) : null;
      loadDetailsState.editDraft = {
        routeId: trip.routeId || "", tripId: trip.tripId || "", trailerOut: trip.trailerOut || "",
        routeMiles: trip.routeMiles || "", stopCount: trip.stopCount || "",
        driverName: tripDrv ? tripDrv.name : "", notes: trip.notes || "",
        stops: (loadDetailsState.stopsByTrip[tabKey] || []).map((s) => ({ ...s })),
        complete: !!trip.complete, ppwkReceived: !!trip.ppwkReceived, checkedIn: !!trip.checkedIn,
        returnDropLocation: trip.returnDropLocation || "",
        dispatchTime: trip.dispatchTime || "", returnEtaToDc: trip.returnEtaToDc || "",
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
      before != null ? String(before) : null,
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
    if (before !== row.rate) logChange(row.dbId, labelForRow(row), "carrier_rate_manual", before, row.rate);
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

  export async function saveLoadDetailsEdit(tabKey, markComplete) {
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
      const timesheetReceivedEl = $("#ld-ov-timesheet-received");
      if (timesheetReceivedEl) {
        const wasTimesheetReceived = row.timesheetReceived;
        row.timesheetReceived = timesheetReceivedEl.checked;
        row.timesheetStartTime = $("#ld-ov-timesheet-start").value.trim();
        row.timesheetEndTime = $("#ld-ov-timesheet-end").value.trim();
        if (!wasTimesheetReceived && row.timesheetReceived) logChange(row.dbId, labelForRow(row), "timesheet_received", "false", "true");
      }
      await saveShiftNow(row);
      // Time sheet start+end both filled in is one of the three auto-send
      // triggers on its own now — no longer forces shift_complete, and no
      // longer gated on open trips: that "is this really done" concern is
      // handled by the warning the Accounting page shows on open instead.
      await maybeSendToAccounting(row);
    } else {
      const trip = row.trips.find((t) => t.id === tabKey);
      if (!trip) return;
      const beforeRouteId = trip.routeId;
      const beforeTrailerOut = trip.trailerOut;
      const beforeTripDriver = trip.driverId ? findDriver(trip.driverId) : null;
      const beforeTripDriverName = beforeTripDriver ? beforeTripDriver.name : "";
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
      const ppwkEl = $("#ld-tr-ppwk-received");
      const beforePpwkReceived = trip.ppwkReceived;
      if (ppwkEl) trip.ppwkReceived = ppwkEl.checked;
      const checkedInEl = $("#ld-tr-checked-in");
      if (checkedInEl) trip.checkedIn = checkedInEl.checked;
      const dropLocEl = $("#ld-tr-drop-location");
      if (dropLocEl) trip.returnDropLocation = dropLocEl.value.trim();
      const dispatchTimeEl = $("#ld-tr-dispatch-time");
      if (dispatchTimeEl) trip.dispatchTime = dispatchTimeEl.value.trim();
      const returnEtaEl = $("#ld-tr-return-eta");
      if (returnEtaEl) trip.returnEtaToDc = returnEtaEl.value.trim();
      const completeEl = $("#ld-tr-complete");
      const beforeComplete = trip.complete;
      if (completeEl) {
        trip.complete = completeEl.checked;
        trip.minimized = completeEl.checked; // pill on the board vs. fully laid out — same toggle now
        if (trip.complete && !beforeComplete) trip.completedAt = new Date().toISOString();
        if (!trip.complete) trip.completedAt = null;
        if (!trip.complete && row.shiftComplete) {
          // Un-completing a trip that belonged to an already-completed
          // shift needs to walk the shift back too — otherwise it'd stay
          // tinted/sorted as done while this trip is now sitting open again.
          row.shiftComplete = false;
          row.shiftCompleteAt = null;
          await saveShiftNow(row);
        }
      }
      await saveTripNow(row, trip, row.trips.indexOf(trip) + 1);
      recomputeRowRate(row);

      if (beforeRouteId !== trip.routeId) logChange(row.dbId, labelForRow(row), "route_id", beforeRouteId, trip.routeId);
      if (beforeTrailerOut !== trip.trailerOut) logChange(row.dbId, labelForRow(row), "trailer_out", beforeTrailerOut, trip.trailerOut);
      if (driverNameVal && beforeTripDriverName.toLowerCase() !== driverNameVal.toLowerCase()) {
        logChange(row.dbId, `${labelForRow(row)} — ${trip.routeId || trip.tripId || "route"}`, "driver_reassigned", beforeTripDriverName, driverNameVal);
      }
      if (beforePpwkReceived !== trip.ppwkReceived) logChange(row.dbId, `${labelForRow(row)} — ${trip.routeId || trip.tripId || "route"}`, "ppwk_received", beforePpwkReceived, trip.ppwkReceived);
      if (beforeComplete !== trip.complete) logChange(row.dbId, `${labelForRow(row)} — ${trip.routeId || trip.tripId || "route"}`, "route_complete", beforeComplete, trip.complete);

      // Same auto-send gate as the Overview tab — covers the case where the
      // time sheet was already filled in before this was the last trip to
      // close out, so it doesn't matter which of the two happened last.
      await maybeSendToAccounting(row);

      const stopCount = Math.max(0, parseInt(trip.stopCount, 10) || 0);
      const newStops = [];
      for (let i = 0; i < stopCount; i++) {
        const timeIn = document.querySelector(`[data-stop-field="timeIn"][data-stop-index="${i}"]`);
        const timeOut = document.querySelector(`[data-stop-field="timeOut"][data-stop-index="${i}"]`);
        newStops.push({ stopNumber: i + 1, timeIn: timeIn ? timeIn.value.trim() : "", timeOut: timeOut ? timeOut.value.trim() : "" });
      }
      if (supabaseClient && trip.dbId) {
        trip.hasStopTimes = false;
        try {
          for (const s of newStops) {
            const existing = (loadDetailsState.stopsByTrip[tabKey] || []).find((x) => x.stopNumber === s.stopNumber);
            const hasTime = !!(s.timeIn || s.timeOut);
            if (!hasTime && !existing) continue; // nothing entered and no prior record — don't create an empty one
            const payload = { trip_id: trip.dbId, stop_number: s.stopNumber, time_in: s.timeIn || null, time_out: s.timeOut || null };
            if (existing && existing.dbId) {
              await supabaseClient.from("trip_stops").update(payload).eq("id", existing.dbId); // still update even if now blank, in case times were cleared out
            } else {
              await supabaseClient.from("trip_stops").insert(payload);
            }
            if (hasTime) trip.hasStopTimes = true;
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
      <div class="columns-panel-footer">
        <button type="button" id="columns-show-all">Show all columns</button>
        <button type="button" id="columns-reset-order">Reset column order</button>
      </div>
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
  // Companion to setVal — reads a field's value without crashing if that
  // field happens to be missing from whichever page's HTML is actually
  // loaded (this has bitten submitDriverForm more than once now, since
  // driver-form fields have shifted around across several HTML rebuilds).
  function getVal(id) { const el = $("#" + id); return el ? el.value : ""; }
  function setText(id, text) { const el = $("#" + id); if (el) el.textContent = text; }

  // Same box style as the Load Details Rate panel, but scoped to one
  // driver's personal rate card instead of one load — every box left
  // blank just means "use the normal Atlanta default for this driver."
  function driverAtlantaRateBoxesHtml(overrides) {
    const tiers = (getBoardRateTiers() && getBoardRateTiers().atlanta) || [];
    const ov = overrides || { tiers: {}, settings: {} };
    const overMax = tiers.length ? tiers[tiers.length - 1].max : 187;
    const box = (label, inputHtml) => `<fieldset class="rate-tier-box"><legend>${label}</legend>${inputHtml}</fieldset>`;
    return `
      <div class="rate-tier-grid" style="grid-template-columns: repeat(2, 1fr);">
        ${tiers.map((t) => box(`${t.min}-${t.max}MI`, `<input type="number" step="0.01" data-dr-tier-id="${t.id}" value="${ov.tiers[t.id] ?? ""}" placeholder="default">`)).join("")}
        ${box(`Over ${overMax}MI ($/mi)`, `<input type="number" step="0.01" data-dr-setting-key="over_tier_per_mile" value="${ov.settings.over_tier_per_mile ?? ""}" placeholder="default">`)}
        ${box("Stops", `<input type="number" step="1" data-dr-setting-key="stop_charge_free_stops" value="${ov.settings.stop_charge_free_stops ?? ""}" placeholder="default">`)}
        ${box("$/extra stop", `<input type="number" step="0.01" data-dr-setting-key="stop_charge_per_stop" value="${ov.settings.stop_charge_per_stop ?? ""}" placeholder="default">`)}
        ${box("TONU flat", `<input type="number" step="0.01" data-dr-setting-key="tonu_flat" value="${ov.settings.tonu_flat ?? ""}" placeholder="default">`)}
      </div>`;
  }

  function updateAtlantaRateSectionVisibility() {
    const section = $("#ad-atlanta-rate-section");
    if (!section) return;
    const atlantaChecked = $('input[name="ad-runs-out-of"][value="atlanta"]');
    section.classList.toggle("hidden", !(atlantaChecked && atlantaChecked.checked));
  }

  function readAtlantaRateOverridesFromForm() {
    const section = $("#ad-atlanta-rate-section");
    if (!section) return null;
    const overrides = { tiers: {}, settings: {} };
    $all("[data-dr-tier-id]", section).forEach((el) => {
      const v = el.value.trim();
      if (v !== "") overrides.tiers[el.dataset.drTierId] = Number(v);
    });
    $all("[data-dr-setting-key]", section).forEach((el) => {
      const v = el.value.trim();
      if (v !== "") overrides.settings[el.dataset.drSettingKey] = Number(v);
    });
    return (Object.keys(overrides.tiers).length || Object.keys(overrides.settings).length) ? overrides : null;
  }


  export function openAddDriverModal(nestedFromLoad) {
    const modalEl = $("#modal-add-driver");
    if (!modalEl) { console.error('openAddDriverModal: #modal-add-driver not found on this page.'); return; }
    state.addDriverNestedFromLoad = !!nestedFromLoad;
    state.editingDriverId = null;
    driverProfileState = null; // no driver yet — nothing to show history/notes for
    modalEl.classList.remove("hidden"); // open first — a missing field below should never block this
    const tabStrip = $("#ad-modal-tabs");
    if (tabStrip) tabStrip.classList.add("hidden");
    const editEl = $("#ad-tab-edit"); if (editEl) editEl.classList.remove("hidden");
    const historyEl = $("#ad-tab-history"); if (historyEl) historyEl.classList.add("hidden");
    const notesEl = $("#ad-tab-notes"); if (notesEl) notesEl.classList.add("hidden");
    ["ad-name", "ad-phone", "ad-mc", "ad-dispatcher-phone", "ad-email", "ad-email2", "ad-rating", "ad-preference", "ad-carrier", "ad-rate-booking", "ad-notes", "ad-tii-amount", "ad-rate"]
      .forEach((id) => setVal(id, ""));
    const mcFieldAdd = $("#ad-mc"); if (mcFieldAdd) mcFieldAdd.dataset.lastCheckedMc = "";
    $all('input[name="ad-tia"]', $("#modal-add-driver")).forEach((r) => (r.checked = r.value === "no"));
    const addingFromMondelez = (state.activeLocation || state.driverListTab) === "mondelez";
    $all('input[name="ad-runs-out-of"]').forEach((c) => { c.checked = addingFromMondelez && c.value === "mondelez"; });
    const atlantaBoxes = $("#ad-atlanta-rate-boxes");
    if (atlantaBoxes) atlantaBoxes.innerHTML = driverAtlantaRateBoxesHtml(null);
    updateAtlantaRateSectionVisibility();
    $all(".field", modalEl).forEach((f) => f.classList.remove("has-error"));
    setText("ad-modal-title", "Add Driver");
    setText("ad-submit", "Add");
    const deleteBtn = $("#ad-delete"); if (deleteBtn) deleteBtn.classList.add("hidden");
    const nameEl = $("#ad-name");
    if (nameEl) nameEl.focus();
  }

  export function openEditDriverModal(driverId) {
    const d = findDriver(driverId);
    if (!d) { console.error("openEditDriverModal: no driver found for id", driverId); return; }
    const modalEl = $("#modal-add-driver");
    if (!modalEl) { console.error('openEditDriverModal: #modal-add-driver not found on this page.'); return; }
    state.addDriverNestedFromLoad = false;
    state.editingDriverId = driverId;
    state.editingDriverLocation = d.location || "atlanta";
    driverProfileState = { driverId, activeTab: "edit", history: null, notes: null, rateHistory: null };
    modalEl.classList.remove("hidden"); // open first — a missing field below should never block this
    const tabStrip = $("#ad-modal-tabs");
    if (tabStrip) {
      tabStrip.classList.remove("hidden");
      $all("[data-ad-tab]", tabStrip).forEach((btn) => btn.classList.toggle("is-active", btn.dataset.adTab === "edit"));
    }
    const editEl = $("#ad-tab-edit"); if (editEl) editEl.classList.remove("hidden");
    const historyEl = $("#ad-tab-history"); if (historyEl) historyEl.classList.add("hidden");
    const notesEl = $("#ad-tab-notes"); if (notesEl) notesEl.classList.add("hidden");
    setVal("ad-name", d.name || "");
    setVal("ad-phone", d.phone || "");
    setVal("ad-mc", d.mc || "");
    const mcFieldEdit = $("#ad-mc"); if (mcFieldEdit) mcFieldEdit.dataset.lastCheckedMc = d.mc || "";
    setVal("ad-dispatcher-phone", d.dispatcherPhone || "");
    setVal("ad-email", d.email || "");
    setVal("ad-email2", d.email2 || "");
    setVal("ad-rating", d.rating || "");
    setVal("ad-preference", d.preference || "");
    setVal("ad-carrier", d.carrier || "");
    setVal("ad-rate-booking", d.rateBooking || "");
    setVal("ad-notes", d.notes || "");
    setVal("ad-rate", d.normalRate || "");
    $all('input[name="ad-tia"]', $("#modal-add-driver")).forEach((r) => (r.checked = r.value === (d.tia ? "yes" : "no")));
    setVal("ad-tii-amount", d.tiiAmount != null ? d.tiiAmount : "");
    const runsOutOf = d.runsOutOf || [];
    $all('input[name="ad-runs-out-of"]').forEach((c) => { c.checked = runsOutOf.includes(c.value); });
    const atlantaBoxes = $("#ad-atlanta-rate-boxes");
    if (atlantaBoxes) atlantaBoxes.innerHTML = driverAtlantaRateBoxesHtml(d.atlantaRateOverrides);
    updateAtlantaRateSectionVisibility();
    $all(".field", modalEl).forEach((f) => f.classList.remove("has-error"));
    setText("ad-modal-title", `${d.name} — Driver Profile`);
    setText("ad-submit", "Save");
    const deleteBtn = $("#ad-delete"); if (deleteBtn) deleteBtn.classList.remove("hidden");
    const nameEl = $("#ad-name");
    if (nameEl) nameEl.focus();
  }

  function closeAddDriverModal() {
    $("#modal-add-driver").classList.add("hidden");
    driverProfileState = null;
  }

  async function deleteDriverFromModal() {
    const driverId = state.editingDriverId;
    if (!driverId) return;
    const d = findDriver(driverId);
    if (!d) return;
    if (!confirm(`Delete ${d.name}? This can't be undone, and any load rows still showing their name will fall back to plain text (the assignment itself isn't removed from those loads).`)) return;

    const deleteBtn = $("#ad-delete");
    if (deleteBtn) deleteBtn.disabled = true;
    try {
      if (supabaseClient) {
        const { error } = await supabaseClient.from("atlanta_drivers").delete().eq("id", driverId);
        if (error) throw error;
      }
      const idx = state.drivers.findIndex((x) => x.id === driverId);
      if (idx !== -1) state.drivers.splice(idx, 1);
      closeAddDriverModal();
      refreshDriverDatalist();
      if (currentFile() === "driverlist.html") renderDriverList();
      else if (state.activeLocation) renderBoardTable();
    } catch (e) {
      console.error("deleteDriverFromModal failed:", e);
      setDriverSyncStatus(`Couldn't delete this driver (${e.message || e}).`, "error");
      if (deleteBtn) deleteBtn.disabled = false;
    }
  }

  // The single-value `location` field only makes sense for "atlanta" /
  // "delaware" / "houston" — Building C shares Atlanta's pool, and Mondelez
  // isn't a real driver "home base" at all, it's tracked entirely through
  // the runs_out_of checkboxes instead. Writing "mondelez" here would be
  // meaningless data that driversForLocation("mondelez") wouldn't even look
  // at, since that filters by runs_out_of, not this field.
  function normalizeDriverLocationField(context) {
    if (context === "buildingc" || context === "mondelez") return "atlanta";
    return context || "atlanta";
  }

  // Drivers under the same MC# are typically the same carrier company, so
  // their carrier-level details (email, dispatcher line, contract rate,
  // interchange terms) are usually identical even though they're different
  // people. When adding a new driver, if the MC they just entered already
  // exists on file, pull those fields from that match instead of making the
  // dispatcher re-type the same carrier info every time. Add-mode only
  // (editing an existing driver's own MC shouldn't trigger this), and never
  // overwrites a field the person has already filled in themselves.
  function autofillFromMatchingMC() {
    const mcField = $("#ad-mc");
    const mc = getVal("ad-mc").trim();
    if (!mc) return;
    // don't re-trigger on every blur if the MC hasn't actually changed since
    // the last check -- otherwise re-focusing/blurring this field without
    // editing it would keep stomping on fields the person has since customized
    if (mcField && mcField.dataset.lastCheckedMc === mc) return;
    if (mcField) mcField.dataset.lastCheckedMc = mc;

    const isEdit = !!state.editingDriverId;
    const match = state.drivers.find((d) => (d.mc || "").trim() === mc && d.id !== state.editingDriverId);
    if (!match) return;

    const applyField = (id, val) => {
      const el = $("#" + id);
      if (!el) return;
      if (isEdit) {
        // editing: they're correcting this driver's MC to a known carrier,
        // so adopt that carrier's info wholesale, not just fill gaps
        el.value = val == null ? "" : val;
      } else if (val != null && val !== "" && !el.value.trim()) {
        // adding: only fill genuinely blank fields, never overwrite something typed
        el.value = val;
      }
    };
    applyField("ad-email", match.email);
    applyField("ad-dispatcher-phone", match.dispatcherPhone);
    applyField("ad-rate", match.normalRate);
    applyField("ad-tii-amount", match.tiiAmount);

    const radios = $all('input[name="ad-tia"]', $("#modal-add-driver"));
    const noRadio = radios.find((r) => r.value === "no");
    const yesRadio = radios.find((r) => r.value === "yes");
    if (isEdit) {
      // editing: mirror the match's interchange status exactly, either way
      if (match.tia) { if (yesRadio) yesRadio.checked = true; }
      else if (noRadio) noRadio.checked = true;
    } else if (match.tia && yesRadio && noRadio && noRadio.checked) {
      // adding: radios always have something checked (defaults to "no"), so
      // there's no true "blank" state -- only flip it if still on that
      // default, so a deliberate choice never gets overridden
      yesRadio.checked = true;
    }

    setDriverSyncStatus(`Filled in from ${match.name}'s carrier info (MC ${mc} already on file) — check it over before saving.`, "info");
  }

  async function submitDriverForm() {
    const name = getVal("ad-name").trim();
    const phone = getVal("ad-phone").trim();
    const mc = getVal("ad-mc").trim();
    const email = getVal("ad-email").trim();
    let ok = true;
    [["ad-name", name], ["ad-phone", phone], ["ad-mc", mc]].forEach(([id, val]) => {
      const el = $("#" + id);
      const field = el ? el.closest(".field") : null;
      if (field) field.classList.toggle("has-error", !val);
      if (!val) ok = false;
    });
    if (mc && !/^\d+$/.test(mc)) {
      const mcField = $("#ad-mc");
      if (mcField) mcField.closest(".field").classList.add("has-error");
      ok = false;
    }
    if (!ok) return;

    const isEdit = !!state.editingDriverId;
    const beforeDriver = isEdit ? findDriver(state.editingDriverId) : null;
    const beforeRate = beforeDriver ? beforeDriver.normalRate : null;
    const draft = {
      name, phone, mc, email,
      dispatcherPhone: getVal("ad-dispatcher-phone").trim(),
      email2: getVal("ad-email2").trim(),
      rating: getVal("ad-rating").trim() || null,
      preference: getVal("ad-preference") || null,
      notes: getVal("ad-notes").trim(),
      carrier: getVal("ad-carrier").trim(),
      rateBooking: getVal("ad-rate-booking").trim(),
      tia: ($all('input[name="ad-tia"]', $("#modal-add-driver")).find((r) => r.checked) || {}).value === "yes",
      tiiAmount: getVal("ad-tii-amount").trim() ? Number(getVal("ad-tii-amount")) : null,
      normalRate: getVal("ad-rate").trim() || null,
      runsOutOf: $all('input[name="ad-runs-out-of"]').filter((c) => c.checked).map((c) => c.value),
      atlantaRateOverrides: readAtlantaRateOverridesFromForm(),
      location: isEdit ? state.editingDriverLocation : normalizeDriverLocationField(state.activeLocation || state.driverListTab),
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
      if ((beforeRate || "") !== (driver.normalRate || "")) {
        supabaseClient.from(DRIVER_RATE_HISTORY_TABLE).insert({
          driver_id: Number(driver.id),
          old_rate: beforeRate !== "" && beforeRate != null ? Number(beforeRate) : null,
          new_rate: driver.normalRate !== "" && driver.normalRate != null ? Number(driver.normalRate) : null,
          changed_by: currentUserLabel || "unknown user",
        }).then(() => {}).catch((e) => console.error("Failed to log driver rate history:", e));
        if (driverProfileState && driverProfileState.driverId === driver.id) driverProfileState.rateHistory = null;
      }
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

  /* ---------------- driver profile modal (History + Notes tabs) ---------------- */

  const DRIVER_NOTES_TABLE = "driver_notes";
  const LOAD_NOTES_TABLE = "load_notes";

  // Auto-logs a committed change to the board's Notes column into the
  // load's permanent notes log. This is the whole point of the two being
  // separate: the board's field stays quick-edit and disposable, but
  // whatever passed through it is preserved here forever — even after
  // it's later changed or cleared from the board itself. Silently skips
  // empty commits, since clearing the field isn't itself a note worth logging.
  async function logBoardNoteToPermanentLog(shiftDbId, noteText) {
    if (!supabaseClient || !shiftDbId || !String(noteText || "").trim()) return;
    try {
      await supabaseClient.from(LOAD_NOTES_TABLE).insert({
        shift_id: shiftDbId, note_text: noteText, source: "board", created_by: currentUserLabel || "unknown user",
      });
    } catch (e) {
      console.error("logBoardNoteToPermanentLog failed:", e);
    }
  }

  // The Load Details modal's own Notes tab — adds directly to the same
  // permanent log (tagged "modal" instead of "board"), but deliberately
  // never touches row.notes/loads_shifts.notes at all, so a note typed
  // here never shows up back on the board's own Notes field.
  async function submitLoadNote() {
    if (!loadDetailsState || !supabaseClient) return;
    const found = findRowAnywhere(loadDetailsState.rowId);
    if (!found || !found.row.dbId) return;
    const input = $("#ld-note-input");
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    const submitBtn = $("#ld-note-submit");
    if (submitBtn) submitBtn.disabled = true;
    try {
      const { data, error } = await supabaseClient.from(LOAD_NOTES_TABLE)
        .insert({ shift_id: found.row.dbId, note_text: text, source: "modal", created_by: currentUserLabel || "unknown user" })
        .select();
      if (error) throw error;
      if (!loadDetailsState.loadNotes) loadDetailsState.loadNotes = [];
      loadDetailsState.loadNotes.push(data[0]);
      input.value = "";
      renderLoadDetailsTabContent();
    } catch (e) {
      console.error("submitLoadNote failed:", e);
      setDriverSyncStatus(`Couldn't save that note (${e.message || e}).`, "error");
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  }

  // Per-entry notes on Change History — a small explanation of WHY a
  // given change happened, attached to that specific entry. Lives on
  // load_change_history itself (keyed by shift_id, same as the rest of
  // that table), so it automatically travels with the load into
  // Accounting too — that page opens this exact same modal/tab, it isn't
  // a separate view that would need its own copy of this data.
  //
  // Every row has its own always-editable field; one Save button commits
  // whichever ones actually changed. Rows whose text matches what's
  // already stored are skipped entirely, rather than re-writing every
  // row on every save regardless of whether it changed.
  async function saveAllHistoryNotes() {
    if (!loadDetailsState || !supabaseClient) return;
    const inputs = $all("[data-hist-note-id]");
    const saveBtn = $("#ld-hist-notes-save-all");
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = "Saving…"; }
    let anyFailed = false;
    for (const input of inputs) {
      const historyId = Number(input.dataset.histNoteId);
      const entry = loadDetailsState.history.find((h) => h.id === historyId);
      const newText = input.value.trim();
      const currentText = (entry && entry.note) || "";
      if (newText === currentText) continue; // unchanged — skip the redundant write
      try {
        const { error } = await supabaseClient.from("load_change_history").update({ note: newText || null }).eq("id", historyId);
        if (error) throw error;
        if (entry) entry.note = newText || null;
      } catch (e) {
        console.error("saveAllHistoryNotes failed for entry", historyId, e);
        anyFailed = true;
      }
    }
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = "Save Notes"; }
    setDriverSyncStatus(anyFailed ? "Some notes couldn't be saved — check the console for details." : "Notes saved.", anyFailed ? "error" : "success");
  }
  let driverProfileState = null; // { driverId, activeTab, history: null|[], notes: null|[] }

  // Pulls this driver's past PRO#/Aljex# across every board they could
  // have run — loads_shifts covers Atlanta/Delaware/Building C,
  // loads_houston and mondelez_loads cover those separately since they're
  // their own tables. Merged and sorted newest-first.
  async function loadDriverProfileHistory(driverId) {
    if (!supabaseClient) return [];
    const idNum = Number(driverId);
    const [shiftsRes, houstonRes, mondelezRes] = await Promise.all([
      supabaseClient.from(SHIFTS_TABLE).select("id, pro_number, shift_date, location").eq("driver_id", idNum).order("shift_date", { ascending: false }).limit(50),
      supabaseClient.from("loads_houston").select("id, aljex_number, shift_date").eq("driver_id", idNum).order("shift_date", { ascending: false }).limit(50),
      supabaseClient.from("mondelez_loads").select("id, aljex_number, shift_date, location").eq("driver_id", idNum).order("shift_date", { ascending: false }).limit(50),
    ]);
    const entries = [];
    // dbId/kind let the History tab render a clickable link straight to the
    // load (see openLoadFromDriverHistory) — Houston/Mondelez are included
    // in the list either way, but only "shift" entries are clickable for now.
    (shiftsRes.data || []).forEach((r) => entries.push({ label: r.pro_number || "(no PRO#)", date: r.shift_date, board: r.location || "board", dbId: r.id, kind: "shift" }));
    (houstonRes.data || []).forEach((r) => entries.push({ label: r.aljex_number || "(no Aljex#)", date: r.shift_date, board: "houston", dbId: r.id, kind: "houston" }));
    (mondelezRes.data || []).forEach((r) => entries.push({ label: r.aljex_number || "(no Aljex#)", date: r.shift_date, board: `mondelez — ${r.location}`, dbId: r.id, kind: "mondelez" }));
    entries.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
    return entries;
  }

  // Newest-first log of rate changes for a driver's own "usual rate"
  // (normal_rate), separate from load_change_history since those entries
  // are scoped to a load, not a driver. Populated by submitDriverForm
  // whenever normalRate changes on an edit.
  const DRIVER_RATE_HISTORY_TABLE = "driver_rate_history";
  async function loadDriverRateHistory(driverId) {
    if (!supabaseClient) return [];
    const { data, error } = await supabaseClient.from(DRIVER_RATE_HISTORY_TABLE).select("*").eq("driver_id", Number(driverId)).order("changed_at", { ascending: false });
    if (error) { console.error("Failed to load driver rate history:", error); return []; }
    return data || [];
  }

  async function loadDriverProfileNotes(driverId) {
    if (!supabaseClient) return [];
    const { data, error } = await supabaseClient.from(DRIVER_NOTES_TABLE).select("*").eq("driver_id", Number(driverId)).order("created_at", { ascending: false });
    if (error) { console.error("Failed to load driver notes:", error); return []; }
    return data || [];
  }

  // Manages the three tabs inside #modal-add-driver when editing an
  // existing driver: Edit (the form itself), History, Notes. Adding a
  // brand new driver skips all this — driverProfileState stays null and
  // the tab strip is hidden, since there's nothing to show history/notes
  // for yet.
  function switchAddDriverTab(tab) {
    if (!driverProfileState) return;
    driverProfileState.activeTab = tab;
    $all("[data-ad-tab]").forEach((btn) => btn.classList.toggle("is-active", btn.dataset.adTab === tab));
    const editEl = $("#ad-tab-edit");
    const historyEl = $("#ad-tab-history");
    const notesEl = $("#ad-tab-notes");
    if (editEl) editEl.classList.toggle("hidden", tab !== "edit");
    if (historyEl) historyEl.classList.toggle("hidden", tab !== "history");
    if (notesEl) notesEl.classList.toggle("hidden", tab !== "notes");
    if (tab === "history" || tab === "notes") renderAddDriverProfileTabContent();
  }

  async function renderAddDriverProfileTabContent() {
    if (!driverProfileState) return;
    const activeTab = driverProfileState.activeTab;
    const body = activeTab === "history" ? $("#ad-tab-history") : $("#ad-tab-notes");
    if (!body) return;

    if (activeTab === "history") {
      if (driverProfileState.history === null || driverProfileState.rateHistory === null) {
        body.innerHTML = `<div class="subtext">Loading…</div>`;
        const [history, rateHistory] = await Promise.all([
          driverProfileState.history === null ? loadDriverProfileHistory(driverProfileState.driverId) : Promise.resolve(driverProfileState.history),
          driverProfileState.rateHistory === null ? loadDriverRateHistory(driverProfileState.driverId) : Promise.resolve(driverProfileState.rateHistory),
        ]);
        if (!driverProfileState || driverProfileState.activeTab !== "history") return; // closed or switched tabs mid-fetch
        driverProfileState.history = history;
        driverProfileState.rateHistory = rateHistory;
      }
      const rows = driverProfileState.history;
      const rateRows = driverProfileState.rateHistory;
      const pastLoadsHtml = rows.length
        ? `<div class="ld-history-row" style="grid-template-columns: 110px 150px 1fr;"><span>Date</span><span>Board</span><span>PRO# / Load #</span></div>` +
          rows.map((r) => {
            const label = (r.kind === "shift" && r.dbId)
              ? `<button type="button" class="cell-link-btn" style="width:auto; height:auto; padding:2px 8px;" data-open-history-kind="${r.kind}" data-open-history-id="${r.dbId}" title="Open this load">${escapeHtml(r.label)} ↗</button>`
              : escapeHtml(r.label);
            return `<div class="ld-history-row" style="grid-template-columns: 110px 150px 1fr;"><span>${escapeHtml(r.date || "—")}</span><span>${escapeHtml(r.board || "—")}</span><span>${label}</span></div>`;
          }).join("")
        : `<div class="subtext">No past loads on file for this driver yet.</div>`;
      const rateChangesHtml = rateRows.length
        ? `<div class="ld-history-row"><div>When</div><div>By</div><div>Was</div><div>Now</div></div>` +
          rateRows.map((r) => `
            <div class="ld-history-row">
              <div>${new Date(r.changed_at).toLocaleString()}</div>
              <div>${escapeHtml(r.changed_by || "—")}</div>
              <div class="ld-history-old">${r.old_rate != null ? fmtRateMoney(Number(r.old_rate)) : "—"}</div>
              <div class="ld-history-new">${r.new_rate != null ? fmtRateMoney(Number(r.new_rate)) : "—"}</div>
            </div>`).join("")
        : `<div class="subtext">No rate changes on file for this driver yet.</div>`;
      body.innerHTML = `
        <div class="rate-section-subheader" style="margin-top:0;">Past Loads</div>
        ${pastLoadsHtml}
        <div class="rate-section-subheader" style="margin-top:18px;">Rate Changes</div>
        ${rateChangesHtml}
      `;
    } else {
      if (driverProfileState.notes === null) {
        body.innerHTML = `<div class="subtext">Loading…</div>`;
        const notes = await loadDriverProfileNotes(driverProfileState.driverId);
        if (!driverProfileState || driverProfileState.activeTab !== "notes") return;
        driverProfileState.notes = notes;
      }
      const notes = driverProfileState.notes;
      body.innerHTML = `
        <div class="field">
          <label for="dp-note-input">Add a note</label>
          <textarea class="cell-input" id="dp-note-input" rows="2" style="width:100%;" placeholder="e.g. Prefers early shifts, reliable on short notice"></textarea>
          <button type="button" class="btn btn-ghost" id="dp-note-submit" style="margin-top:6px;">Add Note</button>
        </div>
        <div style="margin-top:14px;">
          ${notes.length
            ? notes.map((n) => `<div class="ld-history-row" style="grid-template-columns: 150px 1fr;"><span class="subtext">${escapeHtml(new Date(n.created_at).toLocaleString())}</span><span>${escapeHtml(n.note_text)}</span></div>`).join("")
            : `<div class="subtext">No notes yet.</div>`}
        </div>`;
    }
  }

  async function submitDriverNote() {
    if (!driverProfileState || !supabaseClient) return;
    const input = $("#dp-note-input");
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    const submitBtn = $("#dp-note-submit");
    if (submitBtn) submitBtn.disabled = true;
    try {
      const { data, error } = await supabaseClient.from(DRIVER_NOTES_TABLE)
        .insert({ driver_id: Number(driverProfileState.driverId), note_text: text }).select();
      if (error) throw error;
      if (driverProfileState.notes === null) driverProfileState.notes = [];
      driverProfileState.notes.unshift(data[0]);
      renderAddDriverProfileTabContent();
    } catch (e) {
      console.error("submitDriverNote failed:", e);
      setDriverSyncStatus(`Couldn't save that note (${e.message || e}).`, "error");
    } finally {
      if (submitBtn) submitBtn.disabled = false;
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

  // Keeps the "+ Add Row" button (always the last row) visible after
  // adding — without this, each add pushes it further down and out of
  // view, so it looks like it disappeared.
  function scrollQuickAddIntoView() {
    const btn = document.getElementById("btn-quick-add-row");
    if (btn) btn.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function quickAddBlankRow() {
    const row = blankRow(null, "");
    row.addedAt = Date.now();
    getSheet(state.activeLocation, state.activeDate).push(row);
    renderBoardTable();
    scrollQuickAddIntoView();
    const input = document.querySelector(`#${row.id} input[data-field="driverName"]`);
    if (input) input.focus();
  }

  // "+ Add Time Slots" — lets a dispatcher add a batch of blank rows at
  // once, each pre-filled with a Shift Start time, instead of clicking
  // "+ Add Row" repeatedly. e.g. 5 at 0900, 5 at 1300, 5 at 1400, 5 at 2100.
  function addTimeSlotRowUI(time, count) {
    const container = $("#ats-rows");
    if (!container) return;
    const div = document.createElement("div");
    div.className = "ats-slot-row";
    div.innerHTML = `
      <input class="cell-input" data-ats-time placeholder="--:--" value="${escapeHtml(time || "")}">
      <input class="cell-input" data-ats-count type="number" min="1" placeholder="Count" value="${count || ""}">
      <span class="subtext">rows</span>
      <button type="button" class="ats-remove-btn" title="Remove">&times;</button>
    `;
    div.querySelector(".ats-remove-btn").addEventListener("click", () => div.remove());
    container.appendChild(div);
  }

  function openAddTimeSlotsModal() {
    const container = $("#ats-rows");
    if (!container) return;
    container.innerHTML = "";
    addTimeSlotRowUI("", "5");
    addTimeSlotRowUI("", "5");
    $("#modal-add-time-slots").classList.remove("hidden");
  }

  function closeAddTimeSlotsModal() {
    $("#modal-add-time-slots").classList.add("hidden");
  }

  function submitAddTimeSlots() {
    const slotRows = $all(".ats-slot-row", $("#ats-rows"));
    const newRows = [];
    slotRows.forEach((div) => {
      const time = div.querySelector("[data-ats-time]").value.trim();
      const count = parseInt(div.querySelector("[data-ats-count]").value, 10) || 0;
      if (!time || count <= 0) return;
      for (let i = 0; i < count; i++) {
        const row = blankRow(null, "");
        row.shiftStart = time;
        row.addedAt = Date.now();
        newRows.push(row);
      }
    });
    closeAddTimeSlotsModal();
    if (!newRows.length) return;
    const sheet = getSheet(state.activeLocation, state.activeDate);
    newRows.forEach((r) => sheet.push(r));
    renderBoardTable();
    scrollQuickAddIntoView();
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
    if (driverId) { warnIfDriverAlreadyScheduled(row, driverId); checkDriverComplianceWarning(findDriver(driverId)); }

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
        <input class="cell-input" data-driver-ac="true" placeholder="Type driver name…" data-avail-row="${row.id}" value="${escapeHtml(displayName)}">
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
    table.addEventListener("keydown", (e) => handleRowAwareTab(e, "#available-table"));
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
      if (t.dataset.driverAc === "true") updateDriverAutocomplete(t, state.activeLocation);
    });
    table.addEventListener("focusin", (e) => {
      const t = e.target;
      if (!(t.dataset && t.dataset.availRow && t.dataset.driverAc === "true")) return;
      const rowId = t.dataset.availRow;
      openDriverAutocomplete(t, state.activeLocation, (drv) => {
        t.value = drv.name;
        const row = getAvailableSheet(state.activeLocation, state.activeDate).find((r) => r.id === rowId);
        if (row) {
          row.driverName = drv.name;
          row.driverId = drv.id;
          scheduleAvailableRowSave(row, state.activeLocation, state.activeDate);
        }
      });
    });
    table.addEventListener("focusout", (e) => {
      const t = e.target;
      if (!t.dataset.availRow) return;
      if (t.dataset.driverAc === "true") closeDriverAutocomplete();
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
      on("ad-delete", "click", deleteDriverFromModal);
      on("modal-add-driver", "click", (e) => { if (e.target.id === "modal-add-driver") closeAddDriverModal(); });
      const mcField = $("#ad-mc");
      if (mcField) mcField.addEventListener("blur", autofillFromMatchingMC);
      const atlantaRunsCheckbox = $('input[name="ad-runs-out-of"][value="atlanta"]');
      if (atlantaRunsCheckbox) atlantaRunsCheckbox.addEventListener("change", updateAtlantaRateSectionVisibility);
      $all("[data-ad-tab]").forEach((btn) => btn.addEventListener("click", () => switchAddDriverTab(btn.dataset.adTab)));
      const historyEl = $("#ad-tab-history");
      if (historyEl) historyEl.addEventListener("click", (e) => {
        if (e.target.id === "dp-note-submit") submitDriverNote();
        const openBtn = e.target.closest("[data-open-history-kind]");
        if (openBtn) openLoadFromDriverHistory(openBtn.dataset.openHistoryKind, openBtn.dataset.openHistoryId);
      });
      const notesEl = $("#ad-tab-notes");
      if (notesEl) notesEl.addEventListener("click", (e) => { if (e.target.id === "dp-note-submit") submitDriverNote(); });
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
    if ($("#modal-add-time-slots")) {
      on("ats-close", "click", closeAddTimeSlotsModal);
      on("ats-cancel", "click", closeAddTimeSlotsModal);
      on("ats-submit", "click", submitAddTimeSlots);
      on("ats-add-slot-row", "click", () => addTimeSlotRowUI("", "5"));
      $("#modal-add-time-slots").addEventListener("click", (e) => { if (e.target.id === "modal-add-time-slots") closeAddTimeSlotsModal(); });
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
        if (e.target.id === "ld-note-submit") submitLoadNote();
        if (e.target.id === "ld-hist-notes-save-all") saveAllHistoryNotes();
        const profileBtn = e.target.closest('[data-action="edit-driver"]');
        if (profileBtn) openEditDriverModal(profileBtn.dataset.driverId);
        const linkBtn = e.target.closest('[data-action="link-driver"]');
        if (linkBtn) {
          const found = loadDetailsState ? findRowAnywhere(loadDetailsState.rowId) : null;
          const row = found ? found.row : null;
          const nameVal = (row && row.driverNameText || "").trim().toLowerCase();
          const match = nameVal ? driversForLocation(row.location || state.activeLocation || "atlanta").find((d) => d.name.trim().toLowerCase() === nameVal) : null;
          if (match) {
            // Exact match already exists — link it for real (persists to
            // the database, same as picking it from the autocomplete
            // would) and go straight to the profile, no detour through
            // edit mode needed when there's nothing actually ambiguous.
            row.driverId = match.id;
            saveShiftNow(row);
            renderLoadDetailsTabContent();
            openEditDriverModal(match.id);
          } else {
            // Genuinely no match — drop into edit mode with the field
            // focused so the autocomplete can help find or confirm one.
            startLoadDetailsEdit("overview");
            requestAnimationFrame(() => { const input = $("#ld-ov-driver"); if (input) input.focus(); });
          }
        }
      });
      $("#ld-tab-content").addEventListener("input", (e) => {
        if (e.target.id === "ld-tr-stopCount" && loadDetailsState && loadDetailsState.editDraft) {
          loadDetailsState.editDraft.stopCount = e.target.value;
          const container = $("#ld-stop-fields");
          if (container) container.innerHTML = stopFieldsHtml(Math.max(0, parseInt(e.target.value, 10) || 0), loadDetailsState.editDraft.stops);
        }
        if (e.target.id === "ld-ov-driver" || e.target.id === "ld-tr-driver") {
          updateDriverAutocomplete(e.target, state.activeLocation);
        }
      });
      $("#ld-tab-content").addEventListener("focusin", (e) => {
        if (e.target.id !== "ld-ov-driver" && e.target.id !== "ld-tr-driver") return;
        const input = e.target;
        // these two fields are part of an edit draft committed via the modal's
        // own Save button, not saved on every keystroke -- so picking a name
        // here just fills the field in, same as typing it out by hand would
        openDriverAutocomplete(input, state.activeLocation, (drv) => { input.value = drv.name; });
      });
      $("#ld-tab-content").addEventListener("focusout", (e) => {
        if (e.target.id === "ld-ov-driver" || e.target.id === "ld-tr-driver") closeDriverAutocomplete();
      });
      wireRowImageDropzone(
        $("#ld-tab-content"),
        (id) => { const f = findTripAnywhere(id); return f ? f.trip : null; },
        (trip) => { const f = findTripAnywhere(trip.id); return f ? saveTripNow(f.row, f.trip, f.tripNumber) : Promise.resolve(); },
        () => { renderBoardTable(); renderLoadDetailsTabContent(); },
        (trip) => trip.routeId || trip.tripId || ""
      );
    }
  }

  function initBoardPage(info) {
    state.activeLocation = info.key;
    loadAndRenderBoard();
    setupRealtimeSync(info.key);
    loadDatesWithData(info.key).catch((e) => console.error("loadDatesWithData() failed:", e));
    initAvailableSection();
    if (info.key === "atlanta") injectAtlantaRateSettingsButton();

    if ($("#modal-location-notes")) {
      on("btn-page-info", "click", () => openLocationNotesModal(info.key, info.label));
      on("ln-close", "click", closeLocationNotesModal);
      on("ln-cancel", "click", closeLocationNotesModal);
      on("ln-save", "click", saveLocationNotes);
      $("#modal-location-notes").addEventListener("click", (e) => { if (e.target.id === "modal-location-notes") closeLocationNotesModal(); });
    }

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
      const ppwkUpload = $("#st-ppwk-upload");
      if (ppwkUpload) ppwkUpload.addEventListener("change", (e) => { if (e.target.files && e.target.files[0]) uploadPaperworkImage(e.target.files[0]); });
      const ppwkDropzone = $("#st-ppwk-dropzone");
      if (ppwkDropzone) {
        ppwkDropzone.addEventListener("click", (e) => {
          if (e.target.tagName !== "INPUT") ppwkUpload.click();
        });
        ppwkDropzone.addEventListener("dragover", (e) => { e.preventDefault(); ppwkDropzone.classList.add("mdz-dropzone-active"); });
        ppwkDropzone.addEventListener("dragleave", () => ppwkDropzone.classList.remove("mdz-dropzone-active"));
        ppwkDropzone.addEventListener("drop", (e) => {
          e.preventDefault();
          ppwkDropzone.classList.remove("mdz-dropzone-active");
          const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
          if (file && file.type.startsWith("image/")) uploadPaperworkImage(file);
        });
        ppwkDropzone.addEventListener("paste", (e) => {
          const items = e.clipboardData && e.clipboardData.items;
          if (!items) return;
          for (const item of items) {
            if (item.type.startsWith("image/")) {
              e.preventDefault();
              const file = item.getAsFile();
              if (file) uploadPaperworkImage(file);
              break;
            }
          }
        });
      }
      wireRowImageDropzone(
        $("#modal-stop-times"),
        (id) => { const f = findTripAnywhere(id); return f ? f.trip : null; },
        (trip) => { const f = findTripAnywhere(trip.id); return f ? saveTripNow(f.row, f.trip, f.tripNumber) : Promise.resolve(); },
        () => {
          renderBoardTable(); // updates the pill underneath
          if (stopTimesModalState && $("#st-image-slot")) {
            const f = findTripAnywhere(stopTimesModalState.tripId);
            if (f) $("#st-image-slot").innerHTML = rowImageDropzoneHtml(f.trip, f.trip.id);
          }
        },
        (trip) => trip.routeId || trip.tripId || ""
      );
    }

    if ($("#modal-timesheet-complete")) {
      on("tsc-close", "click", skipTimesheetModal);
      on("tsc-cancel", "click", skipTimesheetModal);
      on("tsc-confirm", "click", submitTimesheetModal);
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
        if (e.target.id === "columns-reset-order") {
          tripColOrder = TRIP_SUBCOLS.map((c) => c.key);
          saveTripColOrder();
          renderBoardTable();
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
    boardTable.addEventListener("focusin", handleRowFocusIn);
    boardTable.addEventListener("focusout", handleRowFocusOut);
    boardTable.addEventListener("keydown", (e) => handleRowAwareTab(e, "#board-table"));
    wireRowImageDropzone(
      boardTable,
      (id) => { const found = findTripAnywhere(id); return found ? found.trip : null; },
      (trip) => { const found = findTripAnywhere(trip.id); return found ? saveTripNow(found.row, found.trip, found.tripNumber) : Promise.resolve(); },
      renderBoardTable,
      (trip) => trip.routeId || trip.tripId || ""
    );
    boardTable.addEventListener("click", (e) => {
      const sortHeader = e.target.closest("th[data-board-sort]");
      if (sortHeader) {
        const key = sortHeader.dataset.boardSort;
        state.boardSort = state.boardSort.key === key
          ? { key, dir: state.boardSort.dir === "asc" ? "desc" : "asc" }
          : { key, dir: "asc" };
        renderBoardTable();
        return;
      }
      const textBtn = e.target.closest('[data-action="text-driver"]');
      if (textBtn) textDriverForRow(textBtn.dataset.row);
      if (e.target.closest("#btn-quick-add-row")) quickAddBlankRow();
      if (e.target.closest("#btn-add-time-slots")) openAddTimeSlotsModal();
      const minimizeBtn = e.target.closest('[data-action="minimize-trip"]');
      if (minimizeBtn) minimizeTrip(minimizeBtn.dataset.row, minimizeBtn.dataset.trip);
      const restoreBtn = e.target.closest('[data-action="restore-trip"]');
      if (restoreBtn) restoreTrip(restoreBtn.dataset.row, restoreBtn.dataset.trip);
      const addTripBtn = e.target.closest('[data-action="add-trip"]');
      if (addTripBtn) addNewTrip(addTripBtn.dataset.row);
      const completeBtn = e.target.closest('[data-action="complete-trip"]');
      if (completeBtn && !completeBtn.disabled) completeTrip(completeBtn.dataset.row, completeBtn.dataset.trip);
      const deleteTripBtn = e.target.closest('[data-action="delete-trip"]');
      if (deleteTripBtn) deleteTrip(deleteTripBtn.dataset.row, deleteTripBtn.dataset.trip);
      const openProBtn = e.target.closest('[data-open-pro]');
      if (openProBtn) openLoadDetailsModal(openProBtn.dataset.openPro, openProBtn.dataset.trip || null);
    });
    boardTable.addEventListener("focusin", (e) => {
      const field = e.target.dataset && e.target.dataset.field;
      const rowId = e.target.dataset && e.target.dataset.row;
      const tripId = e.target.dataset && e.target.dataset.trip;
      if (!rowId) return;
      if (tripId && (field === "routeId" || field === "trailerOut")) {
        focusValueSnapshots.set(`${rowId}:${tripId}:${field}`, e.target.value);
      } else if (!tripId && (field === "notes" || field === "driverName" || field === "rate")) {
        focusValueSnapshots.set(`${rowId}:${field}`, e.target.value);
      }
      if (field === "driverName" && e.target.dataset.driverAc === "true") {
        const input = e.target;
        openDriverAutocomplete(input, state.activeLocation, (drv) => {
          input.value = drv.name;
          const found = findRowAnywhere(rowId);
          if (found) {
            found.row.driverNameText = drv.name;
            found.row.driverId = drv.id;
            updateDriverLinkedCellsInPlace(rowId);
            scheduleShiftSave(found.row);
            warnIfDriverAlreadyScheduled(found.row, drv.id);
            checkDriverComplianceWarning(drv);
          }
        });
      }
    });
    boardTable.addEventListener("focusout", (e) => {
      const t = e.target;
      if (t.dataset && t.dataset.driverAc === "true") closeDriverAutocomplete();
      const field = t.dataset && t.dataset.field;
      const rowId = t.dataset && t.dataset.row;
      const tripId = t.dataset && t.dataset.trip;

      // Trip-level route_id / trailer_out — tracked separately since they're
      // keyed by trip, not just row.
      if (rowId && tripId && (field === "routeId" || field === "trailerOut")) {
        const snapKey = `${rowId}:${tripId}:${field}`;
        const before = focusValueSnapshots.get(snapKey);
        focusValueSnapshots.delete(snapKey);
        if (before !== undefined && before !== t.value) {
          const foundTrip = findTripAnywhere(tripId);
          if (foundTrip) {
            logChange(foundTrip.row.dbId, labelForRow(foundTrip.row), field === "routeId" ? "route_id" : "trailer_out", before, t.value);
          }
        }
      }

      if (rowId && !tripId && (field === "notes" || field === "driverName" || field === "rate")) {
        const snapKey = `${rowId}:${field}`;
        const before = focusValueSnapshots.get(snapKey);
        focusValueSnapshots.delete(snapKey);
        if (before !== undefined && before !== t.value) {
          const found = findRowAnywhere(rowId);
          if (found) {
            if (field === "notes") {
              // Notes get tracked in their own permanent log (the Notes
              // tab) exclusively now — not duplicated into Change History.
              logBoardNoteToPermanentLog(found.row.dbId, t.value);
            } else if (field === "rate") {
              // A manual entry directly into the board's Rate cell — kept
              // distinct from the Load Details Rate panel's own override
              // (also logged as "carrier_rate_manual" there, via
              // commitRateOverride) so both entry points are traceable.
              logChange(found.row.dbId, labelForRow(found.row), "carrier_rate_manual", before, t.value);
            } else if (before.trim()) {
              // driverName: only a REASSIGNMENT if it already had a driver — first-time entry isn't logged as a change
              logChange(found.row.dbId, labelForRow(found.row), "driver_reassigned", before, t.value);
            }
            if (field === "driverName") {
              // Both driver-assignment warnings run here — once, on
              // commit, using the FINAL typed value — rather than on
              // every keystroke while still mid-type, which could fire
              // against some other driver whose name happened to exactly
              // match whatever partial text was on screen at that instant.
              const match = driversForLocation(found.row.location || state.activeLocation || "atlanta").find((d) => d.name.toLowerCase() === t.value.trim().toLowerCase());
              if (match) {
                warnIfDriverAlreadyScheduled(found.row, match.id);
                checkDriverComplianceWarning(match);
              }
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
        if (t.dataset.driverAc === "true") updateDriverAutocomplete(t, state.activeLocation);
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
    setInterval(scanForAutoAccountingSend, 5 * 60 * 1000);
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
    if ($("#modal-location-notes")) {
      on("btn-page-info", "click", () => openLocationNotesModal("driverlist", "Driver List"));
      on("ln-close", "click", closeLocationNotesModal);
      on("ln-cancel", "click", closeLocationNotesModal);
      on("ln-save", "click", saveLocationNotes);
      $("#modal-location-notes").addEventListener("click", (e) => { if (e.target.id === "modal-location-notes") closeLocationNotesModal(); });
    }
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
    await initSupabaseClient();
    const ok = await requireAuth();
    if (!ok) return; // requireAuth() already redirected to login.html

    const info = PAGE_MAP[currentFile()];
    if (info && info.type === "accounting" && !isAccountingUser()) {
      window.location.href = "index.html";
      return;
    }
    if (info && info.type === "location-analytics" && !isAdminUser()) {
      window.location.href = "index.html";
      return;
    }

    try { renderNav(); } catch (e) { console.error("renderNav() failed:", e); }
    try { await loadLocationNotes(); } catch (e) { console.error("loadLocationNotes() failed:", e); }
    try { startAlertScanning(); } catch (e) { console.error("startAlertScanning() failed:", e); }
    try { wireModals(); } catch (e) { console.error("wireModals() failed:", e); }
    try { await loadBoardRateData(); } catch (e) { console.error("loadBoardRateData() failed:", e); }
    try {
      if (info.type === "board") initBoardPage(info);
      else if (info.type === "houston-board") initHoustonBoardPage(info);
      else if (info.type === "mondelez") initMondelezPage();
      else if (info.type === "driverlist") initDriverListPage();
      else if (info.type === "driver-analytics") initDriverAnalyticsPage();
      else if (info.type === "volume") initVolumePage();
      else if (info.type === "location-analytics") initLocationAnalyticsPage();
      else if (info.type === "accounting") initAccountingPage();
    } catch (e) { console.error("page-specific init failed:", e); }
    loadDriversFromSupabase().catch((e) => console.error("loadDriversFromSupabase() failed:", e));
  }

  document.addEventListener("DOMContentLoaded", init);