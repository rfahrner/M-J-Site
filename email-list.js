import "./loadboard-toolbar-controls.js";

/* Shared Email List modal for Atlanta, Delaware, Building C, Houston, and Mondelez.
   Reads the currently rendered board so the list matches the user's visible order.
   Copy writes both HTML and TSV clipboard formats: rich email clients preserve the
   grid, while Excel/plain-text targets still receive aligned columns. */

const SUPABASE_URL = "https://ygsapysqzwrpcimgvaqx.supabase.co";
const SUPABASE_KEY = "sb_publishable_8b8bSIiYm5TzLTw0WG1pAw_5ZWW5ZPL";
const LOAD_BOARD_FILES = new Set(["", "index.html", "dalaware.html", "buildingc.html", "houston.html", "mondelez.html"]);
let emailListClient = null;
let currentRows = [];

function currentFile() {
  return location.pathname.split("/").pop() || "";
}

function isLoadBoardPage() {
  return LOAD_BOARD_FILES.has(currentFile());
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function clean(value) {
  const text = String(value ?? "").trim();
  return text === "—" ? "" : text;
}

function getEmailListClient() {
  if (emailListClient) return emailListClient;
  if (!window.supabase) return null;
  emailListClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: "dl-dispatch-auth" },
  });
  return emailListClient;
}

function ensureStyles() {
  if (document.getElementById("email-list-styles")) return;
  const style = document.createElement("style");
  style.id = "email-list-styles";
  style.textContent = `
    #modal-email-list .modal { width:min(760px, calc(100vw - 32px)); }
    .email-list-help { margin-bottom:10px; color:var(--slate-500,#64748b); font-size:12px; }
    .email-list-table-wrap { overflow:auto; border:1px solid var(--line,#dbe1eb); border-radius:7px; background:#fff; }
    .email-list-table { width:100%; border-collapse:collapse; table-layout:auto; user-select:text; }
    .email-list-table th, .email-list-table td { border:1px solid #9aa6b2; padding:7px 9px; text-align:left; white-space:nowrap; }
    .email-list-table th { background:#eef1f6; font-size:11px; font-weight:800; }
    .email-list-table td { font-size:13px; }
    .email-list-table .email-list-check { width:36px; min-width:36px; text-align:center; user-select:none; }
    .email-list-table .email-list-check input { width:15px; height:15px; }
    .email-list-table tr.is-unselected td:not(.email-list-check) { opacity:.45; }
    .email-list-status { min-height:18px; margin-right:auto; color:var(--slate-500,#64748b); font-size:12px; }
    .email-list-status.is-success { color:#15803d; font-weight:700; }
    .email-list-status.is-error { color:#b91c1c; font-weight:700; }
  `;
  document.head.appendChild(style);
}

