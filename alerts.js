/* ---------------- board alerts: bottom-right notification panel ---------------- */

import {state, supabaseClient, SHIFTS_TABLE, TRIPS_TABLE, dateKey, findDriver, parseHHMM, AVG_MPH, minsToClock, escapeHtml, $, openSendTextModal} from './loadboard.js';

  const ALERT_LOCATIONS = ["atlanta", "buildingc", "delaware"];
  const IDLE_THRESHOLD_MIN = 45; // "45 minutes after check-in, if not dispatched"
  const PRE_SHIFT_TEXT_LEAD_MIN = 60; // text needed 60 min before shift start
  const PRE_SHIFT_CALL_FOLLOWUP_MIN = 30; // call nudge 30 min after the pre-shift text went out
  const PAPERWORK_FOLLOWUP_MIN = 15; // reach out within 15 min if a new route starts before the last one's paperwork is in
  let boardAlerts = []; // current alerts, each with a stable key + firstSeenAt timestamp
  let alertFirstSeenAt = {}; // key -> Date, persists across scans so timestamps don't reset
  let alertScanTimer = null;
  let alertPanelExpanded = false;
  let alertPanelHasUnread = false;

  export function minsSinceMidnightNow() {
    const d = new Date();
    return d.getHours() * 60 + d.getMinutes();
  }

  export function driverPhoneForShift(s) {
    const drv = s.driver_id ? findDriver(String(s.driver_id)) : null;
    return (drv && drv.phone) || s.driver_cell_snapshot || "";
  }
  export function driverNameForShift(s) {
    const drv = s.driver_id ? findDriver(String(s.driver_id)) : null;
    return (drv && drv.name) || s.driver_name_text || "Unnamed driver";
  }

  export async function scanForBoardAlerts() {
    if (!supabaseClient) return [];
    const todayKey = dateKey(new Date()); // existing helper — local YYYY-MM-DD
    const { data: shifts, error: shiftErr } = await supabaseClient
      .from(SHIFTS_TABLE).select("*").in("location", ALERT_LOCATIONS).eq("shift_date", todayKey);
    if (shiftErr || !shifts || !shifts.length) return [];

    const shiftIds = shifts.map((s) => s.id);
    const { data: trips } = await supabaseClient.from(TRIPS_TABLE).select("*").in("shift_id", shiftIds);
    const tripsByShift = {};
    (trips || []).forEach((t) => { (tripsByShift[t.shift_id] = tripsByShift[t.shift_id] || []).push(t); });

    // trip_stops -- used by the missing-paperwork rule below to tell
    // whether an open trip has any in/out times recorded at all yet.
    const allTripIds = (trips || []).map((t) => t.id);
    let stopsByTrip = {};
    if (allTripIds.length) {
      const { data: stopRows } = await supabaseClient.from("trip_stops").select("trip_id").in("trip_id", allTripIds);
      (stopRows || []).forEach((s) => { stopsByTrip[s.trip_id] = (stopsByTrip[s.trip_id] || 0) + 1; });
    }

    const nowMin = minsSinceMidnightNow();
    const alerts = [];
    const preShiftTextNeeded = []; // collected across all shifts, then grouped by shift time below

    for (const s of shifts) {
      if (s.shift_complete) continue; // finished loads don't need attention
      const rowTrips = (tripsByShift[s.id] || []).sort((a, b) => a.trip_number - b.trip_number);
      const hasRealTrip = rowTrips.some((t) => (t.route_id || "").trim() || (t.trip_id || "").trim());
      const label = s.pro_number || s.driver_name_text || `Load on ${s.location}`;
      const driverName = driverNameForShift(s);
      const driverPhone = driverPhoneForShift(s);

      // Rule: idle driver -- shift started 45+ min ago, still nothing dispatched
      const shiftStartMin = parseHHMM(s.shift_start);
      if (shiftStartMin != null && !hasRealTrip) {
        const idleFor = nowMin - shiftStartMin;
        if (idleFor >= IDLE_THRESHOLD_MIN) {
          alerts.push({
            key: `idle-${s.id}`, type: "idle", location: s.location,
            message: `${driverName} (${label}) — no load dispatched ${Math.floor(idleFor / 60)}h ${idleFor % 60}m after check-in`,
            recipients: driverPhone ? [{ name: driverName, phone: driverPhone }] : [],
            actionMessage: `This is D&L transportation, ${driverName}. You checked in but nothing's been dispatched yet — please call or text us for an update.`,
          });
        }
      }

      // Rule: pre-shift text needed -- 60 min before shift start, text not yet sent.
      // Collected here, grouped by shift time further down (drivers sharing
      // a shift time get one combined alert with one button for all of them).
      if (shiftStartMin != null && !s.pre_shift_text_sent) {
        const minsUntilShift = shiftStartMin - nowMin;
        if (minsUntilShift <= PRE_SHIFT_TEXT_LEAD_MIN && minsUntilShift > -180) { // don't keep flagging hours-old missed shifts forever
          preShiftTextNeeded.push({ shiftStartMin, driverName, driverPhone, label, shiftDbId: s.id });
        }
      }

      // Rule: pre-shift call needed -- text was sent, 30+ min have passed.
      // Framed honestly: no way to know if the driver actually replied,
      // since replies land in TextBetter's mailbox, not this app.
      if (s.pre_shift_text_sent && s.pre_shift_text_sent_at) {
        const sentMinAgo = (Date.now() - new Date(s.pre_shift_text_sent_at).getTime()) / 60000;
        if (sentMinAgo >= PRE_SHIFT_CALL_FOLLOWUP_MIN) {
          alerts.push({
            key: `call-${s.id}`, type: "call_followup", location: s.location,
            message: `${driverName} (${label}) — pre-shift text sent ${Math.round(sentMinAgo)}m ago, call if there's been no reply`,
            recipients: [], // no text action here on purpose -- a text already went out, this is a call nudge
          });
        }
      }

      // Rule: missing paperwork -- a later trip has started while an
      // earlier trip is still open with no stop times recorded at all.
      for (let i = 0; i < rowTrips.length; i++) {
        const earlier = rowTrips[i];
        const earlierOpen = !earlier.minimized && !earlier.complete && ((earlier.route_id || "").trim() || (earlier.trip_id || "").trim());
        if (!earlierOpen) continue;
        const hasStops = !!stopsByTrip[earlier.id];
        if (hasStops) continue;
        const laterStarted = rowTrips.slice(i + 1).find((t) => t.dispatch_time);
        if (!laterStarted) continue;
        const laterDispatchMin = parseHHMM(laterStarted.dispatch_time);
        if (laterDispatchMin == null) continue;
        const sinceLaterStarted = nowMin - laterDispatchMin;
        if (sinceLaterStarted >= PAPERWORK_FOLLOWUP_MIN) {
          const earlierLabel = earlier.trip_id || earlier.route_id;
          alerts.push({
            key: `paperwork-${earlier.id}`, type: "missing_paperwork", location: s.location,
            message: `${driverName} (${label}) — started a new route but ${earlierLabel} is still open with no in/out times on file`,
            recipients: driverPhone ? [{ name: driverName, phone: driverPhone }] : [],
            actionMessage: `This is D&L transportation, ${driverName}. You've started your next route but we're still missing paperwork (in/out times) for ${earlierLabel}. Please send that over when you can.`,
          });
        }
      }

      // Rules: missing dispatch time / overdue return, per active (non-minimized) trip
      for (const t of rowTrips) {
        if (t.minimized || t.complete) continue;
        const hasRoute = (t.route_id || "").trim() || (t.trip_id || "").trim();
        if (!hasRoute) continue;
        const tripLabel = t.trip_id || t.route_id;

        if (!t.dispatch_time) {
          alerts.push({
            key: `noeta-${t.id}`, type: "missing_eta", location: s.location,
            message: `${driverName} (${label}, ${tripLabel}) — no dispatch time entered, can't calculate ETA`,
            recipients: [],
          });
          continue; // no dispatch time means returnToDC can't be computed either — avoid a redundant second alert
        }

        const dispatch = parseHHMM(t.dispatch_time);
        const miles = parseFloat(t.route_miles);
        if (dispatch != null && !isNaN(miles) && miles > 0) {
          const leg = (miles / AVG_MPH) * 60;
          const returnMin = dispatch + leg + leg + 15;
          if (nowMin >= returnMin) {
            const overdueBy = Math.round(nowMin - returnMin);
            alerts.push({
              key: `overdue-${t.id}`, type: "overdue_return", location: s.location,
              message: `${driverName} (${label}, ${tripLabel}) — was due back ${overdueBy}m ago`,
              recipients: driverPhone ? [{ name: driverName, phone: driverPhone }] : [],
              actionMessage: `This is D&L transportation, ${driverName}. Your route ${tripLabel} was due back a bit ago — please send an updated ETA.`,
            });
          }
        }
      }
    }

    // Group pre-shift-text-needed drivers by shift time -- same time means
    // the same message text, so one alert with one button covers all of them.
    const byShiftTime = {};
    preShiftTextNeeded.forEach((d) => { (byShiftTime[d.shiftStartMin] = byShiftTime[d.shiftStartMin] || []).push(d); });
    Object.entries(byShiftTime).forEach(([shiftStartMin, list]) => {
      const clockLabel = minsToClock(Number(shiftStartMin));
      const names = list.map((d) => d.driverName).join(", ");
      const withPhone = list.filter((d) => d.driverPhone);
      const recipients = withPhone.map((d) => ({ name: d.driverName, phone: d.driverPhone }));
      alerts.push({
        key: `preshift-${shiftStartMin}`, type: "preshift_text", location: "atlanta", // grouped alerts aren't location-specific; link falls back to Atlanta
        message: `${list.length > 1 ? `${list.length} drivers` : names} due for a pre-shift check-in text — ${clockLabel} shift${list.length > 1 ? "s" : ""} (${names})`,
        recipients,
        actionMessage: `This is D&L transportation, please provide an ETA for your ${clockLabel} shift.`,
        markShiftIdsOnSent: withPhone.map((d) => d.shiftDbId), // Pre Shift Text Sent gets marked automatically once this actually sends
      });
    });

    return alerts;
  }

  export function formatAlertTimestamp(d) {
    return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  }

  export function loadAlertWidgetPrefs() {
    try {
      return JSON.parse(localStorage.getItem("dl-alert-widget-prefs") || "{}");
    } catch (e) { return {}; }
  }
  export function saveAlertWidgetPrefs(patch) {
    const prefs = { ...loadAlertWidgetPrefs(), ...patch };
    try { localStorage.setItem("dl-alert-widget-prefs", JSON.stringify(prefs)); } catch (e) { /* ignore quota errors */ }
  }

  export function renderAlertPanel() {
    const widget = $("#alert-widget");
    if (!widget) return;
    const headerCount = $("#alert-widget-count");
    const body = $("#alert-widget-body");
    const count = boardAlerts.length;

    headerCount.textContent = count ? `(${count})` : "";
    widget.classList.toggle("expanded", alertPanelExpanded);
    widget.classList.toggle("blinking", alertPanelHasUnread && !alertPanelExpanded);

    if (!count) {
      body.innerHTML = `<div class="alert-empty">Nothing needs attention right now.</div>`;
      return;
    }
    const ICONS = { idle: "⏱", overdue_return: "↩", missing_eta: "❓", preshift_text: "📋", call_followup: "📞", missing_paperwork: "📄" };
    // newest first
    const sorted = [...boardAlerts].sort((a, b) => alertFirstSeenAt[b.key] - alertFirstSeenAt[a.key]);
    body.innerHTML = sorted.map((a) => `
      <a class="alert-chat-item" href="${a.location === "buildingc" ? "buildingc.html" : a.location + ".html"}">
        <span class="alert-chat-icon">${ICONS[a.type] || "•"}</span>
        <span class="alert-chat-text">${escapeHtml(a.message)}</span>
        <span class="alert-chat-time">${formatAlertTimestamp(alertFirstSeenAt[a.key] || new Date())}</span>
        ${a.recipients && a.recipients.length ? `<button type="button" class="alert-action-btn" data-alert-action-key="${a.key}" title="Text ${a.recipients.length > 1 ? "these drivers" : "this driver"}">Text</button>` : ""}
      </a>
    `).join("");
  }

  export async function refreshBoardAlerts() {
    let fresh = [];
    try {
      fresh = await scanForBoardAlerts();
    } catch (e) {
      console.error("scanForBoardAlerts failed:", e);
    }
    const now = new Date();
    let sawNew = false;
    const nextFirstSeen = {};
    fresh.forEach((a) => {
      if (alertFirstSeenAt[a.key]) {
        nextFirstSeen[a.key] = alertFirstSeenAt[a.key]; // keep original timestamp
      } else {
        nextFirstSeen[a.key] = now; // genuinely new — timestamp it now, trigger the blink
        sawNew = true;
      }
    });
    alertFirstSeenAt = nextFirstSeen;
    boardAlerts = fresh;
    if (sawNew && !alertPanelExpanded) alertPanelHasUnread = true;
    renderAlertPanel();
  }

  export function toggleAlertPanel() {
    alertPanelExpanded = !alertPanelExpanded;
    if (alertPanelExpanded) alertPanelHasUnread = false;
    saveAlertWidgetPrefs({ expanded: alertPanelExpanded });
    renderAlertPanel();
  }

  export function closeAlertWidget() {
    $("#alert-widget").classList.add("hidden");
    $("#alert-widget-reopen").classList.remove("hidden");
    saveAlertWidgetPrefs({ closed: true });
  }

  export function reopenAlertWidget() {
    $("#alert-widget").classList.remove("hidden");
    $("#alert-widget-reopen").classList.add("hidden");
    saveAlertWidgetPrefs({ closed: false });
  }

  export function applyAlertWidgetPosition(widget, pos) {
    if (pos && typeof pos.left === "number" && typeof pos.top === "number") {
      widget.style.left = pos.left + "px";
      widget.style.top = pos.top + "px";
      widget.style.right = "auto";
      widget.style.bottom = "auto";
    }
  }

  export function wireAlertWidgetDrag(widget, header) {
    let dragging = false, moved = false, startX = 0, startY = 0, origLeft = 0, origTop = 0;
    header.addEventListener("mousedown", (e) => {
      if (e.target.closest(".alert-widget-btn")) return; // don't start a drag from the min/close buttons
      dragging = true;
      moved = false;
      const rect = widget.getBoundingClientRect();
      origLeft = rect.left;
      origTop = rect.top;
      startX = e.clientX;
      startY = e.clientY;
      e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
      if (!moved) return;
      const maxLeft = window.innerWidth - widget.offsetWidth - 4;
      const maxTop = window.innerHeight - 40; // keep at least the header on-screen
      const left = Math.min(Math.max(4, origLeft + dx), Math.max(4, maxLeft));
      const top = Math.min(Math.max(4, origTop + dy), Math.max(4, maxTop));
      applyAlertWidgetPosition(widget, { left, top });
    });
    document.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      if (moved) {
        const rect = widget.getBoundingClientRect();
        saveAlertWidgetPrefs({ left: rect.left, top: rect.top });
      } else {
        toggleAlertPanel(); // it was a click, not a drag — behave like clicking the header always has
      }
    });
  }

  export function startAlertScanning() {
    if (!$("#alert-widget")) injectAlertWidget();
    refreshBoardAlerts();
    if (alertScanTimer) clearInterval(alertScanTimer);
    alertScanTimer = setInterval(refreshBoardAlerts, 60 * 1000);
  }

  export function injectAlertWidget() {
    const prefs = loadAlertWidgetPrefs();
    alertPanelExpanded = !!prefs.expanded;

    const el = document.createElement("div");
    el.id = "alert-widget";
    if (prefs.closed) el.classList.add("hidden");
    el.innerHTML = `
      <div class="alert-widget-header" id="alert-widget-header">
        <span>🔔 Alerts <span id="alert-widget-count"></span></span>
        <span class="alert-widget-controls">
          <button type="button" class="alert-widget-btn" id="alert-widget-minimize" title="Minimize">&minus;</button>
          <button type="button" class="alert-widget-btn" id="alert-widget-close" title="Close">&times;</button>
        </span>
      </div>
      <div class="alert-widget-body" id="alert-widget-body"></div>
    `;
    document.body.appendChild(el);
    applyAlertWidgetPosition(el, prefs);

    const reopenBtn = document.createElement("button");
    reopenBtn.id = "alert-widget-reopen";
    reopenBtn.className = "hidden";
    reopenBtn.type = "button";
    reopenBtn.title = "Show alerts";
    reopenBtn.textContent = "🔔";
    document.body.appendChild(reopenBtn);
    if (prefs.closed) reopenBtn.classList.remove("hidden");

    $("#alert-widget-minimize").addEventListener("click", (e) => { e.stopPropagation(); toggleAlertPanel(); });
    $("#alert-widget-close").addEventListener("click", (e) => { e.stopPropagation(); closeAlertWidget(); });
    reopenBtn.addEventListener("click", reopenAlertWidget);
    wireAlertWidgetDrag(el, $("#alert-widget-header"));

    // Delegated -- alert items are re-rendered wholesale on every scan, so
    // listeners attached directly to them would be lost each time.
    el.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-alert-action-key]");
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      const alert = boardAlerts.find((a) => a.key === btn.dataset.alertActionKey);
      if (alert && alert.recipients && alert.recipients.length) {
        openSendTextModal(alert.recipients, alert.actionMessage || "", alert.markShiftIdsOnSent || null);
      }
    });
  }


  export function renderNav() {
    const tabsEl = $("#tabs");
    if (!tabsEl) return;
    const cur = currentFile();
    tabsEl.innerHTML = NAV_ORDER
      .filter((file) => PAGE_MAP[file].type !== "accounting" || isAccountingUser())
      .map((file) => {
        const info = PAGE_MAP[file];
        return `<a class="tab-btn${file === cur ? " active" : ""}" href="${file}">${info.label}</a>`;
      }).join("") + `<button type="button" class="tab-btn" id="nav-logout" style="margin-left:auto;">Log Out</button>`;
    const logoutBtn = $("#nav-logout");
    if (logoutBtn) logoutBtn.addEventListener("click", signOut);
  }
