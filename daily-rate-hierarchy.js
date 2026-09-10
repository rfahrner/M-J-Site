/* Daily board rate hierarchy + UI.

   This module intentionally loads its dependencies dynamically after the
   page has initialized. It is imported through the shared toolbar chain,
   which itself is reached while loadboard.js is still evaluating; static
   imports back into loadboard.js here would create an avoidable module cycle.
*/

const PAGE_LOCATION = {
  "": "atlanta",
  "index.html": "atlanta",
  "dalaware.html": "delaware",
  "buildingc.html": "buildingc",
  "houston.html": "houston",
};

const LOCATION_LABEL = {
  atlanta: "Atlanta",
  delaware: "Delaware",
  buildingc: "Building C",
  houston: "Houston",
};

const SETTING_DEFS = {
  atlanta: [
    ["over_tier_per_mile", "Over-tier ($/mi)", 2.4],
    ["stop_charge_free_stops", "Free stops", 2],
    ["stop_charge_per_stop", "$/extra stop", 20],
    ["tonu_flat", "TONU flat", 150],
  ],
  delaware: [
    ["flat_minimum", "Flat minimum", 1000],
    ["per_mile", "$/mile", 4],
  ],
  buildingc: [
    ["birm_flat", "BIRM flat", 800],
    ["hostler_hourly", "Hostler $/hr", 100],
  ],
  houston: [
    ["flat_rate", "Flat rate", 0],
  ],
};

let lb = null;
let rates = null;
let houston = null;
let activeLocation = null;
let decoratingRatePanel = false;
let standardSaveTimers = new Map();
let initialized = false;

function currentFile() {
  return location.pathname.split("/").pop() || "";
}

