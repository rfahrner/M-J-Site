/* ---------------- board alerts: bottom-right notification panel ---------------- */
import {state, supabaseClient, SHIFTS_TABLE, TRIPS_TABLE, dateKey, findDriver, parseHHMM, AVG_MPH, minsToClock, escapeHtml, $, openSendTextModal, currentFile, isAccountingUser, isAdminUser, signOut, scrollToAndOutlineShiftRow} from './loadboard.js';
  const ALL_ALERT_LOCATIONS = ["atlanta", "buildingc", "delaware"];
  export const IDLE_THRESHOLD_MIN = 45; // Stage 4: 45 min after shift start, no dispatch yet -- repeats every 45 min after that
  export const PRE_SHIFT_TEXT_LEAD_MIN = 60; // Stage 1: pre-shift ETA text needed 60 min before shift start
  export const PRE_SHIFT_CALL_FOLLOWUP_MIN = 30; // Stage 2: call nudge once we're inside 30 min of shift start with no ETA
  export const PRE_SHIFT_ESCALATION_MIN = 15; // Stage 3: driver hasn't confirmed at all, inside 15 min of shift start with no ETA
  export const LAST_STOP_RETURN_FOLLOWUP_MIN = 45; // Stage 6 repeat interval: once Return ETA to DC's time has arrived, re-check every 45 min until the trip's marked complete
  export const AT_DC_FOLLOWUP_MIN = 45; // repeat interval for "still waiting at the DC, not yet dispatched on their next load"
  const PAPERWORK_FOLLOWUP_MIN = 15; // reach out within 15 min if a new route starts before the last one's paperwork is in
  let boardAlerts = []; // current alerts, each with a stable key + firstSeenAt timestamp
  let alertFirstSeenAt = {}; // key -> Date, persists across scans so timestamps don't reset
  let alertScanTimer = null;
  let alertPanelExpanded = false;
  let alertPanelHasUnread = false;
  export function minsSinceMidnightNow() {
    // Every alert threshold and the Next Call Time column are all built on
    // this one function -- it needs to reflect Atlanta's actual clock time,
    // not whatever timezone the person viewing the board happens to be in.
    // A dispatcher checking in from a different timezone (or a browser/
    // system clock that's just off) would otherwise throw every threshold
    // in this file off by however many hours that difference is.
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", hour: "numeric", minute: "numeric", hour12: false,
    }).formatToParts(new Date());
    const hour = Number(parts.find((p) => p.type === "hour").value) % 24; // Intl can return "24" for midnight
    const minute = Number(parts.find((p) => p.type === "minute").value);
    return hour * 60 + minute;
  }
  // Same idea, but for an arbitrary timestamp instead of always "now" --
  // needed to compare a trip's completed_at against its return_eta_to_dc
  // on the same Atlanta-local clock, for the "at DC" alert below.
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
    // Alerts are exclusive to whichever board tab is currently open --
    // Atlanta only shows Atlanta's alerts, not Delaware's or Building C's,
    // and pages outside these three (Houston, Mondelez, Driver List) don't
    // show any of these at all, since none of this applies to them.
    if (!ALL_ALERT_LOCATIONS.includes(state.activeLocation)) return [];
    const thisLocation = [state.activeLocation];
    const todayKey = dateKey(new Date()); // existing helper — local YYYY-MM-DD
    const { data: shifts, error: shiftErr } = await supabaseClient
      .from(SHIFTS_TABLE).select("*").in("location", thisLocation).eq("shift_date", todayKey);
    if (shiftErr || !shifts || !shifts.length) return [];
    const shiftIds = shifts.map((s) => s.id);
    const { data: trips } = await supabaseClient.from(TRIPS_TABLE).select("*").in("shift_id", shiftIds);
    const tripsByShift = {};
    (trips || []).forEach((t) => { (tripsByShift[t.shift_id] = tripsByShift[t.shift_id] || []).push(t); });
    // trip_stops -- used by the missing-paperwork rule below to tell
    // whether an open trip has any REAL in/out times recorded yet. Has to
    // check actual time_in/time_out values, not just row existence -- a
    // blank placeholder row gets created as soon as a stop count is set,
    // before anyone's typed an actual time into it.
    const allTripIds = (trips || []).map((t) => t.id);
    let stopsByTrip = {};
    if (allTripIds.length) {
      const { data: stopRows } = await supabaseClient.from("trip_stops").select("trip_id, time_in, time_out").in("trip_id", allTripIds);
      (stopRows || []).forEach((s) => { if (s.time_in || s.time_out) stopsByTrip[s.trip_id] = (stopsByTrip[s.trip_id] || 0) + 1; });
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
      const shiftStartMin = parseHHMM(s.shift_start);
      // ---- Pre-shift ETA cascade (Stages 1-3) ----
      // Gated on eta_shift_report being blank AND the driver not already
      // having a real dispatched trip -- if they've been dispatched, that's
      // strong proof they showed up and this is confirmed in every way that
      // actually matters, even if nobody went back and manually filled in
      // the ETA field itself. Tracking moves on to the next stage instead
      // of continuing to ask a question that's already been answered.
      const hasEta = !!(s.eta_shift_report || "").trim();
      if (shiftStartMin != null && !hasEta && !hasRealTrip) {
        const minsUntilShift = shiftStartMin - nowMin;
        const clockLabel = minsToClock(shiftStartMin);
        if (minsUntilShift <= PRE_SHIFT_ESCALATION_MIN && minsUntilShift > -180) {
          // Stage 3: driver hasn't confirmed their shift at all
          alerts.push({
            key: `preshift-escalate-${s.id}`, type: "preshift_escalate", location: s.location, shiftDbId: s.id,
            message: `${driverName} (${label}) — has not confirmed their ${clockLabel} shift today`,
            recipients: driverPhone ? [{ name: driverName, phone: driverPhone }] : [],
            actionMessage: `This is D&L Transportation, ${driverName} — we still haven't heard from you about your ${clockLabel} shift today. Please call or text us right away.`,
          });
        } else if (minsUntilShift <= PRE_SHIFT_CALL_FOLLOWUP_MIN && minsUntilShift > -180) {
          // Stage 2: no ETA yet, prompt a call (no text button -- a text already went out in stage 1)
          alerts.push({
            key: `preshift-call-${s.id}`, type: "call_followup", location: s.location, shiftDbId: s.id,
            message: `${driverName} (${label}) — no ETA yet for ${clockLabel} shift, please call`,
            recipients: [],
          });
        } else if (minsUntilShift <= PRE_SHIFT_TEXT_LEAD_MIN && minsUntilShift > -180) {
          // Stage 1: initial pre-shift ETA text, collected and grouped by shift time below
          preShiftTextNeeded.push({ shiftStartMin, driverName, driverPhone, label, shiftDbId: s.id });
        }
      }
      // ---- Stage 4: dispatch check, 45 min after shift start, repeating ----
      // Only starts once the ETA is actually confirmed -- if we're still
      // waiting to hear from the driver at all, stages 1-3 above are the
      // relevant ones, not this. Re-fires (re-triggers the unread/blink
      // state) every IDLE_THRESHOLD_MIN by rolling a "tier" into the key --
      // a new tier is a new key, which the panel treats as a fresh alert.
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
            key: `paperwork-${earlier.id}`, type: "missing_paperwork", location: s.location, shiftDbId: s.id,
            message: `${driverName} (${label}) — started a new route but ${earlierLabel} is still open with no in/out times on file`,
            recipients: driverPhone ? [{ name: driverName, phone: driverPhone }] : [],
            actionMessage: `This is D&L transportation, ${driverName}. You've started your next route but we're still missing paperwork (in/out times) for ${earlierLabel}. Please send that over when you can.`,
          });
        }
      }
      // Rules: missing dispatch time, and the Stage 5/6 last-stop cascade,
      // per active (non-minimized, non-complete) trip. Each trip is its own
      // independent cycle, so a driver starting a new route naturally
      // starts a fresh cycle for that trip without any extra bookkeeping.
      for (const t of rowTrips) {
        if (t.minimized || t.complete) continue;
        const hasRoute = (t.route_id || "").trim() || (t.trip_id || "").trim();
        if (!hasRoute) continue; // not dispatched yet -- Stage 4 above covers that case
        const tripLabel = t.trip_id || t.route_id;
        if (!t.dispatch_time) {
          alerts.push({
            key: `noeta-${t.id}`, type: "missing_eta", location: s.location, shiftDbId: s.id,
            message: `${driverName} (${label}, ${tripLabel}) — no dispatch time entered, can't calculate ETA`,
            recipients: [],
          });
          continue; // no dispatch time means last-stop timing can't be evaluated either
        }
        // if a later trip's already been dispatched, this trip's cycle is
        // done regardless of what stage it was on -- the next trip's own
        // cycle (checked independently, this same loop) takes over
        const laterDispatched = rowTrips.some((t2) => t2.trip_number > t.trip_number && ((t2.route_id || "").trim() || (t2.trip_id || "").trim()));
        if (laterDispatched) continue;
        const lastStopMin = parseHHMM(t.last_stop_depart);
        const returnEtaMin = parseHHMM(t.return_eta_to_dc);
        if (lastStopMin != null && returnEtaMin == null && nowMin >= lastStopMin) {
          // Stage 5: last-stop-depart time has arrived, no return ETA yet --
          // this ONLY asks whether the driver made it and what their ETA
          // back to the DC is. Paperwork/drop-spot isn't part of this one.
          alerts.push({
            key: `laststop-${t.id}`, type: "last_stop", location: s.location, shiftDbId: s.id,
            message: `${driverName} (${label}, ${tripLabel}) — should be at their last stop, let's get an ETA to the DC`,
            recipients: driverPhone ? [{ name: driverName, phone: driverPhone }] : [],
            actionMessage: `This is D&L transportation, ${driverName}. Have you made it to your last stop? What's your ETA back to the DC?`,
          });
        } else if (returnEtaMin != null && nowMin >= returnEtaMin) {
          // Stage 6: we HAVE a return ETA and that time has arrived --
          // NOW is when paperwork and drop-spot location get asked for.
          // Repeats every LAST_STOP_RETURN_FOLLOWUP_MIN until the trip's
          // marked complete (or a later trip gets dispatched, caught above).
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
      // Stage 7: driver waiting at the DC between trips -- every trip on
      // this shift is closed out, but the shift itself isn't complete,
      // meaning they're sitting idle waiting on their next dispatch.
      // Repeats every AT_DC_FOLLOWUP_MIN, same tiered-key trick as the
      // other repeating alerts above.
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
        key: `preshift-${shiftStartMin}`, type: "preshift_text", location: state.activeLocation,
        message: `${list.length > 1 ? `${list.length} drivers` : names} due for a pre-shift check-in text — ${clockLabel} shift${list.length > 1 ? "s" : ""} (${names})`,
        recipients,
        actionMessage: `This is D&L Transportation, could we have an ETA for your ${clockLabel} kroger shift`,
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
    const ICONS = { idle: "⏱", overdue_return: "↩", missing_eta: "❓", preshift_text: "📋", preshift_escalate: "🚨", call_followup: "📞", missing_paperwork: "📄", last_stop: "🏁", at_dc_waiting: "🅿️" };
    // newest first
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
      if (btn) {
        e.preventDefault();
        e.stopPropagation();
        const alert = boardAlerts.find((a) => a.key === btn.dataset.alertActionKey);
        if (alert && alert.recipients && alert.recipients.length) {
          openSendTextModal(alert.recipients, alert.actionMessage || "", alert.markShiftIdsOnSent || null);
        }
        return;
      }
      // clicking the alert itself (not its Text button) jumps to and
      // outlines the row it's about, instead of navigating anywhere
      const item = e.target.closest("[data-alert-jump-ids]");
      if (item) {
        const ids = item.dataset.alertJumpIds.split(",").map(Number).filter((n) => !isNaN(n));
        ids.forEach((id) => scrollToAndOutlineShiftRow(id));
      }
    });
  }
  // Nav structure — top-level items in order. Plain data, easy to
  // hand-edit: reorder items, add/remove children, flip comingSoon on
  // or off. The rendering logic below doesn't need to change for any
  // of that.
  //   - No "children" + has "href": simple link.
  //   - "children": hover dropdown. Clicking the parent label itself
  //     (not a dropdown item) goes to the FIRST child's href.
  //   - "comingSoon: true": shown but not clickable.
  //   - "visible": optional function: () => boolean. Omit to always show.
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
    { label: "Driver List", href: "driverlist.html" },
    { label: "Accounting", href: "accounting.html", visible: () => isAccountingUser() },
    {
      label: "Analytics",
      children: [
        { label: "Driver Analytics", href: "analytics-drivers.html" },
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

  // A dropdown child is "active" if its file matches the current page
  // AND (for Mondelez children specifically) its ?loc= param matches
  // what's actually in the URL right now.
  function isNavChildActive(child, curFile, curLocParam) {
    const [childFile, childQuery] = child.href.split("?");
    if (childFile !== curFile) return false;
    if (!childQuery) return true;
    const childParams = new URLSearchParams(childQuery);
    return childParams.get("loc") === curLocParam;
  }

  // The dropdown menu is appended directly to <body>, deliberately NOT
  // nested inside #tabs/.topbar. #tabs has overflow-x:auto for its own
  // legitimate reason (horizontal scroll when there are many top-level
  // items) — but per the CSS spec, setting overflow on just one axis
  // forces the other axis to also compute as "auto" rather than
  // "visible," even though overflow-y was never explicitly set. That
  // silently clipped a nested dropdown to the topbar's own 52px height,
  // which is exactly what "makes me scroll down to see the options" was.
  // A portal element outside that container entirely sidesteps the
  // problem rather than fighting a CSS rule that can't be overridden
  // from the child's side.
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
    }, 150); // short grace period so moving the mouse from the trigger down into the menu doesn't flicker-close it
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
    const cur = currentFile();
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