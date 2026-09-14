/* Houston-specific behavior for the standardized Load Details modal.
   The visual shell comes from unified-load-modals.js; this module makes the
   Overview, Notes and Change History tabs behave like the Atlanta modal. */

let lb = null;
let hou = null;
let currentRowId = null;
let lastContextRowId = null;
let lastOpenedDbId = null;
let notes = [];
let history = [];
let modalWasHidden = true;

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function money(value) {
  if (value === "" || value == null || Number.isNaN(Number(value))) return "—";
  return `$${Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function modal() { return document.getElementById("modal-houston-load-details"); }
function panel(key) { return modal()?.querySelector(`[data-unified-ld-panel="${key}"]`) || null; }

function currentRow() {
  if (!currentRowId || !hou) return null;
  return hou.findHoustonRowAnywhere(currentRowId)?.row || null;
}

function currentDriver() {
  const row = currentRow();
  return row?.driverId && lb ? lb.findDriver(row.driverId) : null;
}

function humanField(field) {
  const labels = {
    driver: "Driver",
    aljex_number: "Aljex #",
    time: "Time",
    carrier: "Carrier",
    mc: "MC #",
    rating: "Rating",
    driver_phone: "Driver Cell",
    dispatcher_phone: "Dispatcher Phone",
    rate: "Rate",
    ttc: "TTC",
    ttt: "TTT",
    comments: "Comments",
    time_out_remarks: "Time Out / Remarks",
    tonu: "TONU",
    highlighted: "Highlight",
    shift_complete: "Shift Complete",
    image: "Image",
  };
  return labels[field] || String(field || "").replaceAll("_", " ");
}

function formatHistoryEntry(entry) {
  const oldVal = entry.old_value == null || entry.old_value === "" ? "—" : entry.old_value;
  const newVal = entry.new_value == null || entry.new_value === "" ? "—" : entry.new_value;
  return `<strong>${esc(humanField(entry.field_name))}</strong><div class="subtext">${esc(oldVal)} → ${esc(newVal)}</div>`;
}

function moveOperationalNotesToRoute() {
  const route = panel("route")?.querySelector(".unified-field-grid") || panel("route");
  if (!route) return;
  ["hou-ld-comments", "hou-ld-timeout"].forEach((id) => {
    const field = document.getElementById(id)?.closest(".field");
    if (field && field.parentElement !== route) route.appendChild(field);
  });
}

function ensureOverviewExtras() {
  const overview = panel("overview");
  if (!overview) return;

  const profile = document.getElementById("hou-ld-view-profile");
  if (profile) {
    profile.textContent = "View Driver Profile ↗";
    profile.classList.add("hou-profile-button");
  }

  // Driver data displayed in Load Details is informational. Changes to the
  // driver master record belong in Driver Profile so every board sees them.
  ["hou-ld-carrier", "hou-ld-mc", "hou-ld-rating", "hou-ld-cell", "hou-ld-dispatcher"].forEach((id) => {
    const input = document.getElementById(id);
    if (input) input.readOnly = true;
  });

  let live = overview.querySelector("#hou-live-driver-info");
  if (!live) {
    live = document.createElement("div");
    live.id = "hou-live-driver-info";
    live.className = "field-box-grid hou-live-driver-info";
    const main = overview.querySelector(".ld-overview-main") || overview;
    main.appendChild(live);
  }

  const oldRateField = document.getElementById("hou-ld-rate")?.closest(".field");
  if (oldRateField) oldRateField.classList.add("hidden");

  const rateSection = overview.querySelector(".unified-flat-rate-section");
  if (rateSection && !rateSection.querySelector("#hou-rate-summary")) {
    const summary = document.createElement("div");
    summary.id = "hou-rate-summary";
    summary.innerHTML = `
      <div class="rate-tier-grid hou-rate-summary-grid">
        <fieldset class="rate-tier-box"><legend>Driver rate on file</legend><div class="static-text" id="hou-driver-rate-on-file">—</div></fieldset>
        <fieldset class="rate-tier-box"><legend>Current load rate</legend><div class="static-text" id="hou-current-load-rate">—</div></fieldset>
      </div>
      <div class="subtext" style="margin-top:8px;">The driver rate comes from Driver Profile. The current load rate is the value on this Houston load's Rate cell.</div>`;
    rateSection.querySelector(".unified-rate-note")?.remove();
    rateSection.appendChild(summary);
  }
}

