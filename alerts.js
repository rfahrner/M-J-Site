/* ---------------- board alerts: bottom-right notification panel ---------------- */
import {state, supabaseClient, SHIFTS_TABLE, TRIPS_TABLE, dateKey, findDriver, parseHHMM, AVG_MPH, minsToClock, escapeHtml, $, openSendTextModal, isAccountingUser, isAdminUser, signOut, scrollToAndOutlineShiftRow} from './loadboard.js';
import './paperwork-load-integration.js';
  const ALL_ALERT_LOCATIONS = ["atlanta", "buildingc", "delaware"];
  export const IDLE_THRESHOLD_MIN = 45; // Stage 4: 45 min after shift start, no dispatch yet -- repeats every 45 min after that
  export const PRE_SHIFT_TEXT_LEAD_MIN = 60; // Stage 1: pre-shift ETA text needed 60 min before shift start
  export const PRE_SHIFT_CALL_FOLLOWUP_MIN = 30; // Stage 2: call nudge once we're inside 30 min of shift start with no ETA
  export const PRE_SHIFT_ESCALATION_MIN = 15; // Stage 3: driver hasn't confirmed at all, inside 15 min of shift start with no ETA
  export const LAST_STOP_RETURN_FOLLOWUP_MIN = 45; // Stage 6 repeat interval: once Return ETA to DC's time has arrived, re-check every 45 min after that
  export const AT_DC_FOLLOWUP_MIN = 45; // repeat interval for "still waiting at the DC, not yet dispatched on their next load"
  const PAPERWORK_FOLLOWUP_MIN = 15; // reach out within 15 min if a new route starts before the last one's paperwork is in
  let boardAlerts = []; // current alerts, each with a stable key + firstSeenAt timestamp
  let alertFirstSeenAt = {}; // key -> Date, persists across scans so timestamps don't reset
  let alertScanTimer = null;
  let alertPanelExpanded = false;
  let alertPanelHasUnread = false;
  export function minsSinceMidnightNow() {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", hour: "numeric", minute: "numeric", hour12: false,
    }).formatToParts(new Date());
    const hour = Number(parts.find((p) => p.type === "hour").value) % 24;
    const minute = Number(parts.find((p) => p.type === "minute").value);
    return hour * 60 + minute;
  }
  function minsSinceMidnightAtTimestamp(isoString) {
    if (!isoString) return null;
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", hour: "numeric", minute: "numeric", hour12: false,
    }).formatToParts(new Date(isoString));
    const hour = Number(parts.find((p) => p.type === "hour").value) % 24;
    const minute = Number(parts.find((p) => p.type === "minute").value);
    return hour * 60 + minute;
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
    if (!ALL_ALERT_LOCATIONS.includes(state.activeLocation)) return [];
    const thisLocation = [state.activeLocation];
    const todayKey = dateKey(new Date());
    const { data: shifts, error: shiftErr } = await supabaseClient
      .from(SHIFTS_TABLE).select("*").in("location", thisLocation).eq("shift_date", todayKey);
    if (shiftErr || !shifts || !shifts.length) return [];
    const shiftIds = shifts.map((s) => s.id);
    const { data: trips } = await supabaseClient.from(TRIPS_TABLE).select("*").in("shift_id", shiftIds);
    const tripsByShift = {};
    (trips || []).forEach((t) => { (tripsByShift[t.shift_id] = tripsByShift[t.shift_id] || []).push(t); });
    const allTripIds = (trips || []).map((t) => t.id);
    let stopsByTrip = {};
    if (allTripIds.length) {
      const { data: stopRows } = await supabaseClient.from("trip_stops").select("trip_id, time_in, time_out").in("trip_id", allTripIds);
      (stopRows || []).forEach((s) => { if (s.time_in || s.time_out) stopsByTrip[s.trip_id] = (stopsByTrip[s.trip_id] || 0) + 1; });
    }
    const nowMin = minsSinceMidnightNow();
    const alerts = [];
    const preShiftTextNeeded = [];
    for (const s of shifts) {
      if (s.shift_complete) continue;
      const rowTrips = (tripsByShift[s.id] || []).sort((a, b) => a.trip_number - b.trip_number);
      const hasRealTrip = rowTrips.some((t) => (t.route_id || "").trim() || (t.trip_id || "").trim());
      const label = s.pro_number || s.driver_name_text || `Load on ${s.location}`;
      const driverName = driverNameForShift(s);
      const driverPhone = driverPhoneForShift(s);
      const shiftStartMin = parseHHMM(s.shift_start);
      const hasEta = !!(s.eta_shift_report || "").trim();
      if (shiftStartMin != null && !hasEta && !hasRealTrip) {
        const minsUntilShift = shiftStartMin - nowMin;
        const clockLabel = minsToClock(shiftStartMin);
        if (minsUntilShift <= PRE_SHIFT_ESCALATION_MIN && minsUntilShift > -180) {
          alerts.push({
            key: `preshift-escalate-${s.id}`, type: "preshift_escalate", location: s.location, shiftDbId: s.id,
            message: `${driverName} (${label}) — has not confirmed their ${clockLabel} shift today`,
            recipients: driverPhone ? [{ name: driverName, phone: driverPhone }] : [],
            actionMessage: `This is D&L Transportation, ${driverName} — we still haven't heard from you about your ${clockLabel} shift today. Please call or text us right away.`,
          });
        } else if (minsUntilShift <= PRE_SHIFT_CALL_FOLLOWUP_MIN && minsUntilShift > -180) {
          alerts.push({
            key: `preshift-call-${s.id}`, type: "call_followup", location: s.location, shiftDbId: s.id,
            message: `${driverName} (${label}) — no ETA yet for ${clockLabel} shift, please call`,
            recipients: [],
          });
        } else if (minsUntilShift <= PRE_SHIFT_TEXT_LEAD_MIN && minsUntilShift > -180) {
          preShiftTextNeeded.push({ shiftStartMin, driverName, driverPhone, label, shiftDbId: s.id });
        }
      }
      if (shiftStartMin != null && !hasRealTrip && hasEta) {
        const idleFor = nowMin - shiftStartMin;
        if (idleFor >= IDLE_THRESHOLD_MIN) {
          const tier = Math.floor((idleFor - IDLE_THRESHOLD_MIN) / IDLE_THRESHOLD_MIN);
          alerts.push({
            key: `idle-${s.id}-${tier}`, type: "idle", location: s.location, shiftDbId: s.id,
            message: `${driverName} (${label}) — no load dispatched ${Math.floor(idleFor / 60)}h ${idleFor % 60}m after check-in`,
            recipients: driverPhone ? [{ name: driverName, phone: driverPhone }] : [],
            actionMessage: `This is D&L transportation, ${driverName}. You checked in but nothing's been dispatched yet — please call or text us for an update.`,
          });
        }
      }
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
            key: `paperwork-${earlier.id}`, type: "missing_paperwork", location: s.location, shiftDbId: s.id,
            message: `${driverName} (${label}) — started a new route but ${earlierLabel} is still open with no in/out times on file`,
            recipients: driverPhone ? [{ name: driverName, phone: driverPhone }] : [],
            actionMessage: `This is D&L transportation, ${driverName}. You've started your next route but we're still missing paperwork (in/out times) for ${earlierLabel}. Please send that over when you can.`,
          });
        }
      }
      for (const t of rowTrips) {
        if (t.minimized || t.complete) continue;
        const hasRoute = (t.route_id || "").trim() || (t.trip_id || "").trim();
        if (!hasRoute) continue;
        const tripLabel = t.trip_id || t.route_id;
        if (!t.dispatch_time) {
          alerts.push({
            key: `noeta-${t.id}`, type: "missing_eta", location: s.location, shiftDbId: s.id,
            message: `${driverName} (${label}, ${tripLabel}) — no dispatch time entered, can't calculate ETA`,
            recipients: [],
          });
          continue;
        }
        const laterDispatched = rowTrips.some((t2) => t2.trip_number > t.trip_number && ((t2.route_id || "").trim() || (t2.trip_id || "").trim()));
        if (laterDispatched) continue;
        const lastStopMin = parseHHMM(t.last_stop_depart);
        const returnEtaMin = parseHHMM(t.return_eta_to_dc);
        if (lastStopMin != null && returnEtaMin == null && nowMin >= lastStopMin) {
          alerts.push({
            key: `laststop-${t.id}`, type: "last_stop", location: s.location, shiftDbId: s.id,
            message: `${driverName} (${label}, ${tripLabel}) — should be at their last stop, let's get an ETA to the DC`,
            recipients: driverPhone ? [{ name: driverName, phone: driverPhone }] : [],
            actionMessage: `This is D&L transportation, ${driverName}. Have you made it to your last stop? What's your ETA back to the DC?`,
          });
        } else if (returnEtaMin != null && nowMin >= returnEtaMin) {
          const sinceReturnEta = nowMin - returnEtaMin;
          const tier = Math.floor(sinceReturnEta / LAST_STOP_RETURN_FOLLOWUP_MIN);
          alerts.push({
            key: `return-${t.id}-${tier}`, type: "overdue_return", location: s.location, shiftDbId: s.id,
            message: `${driverName} (${label}, ${tripLabel}) — was scheduled to return previous load at ${minsToClock(returnEtaMin)}, let's check in for paperwork and drop spot location`,
            recipients: driverPhone ? [{ name: driverName, phone: driverPhone }] : [],
            actionMessage: `This is D&L transportation, ${driverName}. Checking in on paperwork and your drop spot location for ${tripLabel}.`,
          });
        }
      }
      if (!s.shift_complete && hasRealTrip) {
        const allDone = rowTrips.every((t) => t.minimized || !String(t.route_id || t.trip_id || "").trim());
        if (allDone) {
          const lastReal = [...rowTrips].reverse().find((t) => String(t.route_id || t.trip_id || "").trim());
          if (lastReal) {
            const etaMin = parseHHMM(lastReal.return_eta_to_dc);
            const completedMin = minsSinceMidnightAtTimestamp(lastReal.completed_at);
            let atDcMin = null;
            if (etaMin != null && completedMin != null) atDcMin = Math.max(etaMin, completedMin);
            else if (etaMin != null) atDcMin = etaMin;
            else if (completedMin != null) atDcMin = completedMin;
            if (atDcMin != null) {
              const waitingFor = nowMin - atDcMin;
              if (waitingFor >= AT_DC_FOLLOWUP_MIN) {
                const tier = Math.floor(waitingFor / AT_DC_FOLLOWUP_MIN);
                alerts.push({
                  key: `atdc-${s.id}-${tier}`, type: "at_dc_waiting", location: s.location, shiftDbId: s.id,
                  message: `${driverName} (${label}) — has been at the DC ${Math.floor(waitingFor / 60)}h ${waitingFor % 60}m, let's see if they've been dispatched`,
                  recipients: driverPhone ? [{ name: driverName, phone: driverPhone }] : [],
                  actionMessage: `This is D&L transportation, ${driverName}. Have you been dispatched on your next load yet?`,
                });
              }
            }
          }
        }
      }
    }
    const byShiftTime = {};
    preShiftTextNeeded.forEach((d) => { (byShiftTime[d.shiftStartMin] = byShiftTime[d.shiftStartMin] || []).push(d); });
    Object.entries(byShiftTime).forEach(([shiftStartMin, list]) => {
      const clockLabel = minsToClock(Number(shiftStartMin));
      const names = list.map((d) => d.driverName).join(", ");
      const withPhone = list.filter((d) => d.driverPhone);
      const recipients = withPhone.map((d) => ({ name: d.driverName, phone: d.driverPhone }));
      alerts.push({
        key: `preshift-${shiftStartMin}`, type: "preshift_text", location: state.activeLocation,
        message: `${list.length > 1 ? `${list.length} drivers` : names} due for a pre-shift check-in text — ${clockLabel} shift${list.length > 1 ? "s" : ""} (${names})`,
        recipients,
        actionMessage: `This is D&L Transportation, could we have an ETA for your ${clockLabel} kroger shift`,
        markShiftIdsOnSent: withPhone.map((d) => d.shiftDbId),
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
    try { localStorage.setItem("dl-alert-widget-prefs", JSON.stringify(prefs)); } catch (e) { }
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
    const ICONS = { idle: "⏱", overdue_return: "↩", missing_eta: "❓", preshift_text: "📋", preshift_escalate: "🚨", call_followup: "📞", missing_paperwork: "📄", last_stop: "🏁", at_dc_waiting: "🅿️" };
    const sorted = [...boardAlerts].sort((a, b) => alertFirstSeenAt[b.key] - alertFirstSeenAt[a.key]);
    body.innerHTML = sorted.map((a) => {
      const targetIds = a.markShiftIdsOnSent && a.markShiftIdsOnSent.length ? a.markShiftIdsOnSent : (a.shiftDbId != null ? [a.shiftDbId] : []);
      return `
      <div class="alert-chat-item" ${targetIds.length ? `data-alert-jump-ids="${targetIds.join(",")}"` : ""}>
        <span class="alert-chat-icon">${ICONS[a.type] || "•"}</span>
        <span class="alert-chat-text">${escapeHtml(a.message)}</span>
        <span class="alert-chat-time">${formatAlertTimestamp(alertFirstSeenAt[a.key] || new Date())}</span>
        ${a.recipients && a.recipients.length ? `<button type="button" class="alert-action-btn" data-alert-action-key="${a.key}" title="Text ${a.recipients.length > 1 ? "these drivers" : "this driver"}">Text</button>` : ""}
      </div>
    `;
    }).join("");
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
        nextFirstSeen[a.key] = alertFirstSeenAt[a.key];
      } else {
        nextFirstSeen[a.key] = now;
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
      if (e.target.closest(".alert-widget-btn")) return;
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
      const maxTop = window.innerHeight - 40;
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
        toggleAlertPanel();
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
    el.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-alert-action-key]");
      if (btn) {
        e.preventDefault();
        e.stopPropagation();
        const alert = boardAlerts.find((a) => a.key === btn.dataset.alertActionKey);
        if (alert && alert.recipients && alert.recipients.length) {
          openSendTextModal(alert.recipients, alert.actionMessage || "", alert.markShiftIdsOnSent || null);
        }
        return;
      }
      const item = e.target.closest("[data-alert-jump-ids]");
      if (item) {
        const ids = item.dataset.alertJumpIds.split(",").map(Number).filter((n) => !isNaN(n));
        ids.forEach((id) => scrollToAndOutlineShiftRow(id));
      }
    });
  }
  const NAV_STRUCTURE = [
    {
      label: "Kroger",
      children: [
        { label: "Atlanta", href: "index.html" },
        { label: "Delaware", href: "dalaware.html" },
        { label: "Building C", href: "buildingc.html" },
        { label: "Houston", href: "houston.html" },
      ],
    },
    {
      label: "Mondelez",
      children: [
        { label: "West Chester", href: "mondelez.html?loc=westchester" },
        { label: "Morris", href: "mondelez.html?loc=morris" },
        { label: "Addison", href: "mondelez.html?loc=addison" },
        { label: "Indianapolis", href: "mondelez.html?loc=indianapolis" },
        { label: "Louisville", href: "mondelez.html?loc=louisville" },
        { label: "Spokane", href: "mondelez.html?loc=spokane" },
        { label: "Las Vegas", href: "mondelez.html?loc=lasvegas" },
        { label: "Boise", href: "mondelez.html?loc=boise" },
        { label: "Kent", href: "mondelez.html?loc=kent" },
        { label: "Salt Lake City", href: "mondelez.html?loc=saltlakecity" },
        { label: "New Berlin", href: "mondelez.html?loc=newberlin" },
        { label: "All Locations", href: "mondelez.html?loc=combined" },
      ],
    },
    { label: "Racetrac", comingSoon: true },
    { label: "Carlstar", comingSoon: true },
    { label: "Global Pallets", comingSoon: true },
    { label: "LTL", comingSoon: true },
    { label: "Paperwork", href: "paperwork.html" },
    { label: "Driver List", href: "driverlist.html" },
    { label: "Accounting", href: "accounting.html", visible: () => isAccountingUser() },
    {
      label: "Analytics",
      children: [
        { label: "Driver Analytics", href: "analytics-drivers.html" },
        { label: "Volume", href: "analytics-volume.html" },
        { label: "Location Analytics", href: "location-analytics.html", visible: () => isAdminUser() },
      ],
    },
  ];

  let navDropdownCssInjected = false;
  function ensureNavDropdownCss() {
    if (navDropdownCssInjected) return;
    navDropdownCssInjected = true;
    const style = document.createElement("style");
    style.textContent = `
      #nav-dropdown-portal {
        display: none; position: fixed;
        background: #fff; border: 1px solid #d1d9e0; border-radius: 6px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15); min-width: 180px;
        z-index: 1000; padding: 4px 0;
      }
      .nav-dropdown-item {
        display: block; padding: 8px 14px; color: #172542;
        text-decoration: none; font-size: 13px; white-space: nowrap;
      }
      .nav-dropdown-item:hover { background: #eef1f6; }
      .nav-dropdown-item.active { font-weight: 700; color: #006495; }
      .tab-btn-disabled {
        border: none; background: transparent; color: #000; opacity: 0.45;
        padding: 0 16px; height: 100%; display: inline-flex; align-items: center;
        font-size: 13px; font-weight: 600; letter-spacing: 0.01em;
        white-space: nowrap; cursor: default;
      }
    `;
    document.head.appendChild(style);
  }

  function isNavChildActive(child, curFile, curLocParam) {
    const [childFile, childQuery] = child.href.split("?");
    if (childFile !== curFile) return false;
    if (!childQuery) return true;
    const childParams = new URLSearchParams(childQuery);
    return childParams.get("loc") === curLocParam;
  }

  let navHideTimer = null;
  function getOrCreateNavPortal() {
    let portal = document.getElementById("nav-dropdown-portal");
    if (portal) return portal;
    portal = document.createElement("div");
    portal.id = "nav-dropdown-portal";
    document.body.appendChild(portal);
    portal.addEventListener("mouseenter", () => { if (navHideTimer) clearTimeout(navHideTimer); });
    portal.addEventListener("mouseleave", scheduleNavPortalHide);
    return portal;
  }
  function scheduleNavPortalHide() {
    if (navHideTimer) clearTimeout(navHideTimer);
    navHideTimer = setTimeout(() => {
      const portal = document.getElementById("nav-dropdown-portal");
      if (portal) portal.style.display = "none";
    }, 150);
  }
  function showNavPortalFor(triggerEl, children, cur, curLocParam) {
    if (navHideTimer) clearTimeout(navHideTimer);
    const portal = getOrCreateNavPortal();
    portal.innerHTML = children.map((c) => `<a class="nav-dropdown-item${isNavChildActive(c, cur, curLocParam) ? " active" : ""}" href="${escapeHtml(c.href)}">${escapeHtml(c.label)}</a>`).join("");
    const rect = triggerEl.getBoundingClientRect();
    portal.style.left = `${rect.left}px`;
    portal.style.top = `${rect.bottom}px`;
    portal.style.display = "block";
  }

  export function renderNav() {
    const tabsEl = $("#tabs");
    if (!tabsEl) return;
    ensureNavDropdownCss();
    const cur = location.pathname.split("/").pop() || "index.html";
    const curLocParam = new URLSearchParams(window.location.search).get("loc");

    tabsEl.innerHTML = NAV_STRUCTURE.map((item, idx) => {
      if (item.visible && !item.visible()) return "";
      if (item.comingSoon) {
        return `<span class="tab-btn-disabled" title="Coming soon">${escapeHtml(item.label)}</span>`;
      }
      if (item.children) {
        const visibleChildren = item.children.filter((c) => !c.visible || c.visible());
        if (!visibleChildren.length) return "";
        const first = visibleChildren[0];
        const isActiveParent = visibleChildren.some((c) => isNavChildActive(c, cur, curLocParam));
        return `<a class="tab-btn${isActiveParent ? " active" : ""}" href="${escapeHtml(first.href)}" data-nav-dropdown-idx="${idx}">${escapeHtml(item.label)}</a>`;
      }
      return `<a class="tab-btn${item.href === cur ? " active" : ""}" href="${escapeHtml(item.href)}">${escapeHtml(item.label)}</a>`;
    }).join("") + `<button type="button" class="tab-btn" id="nav-logout" style="margin-left:auto;">Log Out</button>`;

    tabsEl.querySelectorAll("[data-nav-dropdown-idx]").forEach((el) => {
      const item = NAV_STRUCTURE[Number(el.dataset.navDropdownIdx)];
      const visibleChildren = (item.children || []).filter((c) => !c.visible || c.visible());
      el.addEventListener("mouseenter", () => showNavPortalFor(el, visibleChildren, cur, curLocParam));
      el.addEventListener("mouseleave", scheduleNavPortalHide);
    });

    const logoutBtn = $("#nav-logout");
    if (logoutBtn) logoutBtn.addEventListener("click", signOut);
  }