function ensureModal() {
  let modal = document.getElementById("modal-email-list");
  if (modal) return modal;
  modal = document.createElement("div");
  modal.id = "modal-email-list";
  modal.className = "overlay hidden";
  modal.innerHTML = `
    <div class="modal modal-large">
      <div class="modal-header">
        <h3 id="email-list-title">Email List</h3>
        <button class="modal-close" id="email-list-close" type="button">&times;</button>
      </div>
      <div class="modal-body">
        <div class="email-list-help">All drivers are selected by default. Uncheck anyone you do not want. You can also drag across the table and use right-click → Copy.</div>
        <div id="email-list-body"></div>
      </div>
      <div class="modal-footer">
        <div class="email-list-status" id="email-list-status"></div>
        <button class="btn btn-ghost" id="email-list-close-btn" type="button">Close</button>
        <button class="btn" id="email-list-copy" type="button">Copy</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener("click", (event) => {
    if (event.target === modal) closeEmailList();
  });
  modal.querySelector("#email-list-close").addEventListener("click", closeEmailList);
  modal.querySelector("#email-list-close-btn").addEventListener("click", closeEmailList);
  modal.querySelector("#email-list-copy").addEventListener("click", copySelectedRows);
  modal.querySelector("#email-list-body").addEventListener("change", (event) => {
    const checkbox = event.target.closest("input[data-email-list-index]");
    if (!checkbox) return;
    const row = checkbox.closest("tr");
    if (row) row.classList.toggle("is-unselected", !checkbox.checked);
    updateSelectedCount();
  });
  return modal;
}

function installButton() {
  if (!isLoadBoardPage() || document.getElementById("btn-email-list")) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn btn-ghost";
  button.id = "btn-email-list";
  button.textContent = "Email List";
  button.title = "Email List";
  button.addEventListener("click", openEmailList);

  const infoButton = document.getElementById("btn-page-info");
  if (infoButton?.parentElement) infoButton.insertAdjacentElement("afterend", button);
  else document.querySelector(".toolbar-actions")?.prepend(button);
}

function displayedBoardRows() {
  const table = document.getElementById("mondelez-table") || document.getElementById("board-table");
  if (!table) return [];
  const records = [];
  table.querySelectorAll("tbody tr").forEach((tr) => {
    const driverInput = tr.querySelector('input[data-field="driverName"], input[data-mdz-field="driverName"]');
    if (driverInput) {
      const name = clean(driverInput.value);
      if (!name) return;
      const phone = clean(tr.querySelector(".col-cell .static-text")?.textContent);
      const shiftEl = tr.querySelector(".col-shiftStart input, .col-shiftStart .static-text");
      records.push({ name, phone, shiftStart: clean(shiftEl?.value ?? shiftEl?.textContent), collapsedMondelez: false });
      return;
    }

    if (currentFile() === "mondelez.html") {
      const pill = tr.querySelector("[data-open-mdz-load]");
      if (!pill) return;
      const text = clean(pill.textContent);
      const splitAt = text.indexOf(" — ");
      if (splitAt < 0) return;
      const aljex = clean(text.slice(0, splitAt)).replace(/^\(no Aljex#\)$/i, "");
      const name = clean(text.slice(splitAt + 3)).replace(/^no driver$/i, "");
      if (!name) return;
      records.push({ name, phone: "", shiftStart: "", collapsedMondelez: true, aljex });
    }
  });
  return records;
}

async function hydrateCollapsedMondelez(records) {
  const collapsed = records.filter((row) => row.collapsedMondelez);
  if (!collapsed.length) return records;
  const client = getEmailListClient();
  const date = document.getElementById("date-input")?.value;
  if (!client || !date) return records;

  let query = client
    .from("mondelez_loads")
    .select("aljex_number, driver_id, driver_name, start_time")
    .eq("shift_date", date)
    .eq("shift_complete", true);
  const activeTab = document.querySelector('[data-mdz-tab].is-active')?.dataset.mdzTab;
  if (activeTab && activeTab !== "combined") query = query.eq("location", activeTab);

  const { data, error } = await query;
  if (error) {
    console.error("Email List could not load completed Mondelez rows:", error);
    return records;
  }

  const saved = data || [];
  const driverIds = [...new Set(saved.map((row) => row.driver_id).filter((id) => id != null))];
  const phones = new Map();
  if (driverIds.length) {
    const { data: drivers, error: driverError } = await client.from("atlanta_drivers").select("id, phone").in("id", driverIds);
    if (!driverError) (drivers || []).forEach((driver) => phones.set(String(driver.id), clean(driver.phone)));
  }

  collapsed.forEach((record) => {
    const nameKey = record.name.toLowerCase();
    const aljexKey = record.aljex.replace(/\D/g, "");
    const matches = saved.filter((row) => {
      const sameName = clean(row.driver_name).toLowerCase() === nameKey;
      const savedAljex = clean(row.aljex_number).replace(/\D/g, "");
      return sameName && (!aljexKey || savedAljex === aljexKey);
    });
    if (matches.length !== 1) return;
    const match = matches[0];
    record.shiftStart = clean(match.start_time);
    record.phone = match.driver_id != null ? (phones.get(String(match.driver_id)) || "") : "";
  });
  return records;
}

function boardLabel() {
  return clean(document.getElementById("sheet-title")?.textContent).replace(/\s+Spreadsheet$/i, "") || "Load Board";
}

async function openEmailList() {
  const modal = ensureModal();
  ensureStyles();
  modal.classList.remove("hidden");
  document.getElementById("email-list-title").textContent = `Email List — ${boardLabel()}`;
  document.getElementById("email-list-status").textContent = "";
  document.getElementById("email-list-body").innerHTML = `<div class="subtext" style="padding:12px 0;">Building list…</div>`;

  currentRows = displayedBoardRows();
  if (currentFile() === "mondelez.html") currentRows = await hydrateCollapsedMondelez(currentRows);
  renderRows();
}

function closeEmailList() {
  document.getElementById("modal-email-list")?.classList.add("hidden");
}

function renderRows() {
  const body = document.getElementById("email-list-body");
  const copyButton = document.getElementById("email-list-copy");
  if (!body || !copyButton) return;
  if (!currentRows.length) {
    body.innerHTML = `<div class="subtext" style="padding:12px 0;">No drivers are listed on this board for the selected day.</div>`;
    copyButton.disabled = true;
    updateSelectedCount();
    return;
  }
  copyButton.disabled = false;
  body.innerHTML = `
    <div class="email-list-table-wrap">
      <table class="email-list-table" id="email-list-copy-table">
        <thead><tr><th class="email-list-check"></th><th>Driver Name</th><th>Phone Number</th><th>Shift Start</th></tr></thead>
        <tbody>${currentRows.map((row, index) => `
          <tr>
            <td class="email-list-check"><input type="checkbox" data-email-list-index="${index}" checked aria-label="Include ${esc(row.name)}"></td>
            <td>${esc(row.name)}</td>
            <td>${esc(row.phone)}</td>
            <td>${esc(row.shiftStart)}</td>
          </tr>`).join("")}</tbody>
      </table>
    </div>`;
  updateSelectedCount();
}

function selectedRows() {
  const checked = [...document.querySelectorAll('#email-list-body input[data-email-list-index]:checked')];
  return checked.map((input) => currentRows[Number(input.dataset.emailListIndex)]).filter(Boolean);
}

function updateSelectedCount() {
  const status = document.getElementById("email-list-status");
  if (!status) return;
  const count = selectedRows().length;
  status.className = "email-list-status";
  status.textContent = currentRows.length ? `${count} of ${currentRows.length} selected` : "";
}

function clipboardHtml(rows) {
  const cell = "border:1px solid #000;padding:5px 9px;text-align:left;white-space:nowrap;";
  const head = `${cell}font-weight:700;background:#eef1f6;`;
  return `<table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:12pt;">
    <thead><tr><th style="${head}">Driver Name</th><th style="${head}">Phone Number</th><th style="${head}">Shift Start</th></tr></thead>
    <tbody>${rows.map((row) => `<tr><td style="${cell}">${esc(row.name)}</td><td style="${cell}">${esc(row.phone)}</td><td style="${cell}">${esc(row.shiftStart)}</td></tr>`).join("")}</tbody>
  </table>`;
}

