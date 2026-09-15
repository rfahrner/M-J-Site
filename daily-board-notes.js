/*
 * Daily board notes.
 *
 * Adds a small sticky-note button beside the Email List button on each load
 * board. Notes are scoped to the board/location AND the currently selected
 * date, so changing days gives you a separate note automatically.
 *
 * Reuses the existing location_notes table with a namespaced location key;
 * no database migration is needed and the notes stay shared between users.
 */

const SUPABASE_URL = "https://ygsapysqzwrpcimgvaqx.supabase.co";
const SUPABASE_KEY = "sb_publishable_8b8bSIiYm5TzLTw0WG1pAw_5ZWW5ZPL";
const LOAD_BOARD_FILES = new Set(["", "index.html", "dalaware.html", "buildingc.html", "houston.html", "mondelez.html"]);

let client = null;
let loadingToken = 0;

function currentFile() {
  return location.pathname.split("/").pop() || "";
}

function isLoadBoardPage() {
  return LOAD_BOARD_FILES.has(currentFile());
}

function getClient() {
  if (client) return client;
  if (!window.supabase) return null;
  client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: "dl-dispatch-auth" },
  });
  return client;
}

function boardScope() {
  const file = currentFile();
  if (file === "" || file === "index.html") return "atlanta";
  if (file === "dalaware.html") return "delaware";
  if (file === "buildingc.html") return "buildingc";
  if (file === "houston.html") return "houston";
  if (file === "mondelez.html") {
    const loc = new URLSearchParams(location.search).get("loc") ||
      document.querySelector('[data-mdz-tab].is-active')?.dataset.mdzTab ||
      "combined";
    return `mondelez-${loc}`;
  }
  return file.replace(/\.html$/i, "") || "board";
}

function selectedDate() {
  const dateInput = document.getElementById("date-input");
  if (dateInput?.value) return dateInput.value;
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function noteKey(scope, date) {
  return `daily:${scope}:${date}`;
}

function humanDate(date) {
  const parts = String(date || "").split("-").map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return date || "";
  return new Date(parts[0], parts[1] - 1, parts[2]).toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", year: "numeric",
  });
}

function boardLabel() {
  const title = (document.getElementById("sheet-title")?.textContent || "").trim();
  if (title) return title.replace(/\s+Spreadsheet$/i, "");
  const scope = boardScope();
  return scope.split("-").map((word) => word ? word[0].toUpperCase() + word.slice(1) : word).join(" ");
}

function ensureStyles() {
  if (document.getElementById("daily-board-notes-styles")) return;
  const style = document.createElement("style");
  style.id = "daily-board-notes-styles";
  style.textContent = `
    #btn-daily-board-notes { position:relative; }
    .daily-board-note-icon {
      position:relative;
      display:block;
      width:17px;
      height:18px;
      border:1.5px solid #5f5317;
      border-radius:2px;
      background:#f7df68;
      box-shadow:0 1px 1px rgba(15,23,42,.12);
    }
    .daily-board-note-icon::before {
      content:"";
      position:absolute;
      top:-1.5px;
      right:-1.5px;
      width:6px;
      height:6px;
      background:linear-gradient(225deg, #fff 49%, #d0b743 50%);
      border-left:1px solid #5f5317;
      border-bottom:1px solid #5f5317;
    }
    .daily-board-note-icon::after {
      content:"";
      position:absolute;
      left:3px;
      right:3px;
      top:8px;
      height:1px;
      background:#8c7b28;
      box-shadow:0 3px 0 #8c7b28;
      opacity:.75;
    }
    #modal-daily-board-notes .modal { width:min(680px, calc(100vw - 32px)); }
    #daily-board-notes-text {
      width:100%;
      min-height:300px;
      resize:vertical;
      font:13px/1.45 var(--font-ui, "Segoe UI", sans-serif);
    }
    #daily-board-notes-context { margin-bottom:8px; }
    #daily-board-notes-status { min-height:18px; margin-right:auto; font-size:12px; color:var(--slate-500,#64748b); }
    #daily-board-notes-status.is-error { color:#b91c1c; font-weight:700; }
    #daily-board-notes-status.is-success { color:#15803d; font-weight:700; }
  `;
  document.head.appendChild(style);
}