function currentDate() {
  return document.getElementById("date-input")?.value || lb?.state?.activeDate || "";
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function waitFor(getter, timeoutMs = 12000) {
  const started = Date.now();
  return new Promise((resolve) => {
    const check = () => {
      const value = getter();
      if (value || Date.now() - started >= timeoutMs) return resolve(value || null);
      setTimeout(check, 50);
    };
    check();
  });
}

function findStandardRow(localId) {
  if (!lb?.state?.sheets) return null;
  for (const key of Object.keys(lb.state.sheets)) {
    const row = lb.state.sheets[key]?.find((item) => String(item.id) === String(localId));
    if (row) return row;
  }
  return null;
}

function activeStandardRows() {
  if (!lb?.state?.sheets) return [];
  const date = currentDate();
  const rows = [];
  for (const sheet of Object.values(lb.state.sheets)) {
    for (const row of sheet || []) {
      if ((row.location || activeLocation) === activeLocation && (row.shiftDate || date) === date) rows.push(row);
    }
  }
  return rows;
}

function scheduleStandardDbRateSave(row, numericRate) {
  if (!row?.dbId || !lb?.supabaseClient) return;
  const key = String(row.dbId);
  clearTimeout(standardSaveTimers.get(key));
  standardSaveTimers.set(key, setTimeout(async () => {
    standardSaveTimers.delete(key);
    const { error } = await lb.supabaseClient.from("loads_shifts")
      .update({ rate: numericRate > 0 ? numericRate : null, rate_manual: false })
      .eq("id", row.dbId);
    if (error) console.error("Could not persist recalculated rate", error);
  }, 250));
}

function recalcStandardRow(row) {
  if (!row || row.rateManual) return;
  const locationKey = row.location || activeLocation;
  if (!locationKey || locationKey === "houston") return;
  const breakdown = rates.calcLoadRateBreakdown(locationKey, row);
  const numericRate = Number(breakdown.total) || 0;
  const next = numericRate ? String(Math.round(numericRate * 100) / 100) : "";
  if (row.rate !== next) {
    row.rate = next;
    scheduleStandardDbRateSave(row, numericRate);
  }
  const selector = `input[data-row="${CSS.escape(String(row.id))}"][data-field="rate"]`;
  document.querySelectorAll(selector).forEach((input) => {
    if (document.activeElement !== input && input.value !== next) input.value = next;
  });
}

async function loadHoustonManualFlags() {
  if (!houston || !lb?.supabaseClient) return;
  const date = currentDate();
  if (!date) return;
  const { data, error } = await lb.supabaseClient.from("loads_houston")
    .select("id,rate_manual")
    .eq("shift_date", date);
  if (error) { console.error("Could not load Houston rate-manual flags", error); return; }
  const flags = new Map((data || []).map((row) => [String(row.id), !!row.rate_manual]));
  for (const row of houston.getHoustonSheet(date)) {
    row.__rateManual = row.dbId ? !!flags.get(String(row.dbId)) : !!row.__rateManual;
  }
}

function recalcHoustonRow(row) {
  if (!row || row.__rateManual) return;
  const synthetic = {
    location: "houston",
    shiftDate: currentDate(),
    driverId: row.driverId,
    trips: [],
  };
  const breakdown = rates.calcLoadRateBreakdown("houston", synthetic);
  const numericRate = Number(breakdown.total) || 0;
  const next = numericRate ? String(Math.round(numericRate * 100) / 100) : "";
  if (row.normalRate !== next) {
    row.normalRate = next;
    houston.scheduleHoustonRowSave(row);
  }
  const input = document.querySelector(`input[data-row="${CSS.escape(String(row.id))}"][data-field="normalRate"]`);
  if (input && document.activeElement !== input && input.value !== next) input.value = next;
}

async function recalcAllActiveRows() {
  if (!rates || !lb) return;
  if (activeLocation === "houston") {
    if (!houston) houston = await import("./houston.js");
    await loadHoustonManualFlags();
    for (const row of houston.getHoustonSheet(currentDate())) recalcHoustonRow(row);
  } else {
    for (const row of activeStandardRows()) recalcStandardRow(row);
  }
  decorateLoadDetailsRatePanel();
}

function fieldBox(label, inputHtml, note = "") {
  return `<fieldset class="rate-tier-box"><legend>${esc(label)}</legend>${inputHtml}${note ? `<div class="subtext" style="margin-top:4px;font-size:10px;">${esc(note)}</div>` : ""}</fieldset>`;
}

function baseValueForSetting(key, fallback) {
  return rates.getBaseSetting(activeLocation, key, fallback);
}

function dailySettingsMarkup(date) {
  const card = rates.getDailyRateCard(activeLocation, date);
  const defs = SETTING_DEFS[activeLocation] || [];
  return defs.map(([key, label, fallback]) => {
    const base = baseValueForSetting(key, fallback);
    const override = card.settings[key];
    return fieldBox(label,
      `<input type="number" step="0.01" data-daily-setting="${esc(key)}" value="${override != null ? esc(override) : ""}" placeholder="Base ${esc(base)}">`,
      `Permanent base: ${base}`
    );
  }).join("");
}

function baseSettingsMarkup() {
  const defs = SETTING_DEFS[activeLocation] || [];
  return defs.map(([key, label, fallback]) => {
    const base = baseValueForSetting(key, fallback);
    return fieldBox(label, `<input type="number" step="0.01" data-base-setting="${esc(key)}" value="${esc(base)}">`);
  }).join("");
}

function dailyTiersMarkup(date) {
  if (activeLocation !== "atlanta") return "";
  const tiers = rates.getBoardRateTiers()?.atlanta || [];
  const card = rates.getDailyRateCard("atlanta", date);
  return tiers.map((tier) => {
    const override = card.tiers[String(tier.id)];
    return fieldBox(`${tier.min}-${tier.max}MI`,
      `<input type="number" step="0.01" data-daily-tier="${tier.id}" value="${override != null ? esc(override) : ""}" placeholder="Base ${esc(tier.rate)}">`,
      `Permanent base: ${tier.rate}`
    );
  }).join("");
}

function baseTiersMarkup() {
  if (activeLocation !== "atlanta") return "";
  const tiers = rates.getBoardRateTiers()?.atlanta || [];
  return tiers.map((tier) => fieldBox(`${tier.min}-${tier.max}MI`,
    `<input type="number" step="0.01" data-base-tier="${tier.id}" value="${esc(tier.rate)}">`
  )).join("");
}

function openRateSettings() {
  if (!activeLocation || !rates) return;
  document.getElementById("modal-daily-rate-settings")?.remove();
  const date = currentDate();
  const label = LOCATION_LABEL[activeLocation] || activeLocation;
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  overlay.id = "modal-daily-rate-settings";
  overlay.innerHTML = `
    <div class="modal modal-large" style="max-width:760px;">
      <div class="modal-header">
        <h3>${esc(label)} Rate Settings — ${esc(date)}</h3>
        <button class="modal-close" data-rate-close>&times;</button>
      </div>
      <div class="modal-body">
        <div class="calc-note" style="margin-bottom:14px;">
          <strong>Rate order:</strong> manual Rate cell &gt; higher of driver negotiated rate or today's location rate &gt; permanent base.
          Blank today's fields use the permanent base. Today's changes apply only to ${esc(date)}.
        </div>
        <h4 style="margin:0 0 8px;">Today's location rate</h4>
        <div class="subtext" style="margin-bottom:8px;">Enter only what is different today. Clear a field to fall back to the permanent base.</div>
        <div class="rate-tier-grid">${dailyTiersMarkup(date)}${dailySettingsMarkup(date)}</div>
        <h4 style="margin:20px 0 8px;">Permanent base rate</h4>
        <div class="subtext" style="margin-bottom:8px;">These values carry forward to every date that does not have a daily override.</div>
        <div class="rate-tier-grid">${baseTiersMarkup()}${baseSettingsMarkup()}</div>
        <div id="daily-rate-status" class="subtext" style="min-height:18px;margin-top:12px;"></div>
      </div>
      <div class="modal-footer"><button class="btn" data-rate-close>Done</button></div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay || event.target.closest("[data-rate-close]")) overlay.remove();
  });
  overlay.addEventListener("change", (event) => void saveRateSettingChange(event.target, date));
}

async function saveRateSettingChange(input, date) {
  if (!(input instanceof HTMLInputElement)) return;
  const status = document.getElementById("daily-rate-status");
  if (status) status.textContent = "Saving…";
  let ok = false;
  if (input.dataset.dailyTier) {
    ok = await rates.saveDailyTierRate(activeLocation, date, input.dataset.dailyTier, input.value);
  } else if (input.dataset.dailySetting) {
    ok = await rates.saveDailySetting(activeLocation, date, input.dataset.dailySetting, input.value);
  } else if (input.dataset.baseTier) {
    ok = input.value.trim() !== "" && await rates.saveTierRate(Number(input.dataset.baseTier), Number(input.value));
  } else if (input.dataset.baseSetting) {
    ok = input.value.trim() !== "" && await rates.saveSetting(activeLocation, input.dataset.baseSetting, Number(input.value));
  } else {
    return;
  }
  if (status) status.textContent = ok ? "Rate saved." : "Couldn't save that rate.";
  if (ok) {
    await recalcAllActiveRows();
    // Refresh placeholders/base notes after a permanent-base edit while
    // keeping the modal open and the user's daily overrides intact.
    if (input.dataset.baseTier || input.dataset.baseSetting) {
      const wasDaily = document.getElementById("modal-daily-rate-settings");
      if (wasDaily) {
        const focused = document.activeElement;
        const dailyInputs = [...wasDaily.querySelectorAll("[data-daily-tier],[data-daily-setting]")].map((el) => [el.dataset.dailyTier || el.dataset.dailySetting, el.value]);
        // Reopening is the simplest way to refresh all permanent-base labels.
        openRateSettings();
        void focused;
        void dailyInputs;
      }
    }
  }
}

function ensureRateSettingsButton() {
  if (!activeLocation) return;
  let button = document.getElementById("btn-atlanta-rate-settings");
  if (!button) {
    const info = document.getElementById("btn-page-info");
    if (!info) return;
    button = document.createElement("button");
    button.type = "button";
    button.id = "btn-atlanta-rate-settings";
    button.className = "btn btn-ghost";
    button.textContent = "$";
    button.title = "Rate Settings";
    button.setAttribute("aria-label", "Rate Settings");
    info.insertAdjacentElement("afterend", button);
  }
  button.dataset.dailyRateSettings = "1";
}

function decorateLoadDetailsRatePanel() {
  if (decoratingRatePanel || !lb?.loadDetailsState || activeLocation === "houston") return;
  const section = document.querySelector("#ld-tab-content .rate-section");
  if (!section) return;
  const row = findStandardRow(lb.loadDetailsState.rowId);
  if (!row) return;
  decoratingRatePanel = true;
  try {
    const date = row.shiftDate || currentDate();
    const explanation = section.querySelector(":scope > .subtext");
    const copy = `Rate card for ${date}. Date-specific location rates replace the permanent base for this day; negotiated driver rates are a floor; a manual total overrides both.`;
    if (explanation && explanation.textContent !== copy) explanation.textContent = copy;

    const tiers = rates.getBoardRateTiers()?.[row.location || activeLocation] || [];
    section.querySelectorAll("[data-rate-tier-id]").forEach((input) => {
      const tier = tiers.find((item) => String(item.id) === String(input.dataset.rateTierId));
      if (!tier) return;
      const dayValue = rates.getDailyTierValue(row.location || activeLocation, date, tier);
      if (document.activeElement !== input) input.value = dayValue;
      input.title = `Today's location value. Permanent base: ${tier.rate}`;
    });
    section.querySelectorAll("[data-rate-setting-key]").forEach((input) => {
      const def = (SETTING_DEFS[row.location || activeLocation] || []).find(([key]) => key === input.dataset.rateSettingKey);
      const fallback = def?.[2] ?? 0;
      const base = rates.getBaseSetting(row.location || activeLocation, input.dataset.rateSettingKey, fallback);
      const dayValue = rates.getDailySettingValue(row.location || activeLocation, date, input.dataset.rateSettingKey, fallback);
      if (document.activeElement !== input) input.value = dayValue;
      input.title = `Today's location value. Permanent base: ${base}`;
    });

    const breakdown = rates.calcLoadRateBreakdown(row.location || activeLocation, row);
    if (!row.rateManual) {
      const total = Number(breakdown.total) || 0;
      const next = total ? String(Math.round(total * 100) / 100) : "";
      row.rate = next;
      const totalInput = document.getElementById("ld-rate-total");
      if (totalInput && document.activeElement !== totalInput) totalInput.value = next;
    }
    const box = section.querySelector(".rate-breakdown");
    if (box) {
      const lines = (breakdown.lines || []).map((line) => `
        <div class="rate-breakdown-row"><span>${esc(line.label)}</span><span class="subtext">${esc(line.detail || "")}</span><span>${money(line.amount)}</span></div>`).join("");
      const html = `<div class="rate-section-subheader">How this was calculated</div>${lines || `<div class="subtext" style="padding:6px 0;">${esc(breakdown.note || "Nothing to calculate yet.")}</div>`}${breakdown.lines?.length ? `<div class="rate-breakdown-row rate-breakdown-total"><span>Total</span><span></span><span>${money(breakdown.total)}</span></div>` : ""}`;
      const sig = `${row.id}|${row.rateManual}|${JSON.stringify(breakdown)}`;
      if (box.dataset.hierarchySig !== sig) {
        box.dataset.hierarchySig = sig;
        box.innerHTML = html;
      }
    }
  } finally {
    decoratingRatePanel = false;
  }
}

