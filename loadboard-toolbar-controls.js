import './preshift-pro-text.js';
import './delaware-rate-tiers.js';
import './daily-rate-hierarchy.js';
import './daily-rate-modal-sync.js';
import './unified-load-modals.js';
import './houston-load-details-v2.js';
import './board-row-hover-enhancements.js';
import './daily-board-notes.js';
import './board-cell-focus-guard.js';
import './load-details-image-draft-guard.js';
import './load-overview-timesheet-image-click-fix.js';
import './route-completion-integrity.js';

const BOARD_LOCATION_BY_FILE = {
  "": "atlanta",
  "index.html": "atlanta",
  "dalaware.html": "delaware",
  "buildingc.html": "atlanta",
  "houston.html": "houston",
  "mondelez.html": "mondelez",
};

function currentFile() {
  return location.pathname.split("/").pop() || "";
}

function removeDriverListNav() {
  const tabs = document.getElementById("tabs");
  if (!tabs) return;
  [...tabs.children].forEach((child) => {
    const href = child.getAttribute?.("href") || "";
    const text = (child.textContent || "").trim().toLowerCase();
    if (href.includes("driverlist.html") || text === "driver list") child.remove();
  });
}

function iconOnly(button, icon, label) {
  if (!button) return;
  if (!button.classList.contains("board-toolbar-icon-button")) button.classList.add("board-toolbar-icon-button");
  if (button.textContent !== icon) button.textContent = icon;
  if (button.title !== label) button.title = label;
  if (button.getAttribute("aria-label") !== label) button.setAttribute("aria-label", label);
  if (button.hasAttribute("style")) button.removeAttribute("style");
}

function driverListLocation() {
  return BOARD_LOCATION_BY_FILE[currentFile()] || null;
}

function ensureDriverListButton() {
  const locationKey = driverListLocation();
  const title = document.getElementById("sheet-title");
  if (!locationKey || !title) return;

  const titleRow = title.parentElement;
  if (!titleRow) return;
  titleRow.classList.add("board-title-row");

  if (document.getElementById("btn-driver-list-board")) return;
  const button = document.createElement("button");
  button.type = "button";
  button.id = "btn-driver-list-board";
  button.className = "btn board-driver-list-button";
  button.textContent = "Driver List";
  button.title = "Open Driver List";
  button.addEventListener("click", () => {
    location.href = `driverlist.html?location=${encodeURIComponent(locationKey)}`;
  });
  title.insertAdjacentElement("afterend", button);
}

function normalizeBoardToolbar() {
  removeDriverListNav();
  if (!driverListLocation()) return;
  ensureDriverListButton();
  iconOnly(document.getElementById("btn-page-info"), "ⓘ", "Info");
  iconOnly(document.getElementById("btn-atlanta-rate-settings"), "$", "Rate Settings");
  iconOnly(document.getElementById("btn-email-list"), "✉", "Email List");
  document.getElementById("btn-add-load")?.remove();
  const empty = document.getElementById("board-empty-state");
  if (empty && /\+ Add Load/i.test(empty.textContent || "")) empty.textContent = "No loads yet for this day.";
}

function openRequestedDriverListTab() {
  if (currentFile() !== "driverlist.html") return;
  const requested = new URLSearchParams(location.search).get("location");
  if (!requested) return;
  const allowed = new Set(["atlanta", "delaware", "houston", "mondelez", "preferred"]);
  if (!allowed.has(requested)) return;
  setTimeout(() => document.querySelector(`#driverlist-location-tabs .location-tab[data-location="${requested}"]`)?.click(), 0);
}

function installStyles() {
  if (document.getElementById("board-toolbar-redesign-styles")) return;
  const style = document.createElement("style");
  style.id = "board-toolbar-redesign-styles";
  style.textContent = `
    .board-title-row { display:flex !important; align-items:center !important; gap:8px !important; flex-wrap:wrap; }
    .board-driver-list-button { min-height:36px; padding:7px 18px !important; margin-left:8px; font-size:14px !important; font-weight:750; white-space:nowrap; }
    .board-toolbar-icon-button { width:34px !important; height:34px !important; min-width:34px !important; min-height:34px !important; padding:0 !important; margin-left:0 !important; display:inline-flex !important; align-items:center !important; justify-content:center !important; font-size:17px !important; line-height:1 !important; }
  `;
  document.head.appendChild(style);
}

function init() {
  installStyles();
  normalizeBoardToolbar();
  openRequestedDriverListTab();

  // These modules import loadboard.js themselves, so load them only after the
  // main board module has finished initializing rather than creating a static
  // import cycle through alerts -> paperwork -> email-list -> toolbar.
  if (driverListLocation()) {
    import('./unified-board-image-cells.js').catch((e) => console.error('Failed to load shared image cells:', e));
    import('./image-gallery-scroll-fix.js').catch((e) => console.error('Failed to load paged image viewer:', e));
  }

  // The same Load Details modal can be opened from a load board or Accounting.
  // Install the time-sheet completion behavior first so its capture listener
  // normalizes the final values before the save-integrity guard snapshots them.
  if (driverListLocation() || currentFile() === 'accounting.html') {
    import('./timesheet-completion-flow.js')
      .then(() => Promise.all([
        import('./timesheet-image-preview.js'),
        import('./load-overview-timesheet-image.js'),
        import('./load-details-integrity.js'),
      ]))
      .catch((e) => console.error('Failed to load Load Details completion/integrity helpers:', e));
  }

  if (currentFile() === "mondelez.html") {
    import('./mondelez-completed-row-layout.js').catch((e) => console.error('Failed to load Mondelez completed-row layout:', e));
  }
  const observer = new MutationObserver(() => normalizeBoardToolbar());
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();