function ensureModal() {
  let modal = document.getElementById("modal-daily-board-notes");
  if (modal) return modal;

  modal = document.createElement("div");
  modal.id = "modal-daily-board-notes";
  modal.className = "overlay hidden";
  modal.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <h3 id="daily-board-notes-title">Daily Notes</h3>
        <button class="modal-close" id="daily-board-notes-close" type="button">&times;</button>
      </div>
      <div class="modal-body">
        <div class="subtext" id="daily-board-notes-context"></div>
        <textarea class="cell-input" id="daily-board-notes-text" placeholder="Notes for this day…"></textarea>
      </div>
      <div class="modal-footer">
        <div id="daily-board-notes-status"></div>
        <button class="btn btn-ghost" id="daily-board-notes-cancel" type="button">Close</button>
        <button class="btn" id="daily-board-notes-save" type="button">Save</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  const close = () => modal.classList.add("hidden");
  modal.addEventListener("click", (event) => { if (event.target === modal) close(); });
  modal.querySelector("#daily-board-notes-close")?.addEventListener("click", close);
  modal.querySelector("#daily-board-notes-cancel")?.addEventListener("click", close);
  modal.querySelector("#daily-board-notes-save")?.addEventListener("click", saveNotes);
  return modal;
}

function installButton() {
  if (!isLoadBoardPage() || document.getElementById("btn-daily-board-notes")) return;
  const infoButton = document.getElementById("btn-page-info");
  if (!infoButton?.parentElement) return;

  const button = document.createElement("button");
  button.type = "button";
  button.id = "btn-daily-board-notes";
  button.className = "btn btn-ghost board-toolbar-icon-button";
  button.title = "Daily Notes";
  button.setAttribute("aria-label", "Daily Notes");
  button.innerHTML = `<span class="daily-board-note-icon" aria-hidden="true"></span>`;
  button.addEventListener("click", openNotes);

  const emailButton = document.getElementById("btn-email-list");
  if (emailButton?.parentElement === infoButton.parentElement) emailButton.insertAdjacentElement("afterend", button);
  else infoButton.insertAdjacentElement("afterend", button);
}

async function openNotes() {
  const modal = ensureModal();
  const date = selectedDate();
  const scope = boardScope();
  const key = noteKey(scope, date);
  const token = ++loadingToken;
  const text = modal.querySelector("#daily-board-notes-text");
  const status = modal.querySelector("#daily-board-notes-status");

  modal.dataset.noteKey = key;
  modal.dataset.noteDate = date;
  modal.dataset.noteScope = scope;
  modal.querySelector("#daily-board-notes-title").textContent = "Daily Notes";
  modal.querySelector("#daily-board-notes-context").textContent = `${boardLabel()} — ${humanDate(date)}`;
  text.value = "";
  text.disabled = true;
  status.className = "";
  status.textContent = "Loading…";
  modal.classList.remove("hidden");

  const c = getClient();
  if (!c) {
    text.disabled = false;
    status.className = "is-error";
    status.textContent = "Notes are unavailable because the database connection did not load.";
    return;
  }

  try {
    const { data, error } = await c.from("location_notes").select("notes").eq("location", key).maybeSingle();
    if (error) throw error;
    if (token !== loadingToken || modal.classList.contains("hidden")) return;
    text.value = data?.notes || "";
    status.textContent = "";
    text.disabled = false;
    requestAnimationFrame(() => text.focus());
  } catch (error) {
    console.error("Daily notes load failed:", error);
    if (token !== loadingToken) return;
    text.disabled = false;
    status.className = "is-error";
    status.textContent = `Could not load these notes (${error.message || error}).`;
  }
}

async function saveNotes() {
  const modal = ensureModal();
  const key = modal.dataset.noteKey;
  const text = modal.querySelector("#daily-board-notes-text");
  const status = modal.querySelector("#daily-board-notes-status");
  const saveButton = modal.querySelector("#daily-board-notes-save");
  if (!key || !text || !status || !saveButton) return;

  const c = getClient();
  if (!c) {
    status.className = "is-error";
    status.textContent = "Could not save because the database connection is unavailable.";
    return;
  }

  saveButton.disabled = true;
  saveButton.textContent = "Saving…";
  status.className = "";
  status.textContent = "";
  try {
    const { error } = await c.from("location_notes").upsert({
      location: key,
      notes: text.value,
      updated_at: new Date().toISOString(),
    }, { onConflict: "location" });
    if (error) throw error;
    status.className = "is-success";
    status.textContent = "Saved.";
    setTimeout(() => {
      if (!modal.classList.contains("hidden") && status.textContent === "Saved.") status.textContent = "";
    }, 1400);
  } catch (error) {
    console.error("Daily notes save failed:", error);
    status.className = "is-error";
    status.textContent = `Could not save (${error.message || error}).`;
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = "Save";
  }
}

function normalizePlacement() {
  const button = document.getElementById("btn-daily-board-notes");
  const emailButton = document.getElementById("btn-email-list");
  if (!button) { installButton(); return; }
  if (emailButton?.parentElement && button.parentElement === emailButton.parentElement && emailButton.nextElementSibling !== button) {
    emailButton.insertAdjacentElement("afterend", button);
  }
}

function init() {
  if (!isLoadBoardPage()) return;
  ensureStyles();
  ensureModal();
  installButton();
  const observer = new MutationObserver(normalizePlacement);
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