async function markHoustonManual(row, manual) {
  if (!row) return;
  row.__rateManual = manual;
  const persist = async () => {
    if (!row.dbId || !lb?.supabaseClient) return false;
    const { error } = await lb.supabaseClient.from("loads_houston").update({ rate_manual: manual }).eq("id", row.dbId);
    if (error) console.error("Could not save Houston manual-rate flag", error);
    return !error;
  };
  if (await persist()) return;
  setTimeout(() => void persist(), 900);
}

function relevantStandardEventField(field) {
  return ["routeId", "tripId", "routeMiles", "stopCount", "driverName"].includes(field);
}

function installEventGuards() {
  // Capture Rate Settings clicks before the legacy Atlanta-only handler.
  document.addEventListener("click", (event) => {
    const settingsButton = event.target.closest("#btn-atlanta-rate-settings");
    if (settingsButton && activeLocation) {
      event.preventDefault();
      event.stopImmediatePropagation();
      openRateSettings();
      return;
    }
  }, true);

  // The old Load Details tier boxes were load-specific. Under the new
  // hierarchy those boxes are the current day's location card, so capture
  // their changes and save date-scoped values before the old handler sees it.
  document.addEventListener("change", (event) => {
    const input = event.target.closest?.("#ld-tab-content [data-rate-tier-id], #ld-tab-content [data-rate-setting-key]");
    if (!input || !lb?.loadDetailsState) return;
    const row = findStandardRow(lb.loadDetailsState.rowId);
    if (!row) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const date = row.shiftDate || currentDate();
    const promise = input.dataset.rateTierId
      ? rates.saveDailyTierRate(row.location || activeLocation, date, input.dataset.rateTierId, input.value)
      : rates.saveDailySetting(row.location || activeLocation, date, input.dataset.rateSettingKey, input.value);
    void promise.then(async (ok) => {
      if (!ok) return;
      await recalcAllActiveRows();
      decorateLoadDetailsRatePanel();
    });
  }, true);

  document.addEventListener("input", (event) => {
    const input = event.target;
    const localId = input?.dataset?.row;
    const field = input?.dataset?.field;
    if (!localId || !field) return;

    if (activeLocation === "houston" && field === "normalRate") {
      const row = houston?.findHoustonRowAnywhere(localId)?.row;
      if (!row) return;
      const manual = String(input.value || "").trim() !== "";
      void markHoustonManual(row, manual).then(() => {
        if (!manual) setTimeout(() => recalcHoustonRow(row), 0);
      });
      return;
    }

    if (activeLocation !== "houston") {
      const row = findStandardRow(localId);
      if (!row) return;
      if (field === "rate") {
        // loadboard.js owns the actual rateManual flag; run after its table
        // input handler so clearing a manual value gets the correct calc.
        setTimeout(() => recalcStandardRow(row), 0);
      } else if (relevantStandardEventField(field)) {
        setTimeout(() => recalcStandardRow(row), 0);
      }
    }
  });

  document.addEventListener("change", (event) => {
    const target = event.target;
    if (target?.id === "ld-route-type-select" || target?.id === "ld-hostler-hours") {
      setTimeout(() => {
        const row = lb?.loadDetailsState ? findStandardRow(lb.loadDetailsState.rowId) : null;
        if (row) recalcStandardRow(row);
      }, 0);
    }
  });

  document.addEventListener("click", (event) => {
    const action = event.target.closest?.("[data-action]")?.dataset?.action;
    if (["toggle-tonu", "add-trip", "delete-trip", "complete-trip", "minimize-trip", "restore-trip"].includes(action)) {
      setTimeout(() => void recalcAllActiveRows(), 30);
    }
    if (event.target.closest?.("[data-pick-driver], [data-ld-save]")) {
      setTimeout(() => void recalcAllActiveRows(), 80);
    }
  });
}