function clipboardText(rows) {
  return ["Driver Name\tPhone Number\tShift Start", ...rows.map((row) => `${row.name}\t${row.phone}\t${row.shiftStart}`)].join("\n");
}

function legacyRichCopy(html) {
  const holder = document.createElement("div");
  holder.contentEditable = "true";
  holder.style.position = "fixed";
  holder.style.left = "-10000px";
  holder.innerHTML = html;
  document.body.appendChild(holder);
  const selection = window.getSelection();
  const prior = [];
  if (selection) for (let i = 0; i < selection.rangeCount; i++) prior.push(selection.getRangeAt(i));
  const range = document.createRange();
  range.selectNodeContents(holder);
  selection?.removeAllRanges();
  selection?.addRange(range);
  const ok = document.execCommand("copy");
  selection?.removeAllRanges();
  prior.forEach((saved) => selection?.addRange(saved));
  holder.remove();
  return ok;
}

async function copySelectedRows() {
  const rows = selectedRows();
  const status = document.getElementById("email-list-status");
  if (!rows.length) {
    if (status) { status.className = "email-list-status is-error"; status.textContent = "Select at least one driver."; }
    return;
  }

  const html = clipboardHtml(rows);
  const text = clipboardText(rows);
  try {
    if (navigator.clipboard?.write && window.ClipboardItem) {
      await navigator.clipboard.write([new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([text], { type: "text/plain" }),
      })]);
    } else if (!legacyRichCopy(html)) {
      await navigator.clipboard.writeText(text);
    }
    if (status) { status.className = "email-list-status is-success"; status.textContent = `Copied ${rows.length} driver${rows.length === 1 ? "" : "s"}.`; }
  } catch (error) {
    console.error("Email List copy failed:", error);
    try {
      if (!legacyRichCopy(html)) throw error;
      if (status) { status.className = "email-list-status is-success"; status.textContent = `Copied ${rows.length} driver${rows.length === 1 ? "" : "s"}.`; }
    } catch {
      if (status) { status.className = "email-list-status is-error"; status.textContent = "Copy failed. Drag over the grid and use right-click → Copy instead."; }
    }
  }
}

function initEmailList() {
  if (!isLoadBoardPage()) return;
  ensureStyles();
  ensureModal();
  installButton();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initEmailList);
else initEmailList();
