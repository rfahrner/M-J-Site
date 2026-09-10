const CONFIG = {
  "houston.html": {
    modal: "#modal-houston-load-details",
    overview: ["hou-ld-driver", "hou-ld-aljex", "hou-ld-time", "hou-ld-carrier", "hou-ld-mc", "hou-ld-rating", "hou-ld-cell", "hou-ld-dispatcher"],
    route: ["hou-ld-ttc", "hou-ld-ttt"],
    notes: ["hou-ld-comments", "hou-ld-timeout"],
    rate: ["hou-ld-rate"],
    imagesCopy: "Trip Sheet Images for Houston are attached from the Image cell on the load board. This tab is kept here so Load Details has the same layout as the other locations.",
    historyCopy: "Change History is not yet recorded field-by-field for Houston loads. This tab is reserved so every Load Details window uses the same layout."
  },
  "mondelez.html": {
    modal: "#modal-mdz-load-details",
    overview: ["mdz-ld-location", "mdz-ld-driver", "mdz-ld-aljex", "mdz-ld-start"],
    route: ["mdz-ld-group", "mdz-ld-driverapp", "mdz-ld-trailer", "mdz-ld-returntrailer", "mdz-ld-stops", "mdz-ld-miles"],
    notes: ["mdz-ld-notes"],
    rate: ["mdz-ld-carrierpay", "mdz-ld-fsc", "mdz-ld-additional", "mdz-ld-revenue"],
    imagesCopy: "Trip Sheet Images for Mondelez are attached from the Image cell on the load board. This tab is kept here so Load Details has the same layout as the other locations.",
    historyCopy: "Change History is not yet recorded field-by-field for Mondelez loads. This tab is reserved so every Load Details window uses the same layout."
  }
};

function currentFile() {
  return location.pathname.split("/").pop() || "";
}

function fieldFor(id) {
  const input = document.getElementById(id);
  return input ? input.closest(".field") : null;
}

function moveFields(ids, target) {
  ids.forEach((id) => {
    const field = fieldFor(id);
    if (field) target.appendChild(field);
  });
}

function makePanel(key, active = false) {
  const panel = document.createElement("div");
  panel.className = `unified-ld-panel${active ? "" : " hidden"}`;
  panel.dataset.unifiedLdPanel = key;
  return panel;
}

function activate(modal, key) {
  modal.querySelectorAll("[data-unified-ld-tab]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.unifiedLdTab === key);
  });
  modal.querySelectorAll("[data-unified-ld-panel]").forEach((panel) => {
    panel.classList.toggle("hidden", panel.dataset.unifiedLdPanel !== key);
  });
}