function refreshDriverOverview() {
  const row = currentRow();
  if (!row) return;
  const drv = currentDriver();
  const set = (id, value) => {
    const el = document.getElementById(id);
    if (el && document.activeElement !== el) el.value = value ?? "";
  };

  if (drv) {
    set("hou-ld-carrier", drv.carrier || row.carrier || "");
    set("hou-ld-mc", drv.mc || row.mc || "");
    set("hou-ld-rating", drv.rating || row.rating || "");
    set("hou-ld-cell", drv.phone || row.driverPhone || "");
    set("hou-ld-dispatcher", drv.dispatcherPhone || row.dispatcherPhone || "");
  }

  const live = document.getElementById("hou-live-driver-info");
  if (live) {
    live.innerHTML = drv ? `
      <fieldset class="field-box"><legend>Email</legend><div class="static-text">${esc(drv.email || "—")}</div></fieldset>
      <fieldset class="field-box"><legend>2nd Email</legend><div class="static-text">${esc(drv.email2 || "—")}</div></fieldset>
      <fieldset class="field-box"><legend>Preference</legend><div class="static-text">${esc(drv.preference || "—")}</div></fieldset>
      <fieldset class="field-box"><legend>Rate / Booking Contact</legend><div class="static-text">${esc(drv.rateBooking || "—")}</div></fieldset>
    ` : `<div class="calc-note">This load is not linked to a driver profile yet. Select the driver from the Driver field to view the saved driver information.</div>`;
  }

  const rateOnFile = document.getElementById("hou-driver-rate-on-file");
  if (rateOnFile) rateOnFile.textContent = drv ? money(drv.normalRate) : "—";
  const currentLoadRate = document.getElementById("hou-current-load-rate");
  if (currentLoadRate) currentLoadRate.textContent = money(row.normalRate);
}

async function loadNotesAndHistory() {
  const row = currentRow();
  if (!row?.dbId || !lb?.supabaseClient) {
    notes = [];
    history = [];
    lastOpenedDbId = null;
    renderNotes();
    renderHistory();
    return;
  }
  const dbId = row.dbId;
  lastOpenedDbId = dbId;
  const [notesResult, historyResult] = await Promise.all([
    lb.supabaseClient.from("houston_load_notes").select("*").eq("houston_load_id", dbId).order("created_at", { ascending: true }),
    lb.supabaseClient.from("houston_change_history").select("*").eq("houston_load_id", dbId).order("changed_at", { ascending: false }),
  ]);
  if (lastOpenedDbId !== dbId) return;
  notes = notesResult.data || [];
  history = historyResult.data || [];
  renderNotes();
  renderHistory();
}

function renderNotes() {
  const target = panel("notes");
  if (!target) return;
  const row = currentRow();
  if (!row?.dbId) {
    target.innerHTML = `<div class="subtext">Save this load first before adding permanent notes.</div>`;
    return;
  }
  const notesHtml = notes.length
    ? notes.map((n) => `
      <div class="ld-note-entry" style="margin-bottom:14px;padding-bottom:14px;border-bottom:1px solid var(--line,#e5e7eb);">
        <div style="white-space:pre-wrap;">${esc(n.note_text)}</div>
        <div class="subtext" style="margin-top:3px;">${esc(n.created_by || "unknown user")}${n.source === "board" ? " (board)" : ""} — ${new Date(n.created_at).toLocaleString()}</div>
      </div>`).join("")
    : `<div class="subtext">No notes on this load yet.</div>`;
  target.innerHTML = `
    <div class="field">
      <label for="hou-ld-note-input">Add a note</label>
      <textarea class="cell-input" id="hou-ld-note-input" rows="3" style="width:100%;" placeholder="Notes added here stay on this load's permanent log."></textarea>
      <button type="button" class="btn btn-ghost" id="hou-ld-note-submit" style="margin-top:6px;">Add Note</button>
    </div>
    <div class="calc-note" style="margin:10px 0;">Comments and Time Out / Remarks remain operational fields on the Route tab. Notes here are permanent and timestamped, like Atlanta.</div>
    <div style="margin-top:14px;">${notesHtml}</div>`;
}

async function submitNote() {
  const row = currentRow();
  const input = document.getElementById("hou-ld-note-input");
  if (!row?.dbId || !input || !lb?.supabaseClient) return;
  const text = input.value.trim();
  if (!text) return;
  const button = document.getElementById("hou-ld-note-submit");
  if (button) button.disabled = true;
  try {
    const { data: userData } = await lb.supabaseClient.auth.getUser();
    const email = userData?.user?.email || "unknown user";
    const createdBy = email.includes("@") ? email.split("@")[0] : email;
    const { data, error } = await lb.supabaseClient.from("houston_load_notes")
      .insert({ houston_load_id: row.dbId, note_text: text, source: "modal", created_by: createdBy }).select();
    if (error) throw error;
    notes.push(data[0]);
    input.value = "";
    renderNotes();
  } catch (error) {
    console.error("Could not save Houston load note", error);
    lb.setDriverSyncStatus(`Couldn't save that note (${error.message || error}).`, "error");
  } finally {
    if (button) button.disabled = false;
  }
}