function observeBoard() {
  const board = document.getElementById("board-table");
  if (board) {
    let timer = null;
    new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => void recalcAllActiveRows(), 80);
    }).observe(board, { childList: true, subtree: true });
  }
  const modalBody = document.getElementById("ld-tab-content");
  if (modalBody) {
    let timer = null;
    new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(decorateLoadDetailsRatePanel, 20);
    }).observe(modalBody, { childList: true, subtree: true });
  }
  const dateInput = document.getElementById("date-input");
  dateInput?.addEventListener("change", () => setTimeout(() => void recalcAllActiveRows(), 100));
}

function installStyles() {
  if (document.getElementById("daily-rate-hierarchy-style")) return;
  const style = document.createElement("style");
  style.id = "daily-rate-hierarchy-style";
  style.textContent = `
    #modal-daily-rate-settings .rate-tier-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:9px; }
    #modal-daily-rate-settings .rate-tier-box input { width:100%; min-width:0; }
    @media (max-width:620px) { #modal-daily-rate-settings .rate-tier-grid { grid-template-columns:1fr; } }
  `;
  document.head.appendChild(style);
}

async function init() {
  if (initialized) return;
  activeLocation = PAGE_LOCATION[currentFile()] || null;
  if (!activeLocation) return;
  initialized = true;

  lb = await import("./loadboard.js");
  rates = await import("./boardrates.js");
  await waitFor(() => lb.supabaseClient);
  await rates.loadBoardRateData();
  if (activeLocation === "houston") houston = await import("./houston.js");

  installStyles();
  ensureRateSettingsButton();
  installEventGuards();
  observeBoard();

  // The shared toolbar and board are both dynamic, so keep the rate button
  // present after any redraw and let the board settle before first calc.
  new MutationObserver(() => ensureRateSettingsButton()).observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(() => void recalcAllActiveRows(), 250);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => void init());
else setTimeout(() => void init(), 0);