function standardizeModal(config) {
  const modal = document.querySelector(config.modal);
  if (!modal || modal.dataset.unifiedLd === "1") return;
  const card = modal.querySelector(":scope > .modal");
  const body = card?.querySelector(":scope > .modal-body");
  const header = card?.querySelector(":scope > .modal-header");
  if (!card || !body || !header) return;

  modal.dataset.unifiedLd = "1";
  card.classList.add("modal-large", "unified-load-details-modal");

  const tabs = document.createElement("div");
  tabs.className = "modal-tabs unified-ld-tabs";
  const tabDefs = [
    ["overview", "Overview"],
    ["notes", "Notes"],
    ["route", "Route"],
    ["images", "Trip Sheet Images"],
    ["history", "Change History"]
  ];
  tabs.innerHTML = tabDefs.map(([key, label], index) =>
    `<button type="button" class="ld-tab${index === 0 ? " is-active" : ""}" data-unified-ld-tab="${key}">${label}</button>`
  ).join("");
  header.insertAdjacentElement("afterend", tabs);

  const originalFields = [...body.children];
  body.innerHTML = "";

  const overview = makePanel("overview", true);
  const notes = makePanel("notes");
  const route = makePanel("route");
  const images = makePanel("images");
  const history = makePanel("history");

  const overviewGrid = document.createElement("div");
  overviewGrid.className = "ld-overview-grid";
  const overviewMain = document.createElement("div");
  overviewMain.className = "ld-overview-main";
  const overviewFields = document.createElement("div");
  overviewFields.className = "field-box-grid unified-field-grid";
  const overviewSide = document.createElement("div");
  overviewSide.className = "ld-overview-side";
  const rateSection = document.createElement("fieldset");
  rateSection.className = "rate-section unified-flat-rate-section";
  rateSection.innerHTML = `<legend class="rate-section-header">Rate</legend><div class="subtext unified-rate-note">This location keeps its own rate logic; only the Load Details layout is standardized.</div>`;
  const rateFields = document.createElement("div");
  rateFields.className = "unified-rate-fields";
  rateSection.appendChild(rateFields);

  overviewMain.appendChild(overviewFields);
  overviewSide.appendChild(rateSection);
  overviewGrid.append(overviewMain, overviewSide);
  overview.appendChild(overviewGrid);

  const notesGrid = document.createElement("div");
  notesGrid.className = "field-box-grid unified-field-grid";
  notes.appendChild(notesGrid);
  const routeGrid = document.createElement("div");
  routeGrid.className = "field-box-grid unified-field-grid";
  route.appendChild(routeGrid);

  images.innerHTML = `<div class="unified-placeholder"><strong>Trip Sheet Images</strong><div class="subtext">${config.imagesCopy}</div></div>`;
  history.innerHTML = `<div class="unified-placeholder"><strong>Change History</strong><div class="subtext">${config.historyCopy}</div></div>`;

  body.append(overview, notes, route, images, history);

  // Move the existing live form controls rather than recreating them. That
  // preserves every existing id and all of the location-specific save logic.
  moveFields(config.overview, overviewFields);
  moveFields(config.rate, rateFields);
  moveFields(config.notes, notesGrid);
  moveFields(config.route, routeGrid);

  // If a future field is added to the old modal and isn't explicitly mapped,
  // keep it visible on Overview rather than silently losing it.
  originalFields.forEach((field) => {
    if (field.isConnected && field.parentElement === body) overviewFields.appendChild(field);
  });

  // Give legacy .field blocks the same card-like visual rhythm as Atlanta's
  // fieldsets without replacing the actual controls.
  modal.querySelectorAll(".unified-field-grid > .field, .unified-rate-fields > .field").forEach((field) => {
    field.classList.add("unified-field-box");
  });

  tabs.addEventListener("click", (event) => {
    const button = event.target.closest("[data-unified-ld-tab]");
    if (!button) return;
    activate(modal, button.dataset.unifiedLdTab);
  });

  // Each time the legacy open function shows the modal, return to Overview so
  // Houston/Mondelez behave like opening a fresh Atlanta Load Details window.
  let wasHidden = modal.classList.contains("hidden");
  new MutationObserver(() => {
    const hidden = modal.classList.contains("hidden");
    if (wasHidden && !hidden) activate(modal, "overview");
    wasHidden = hidden;
  }).observe(modal, { attributes: true, attributeFilter: ["class"] });
}

function installStyles() {
  if (document.getElementById("unified-load-modal-styles")) return;
  const style = document.createElement("style");
  style.id = "unified-load-modal-styles";
  style.textContent = `
    .unified-load-details-modal { max-width: 980px !important; }
    .unified-ld-tabs { overflow-x:auto; flex-wrap:nowrap; }
    .unified-ld-tabs .ld-tab { white-space:nowrap; }
    .unified-field-grid { align-items:start; }
    .unified-field-box {
      border:1px solid var(--line, #d7dde5);
      border-radius:8px;
      padding:9px 10px 10px;
      margin:0 !important;
      min-width:0;
      background:var(--surface, #fff);
    }
    .unified-field-box > label { font-size:11px; font-weight:700; margin-bottom:5px; display:block; }
    .unified-field-box .cell-input, .unified-field-box input, .unified-field-box textarea, .unified-field-box select { width:100%; box-sizing:border-box; }
    .unified-flat-rate-section { min-height:100%; }
    .unified-rate-note { margin:-2px 0 8px; }
    .unified-rate-fields { display:grid; gap:8px; }
    .unified-rate-fields .field { margin:0; }
    .unified-placeholder { border:1px solid var(--line, #d7dde5); border-radius:8px; padding:18px; background:var(--surface, #fff); }
    .unified-placeholder strong { display:block; margin-bottom:6px; }
    @media (max-width:760px) {
      .unified-load-details-modal .ld-overview-grid { grid-template-columns:1fr !important; }
    }
  `;
  document.head.appendChild(style);
}

function init() {
  const config = CONFIG[currentFile()];
  if (!config) return;
  installStyles();
  standardizeModal(config);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