function renderHistory() {
  const target = panel("history");
  if (!target) return;
  if (!currentRow()?.dbId) {
    target.innerHTML = `<div class="subtext">Save this load first to begin Change History.</div>`;
    return;
  }
  target.innerHTML = `
    <div class="ld-edit-bar"><button type="button" class="btn btn-ghost" id="hou-hist-save-notes">Save Notes</button></div>
    <div class="ld-history-row" style="grid-template-columns:130px 150px 1fr 200px;"><div>When</div><div>By</div><div>What</div><div>Note</div></div>
    ${history.length ? history.map((h) => `
      <div class="ld-history-row" style="grid-template-columns:130px 150px 1fr 200px;align-items:start;">
        <div>${new Date(h.changed_at).toLocaleString()}</div>
        <div>${esc(h.changed_by || "Unknown user")}</div>
        <div>${formatHistoryEntry(h)}</div>
        <div><input type="text" class="cell-input" style="width:100%;" data-hou-hist-note-id="${h.id}" value="${esc(h.note || "")}" placeholder="Why was this changed?"></div>
      </div>`).join("") : `<div class="subtext" style="padding:10px 0;">No changes recorded yet.</div>`}`;
}

async function saveHistoryNotes() {
  if (!lb?.supabaseClient) return;
  const button = document.getElementById("hou-hist-save-notes");
  if (button) { button.disabled = true; button.textContent = "Saving…"; }
  let failed = false;
  for (const input of document.querySelectorAll("[data-hou-hist-note-id]")) {
    const id = Number(input.dataset.houHistNoteId);
    const entry = history.find((h) => Number(h.id) === id);
    const next = input.value.trim();
    if ((entry?.note || "") === next) continue;
    const { error } = await lb.supabaseClient.from("houston_change_history").update({ note: next || null }).eq("id", id);
    if (error) failed = true;
    else if (entry) entry.note = next || null;
  }
  if (button) { button.disabled = false; button.textContent = "Save Notes"; }
  lb.setDriverSyncStatus(failed ? "Some history notes couldn't be saved." : "Notes saved.", failed ? "error" : "success");
}

async function refreshOpenModal() {
  moveOperationalNotesToRoute();
  ensureOverviewExtras();
  refreshDriverOverview();
  await loadNotesAndHistory();
}

function captureRowIdentity() {
  document.addEventListener("contextmenu", (event) => {
    const tr = event.target.closest?.("#board-table tr[id]");
    if (tr) lastContextRowId = tr.id;
  }, true);

  document.addEventListener("click", (event) => {
    const direct = event.target.closest?.("[data-open-hou-load]");
    if (direct) currentRowId = direct.dataset.openHouLoad;

    const contextItem = event.target.closest?.("#row-context-menu .context-menu-item");
    if (contextItem && /^Load Details$/i.test((contextItem.textContent || "").trim()) && lastContextRowId) currentRowId = lastContextRowId;

    if (event.target.closest?.("#hou-ld-note-submit")) void submitNote();
    if (event.target.closest?.("#hou-hist-save-notes")) void saveHistoryNotes();

    const tab = event.target.closest?.("#modal-houston-load-details [data-unified-ld-tab]")?.dataset?.unifiedLdTab;
    if (tab === "overview") setTimeout(refreshDriverOverview, 0);
    if (tab === "notes") setTimeout(renderNotes, 0);
    if (tab === "history") setTimeout(renderHistory, 0);
  }, true);

  document.addEventListener("input", (event) => {
    if (event.target?.id === "hou-ld-driver") setTimeout(refreshDriverOverview, 30);
  });
}

function observeModal() {
  const target = modal();
  if (!target) return;
  modalWasHidden = target.classList.contains("hidden");
  new MutationObserver(() => {
    const hidden = target.classList.contains("hidden");
    if (modalWasHidden && !hidden) setTimeout(() => void refreshOpenModal(), 0);
    if (!modalWasHidden && hidden) {
      currentRowId = null;
      lastOpenedDbId = null;
      notes = [];
      history = [];
    }
    modalWasHidden = hidden;
  }).observe(target, { attributes: true, attributeFilter: ["class"] });
}

function installStyles() {
  if (document.getElementById("houston-load-details-v2-style")) return;
  const style = document.createElement("style");
  style.id = "houston-load-details-v2-style";
  style.textContent = `
    #modal-houston-load-details .hou-profile-button { width:auto; height:auto; padding:4px 9px; margin-top:6px !important; font-weight:700; }
    #modal-houston-load-details .hou-live-driver-info { margin-top:10px; }
    #modal-houston-load-details .hou-rate-summary-grid { grid-template-columns:1fr; }
    #modal-houston-load-details .unified-rate-fields:empty { display:none; }
  `;
  document.head.appendChild(style);
}

async function init() {
  if ((location.pathname.split("/").pop() || "") !== "houston.html") return;
  lb = await import("./loadboard.js");
  hou = await import("./houston.js");
  installStyles();
  captureRowIdentity();

  const wait = () => {
    if (modal()?.dataset?.unifiedLd === "1") {
      moveOperationalNotesToRoute();
      ensureOverviewExtras();
      observeModal();
      return;
    }
    setTimeout(wait, 50);
  };
  wait();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => void init());
else setTimeout(() => void init(), 0);
