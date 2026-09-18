import "./email-list.js";

/* Mobile-app paperwork integration for the existing Load Details modal.
   This module is loaded by alerts.js on the normal M-J Site pages.
   It intentionally leaves the legacy trip-sheet upload flow in loadboard.js
   alone. In addition to rendering durable M-J-App submissions in the
   "Trip Sheet Images" tab, it stays entirely out of the board's own cells.

   It used to draw a small paper icon beside every route-image dropzone. That
   icon was removed at the user's request, and removing it also ended a visible
   flicker: the icon was injected from a document-wide MutationObserver, so
   every board redraw destroyed it and re-created it ~120ms later, wrapping the
   dropzone in an extra flex container and changing the IMAGE column's width
   each time. Do not reintroduce a board-cell injector driven off that
   observer. */

const SUPABASE_URL = "https://ygsapysqzwrpcimgvaqx.supabase.co";
const SUPABASE_KEY = "sb_publishable_8b8bSIiYm5TzLTw0WG1pAw_5ZWW5ZPL";
const PAPERWORK_BUCKET = "paperwork-submissions";
const SIGNED_URL_SECONDS = 3600;

let client = null;
let lastOpenContext = null;
let renderTimer = null;
let renderGeneration = 0;
let pendingImagesOpenUntil = 0;

function getClient() {
  if (client) return client;
  if (!window.supabase) return null;
  client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: "dl-dispatch-auth" },
  });
  return client;
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function pageLocation() {
  const file = location.pathname.split("/").pop() || "index.html";
  if (file === "index.html" || file === "") return "atlanta";
  if (file === "dalaware.html") return "delaware";
  if (file === "buildingc.html") return "buildingc";
  return null;
}

function captureOpenContext(target) {
  const btn = target.closest && target.closest("[data-open-pro]");
  if (!btn) return;
  const row = btn.closest("tr");
  if (!row) return;
  const proInput = row.querySelector('input[data-field="proNumber"]');
  const driverInput = row.querySelector('input[data-field="driverName"]');
  const dateCell = row.querySelector(".col-shiftDate .static-text");
  const dateInput = document.getElementById("date-input");
  lastOpenContext = {
    pro: String(proInput?.value || "").trim(),
    driver: String(driverInput?.value || "").trim(),
    shiftDate: String(dateCell?.textContent || dateInput?.value || "").trim(),
    location: pageLocation(),
    capturedAt: Date.now(),
  };
}

document.addEventListener("click", (event) => captureOpenContext(event.target), true);

function normalizeNumber(value) {
  return String(value || "").replace(/\D/g, "");
}

async function resolveShiftId() {
  const ctx = lastOpenContext;
  if (!ctx || Date.now() - ctx.capturedAt > 15 * 60 * 1000) return { id: null, reason: "missing_context" };
  const c = getClient();
  if (!c || !ctx.location || !ctx.shiftDate) return { id: null, reason: "unsupported_page" };
  const pro = normalizeNumber(ctx.pro);
  if (!pro) return { id: null, reason: "missing_pro" };

  const { data, error } = await c
    .from("loads_shifts")
    .select("id, pro_number, aljex_load_number, shift_date, location, driver_name_text")
    .eq("location", ctx.location)
    .eq("shift_date", ctx.shiftDate)
    .or(`pro_number.eq.${pro},aljex_load_number.eq.${pro}`);
  if (error) throw error;

  let rows = data || [];
  if (rows.length > 1 && ctx.driver) {
    const needle = ctx.driver.trim().toLowerCase();
    const byDriver = rows.filter((row) => String(row.driver_name_text || "").trim().toLowerCase() === needle);
    if (byDriver.length === 1) rows = byDriver;
  }
  if (rows.length !== 1) return { id: null, reason: rows.length ? "ambiguous" : "not_found" };
  return { id: rows[0].id, reason: null };
}

async function loadMobilePaperwork(shiftId) {
  const c = getClient();
  if (!c) return [];
  const { data: submissions, error: subError } = await c
    .from("paperwork_submissions")
    .select("id, pro_number, submitted_at, status")
    .eq("matched_shift_id", shiftId)
    .is("deleted_at", null)
    .order("submitted_at", { ascending: true });
  if (subError) throw subError;
  if (!submissions?.length) return [];

  const ids = submissions.map((row) => row.id);
  const { data: images, error: imageError } = await c
    .from("paperwork_images")
    .select("id, submission_id, storage_path, original_file_name, note, sort_order")
    .in("submission_id", ids)
    .order("sort_order", { ascending: true });
  if (imageError) throw imageError;

  const imageRows = images || [];
  const paths = imageRows.map((image) => image.storage_path);
  let signed = [];
  if (paths.length) {
    const result = await c.storage.from(PAPERWORK_BUCKET).createSignedUrls(paths, SIGNED_URL_SECONDS);
    if (result.error) throw result.error;
    signed = result.data || [];
  }

  const imagesBySubmission = new Map();
  imageRows.forEach((image, index) => {
    const list = imagesBySubmission.get(image.submission_id) || [];
    list.push({ ...image, signedUrl: signed[index]?.signedUrl || null });
    imagesBySubmission.set(image.submission_id, list);
  });
  return submissions.map((submission) => ({
    ...submission,
    images: imagesBySubmission.get(submission.id) || [],
  }));
}

function submissionHtml(submission) {
  const when = submission.submitted_at ? new Date(submission.submitted_at).toLocaleString() : "Unknown time";
  const images = submission.images.length
    ? submission.images.map((image) => image.signedUrl ? `
        <a href="${esc(image.signedUrl)}" target="_blank" rel="noopener" class="mjapp-paperwork-image-link" title="Open full size">
          <img src="${esc(image.signedUrl)}" alt="${esc(image.original_file_name || "Mobile paperwork")}">
        </a>` : "").join("")
    : `<div class="subtext">No image files on this submission.</div>`;
  return `
    <div class="mjapp-paperwork-submission">
      <div class="mjapp-paperwork-meta">
        <strong>Received ${esc(when)}</strong>
        <span>Entered Pro # ${esc(submission.pro_number || "—")}</span>
      </div>
      <div class="mjapp-paperwork-images">${images}</div>
    </div>`;
}

function ensureStyles() {
  if (document.getElementById("mjapp-paperwork-style")) return;
  const style = document.createElement("style");
  style.id = "mjapp-paperwork-style";
  style.textContent = `
    .mjapp-paperwork-section { margin-top:18px; padding-top:14px; border-top:1px solid var(--line,#dbe1eb); }
    .mjapp-paperwork-section h4 { margin:0 0 4px; font-size:14px; }
    .mjapp-paperwork-submission { margin-top:10px; padding:10px; border:1px solid var(--line,#dbe1eb); border-radius:8px; background:#f8fafc; }
    .mjapp-paperwork-meta { display:flex; gap:8px 14px; flex-wrap:wrap; align-items:center; margin-bottom:8px; font-size:12px; color:#475569; }
    .mjapp-paperwork-meta strong { color:#172542; }
    .mjapp-paperwork-images { display:flex; gap:8px; flex-wrap:wrap; }
    .mjapp-paperwork-image-link { display:block; border:1px solid var(--line,#dbe1eb); border-radius:7px; overflow:hidden; background:#fff; }
    .mjapp-paperwork-image-link img { display:block; width:150px; height:150px; object-fit:cover; }

    /* Sticky columns sit above horizontally scrolling cells. Their previous
       rgba status fills let text underneath show through. These are the same
       visual tints composited onto white, but fully opaque. */
    table.board tbody tr:nth-child(even) td.pin { background:#fbfcfe; }
    table.board tbody tr.is-row-pinned td.pin { background:#faeec9; }
    table.board tbody tr.is-row-selected td.pin { background:#d4e4fd; }
    table.board tbody tr.is-being-edited td.pin { background:#cbdafa; }
    table.board tbody tr:hover td.pin { background:#eaf1ff; }
    tr.is-new td.pin { background-color:#f1d3d1 !important; }
    td.pin-pro.shift-complete-tint { background:#d7f5e2 !important; }
    table.board tbody tr:hover td.pin-pro.shift-complete-tint { background:#c1efd2 !important; }
    td.pin-pro.pro-fully-documented { background:#b4d6c1 !important; }
    table.board tbody tr:hover td.pin-pro.pro-fully-documented { background:#9dcaae !important; }
  `;
  document.head.appendChild(style);
}

async function renderIntoImagesTab() {
  const body = document.getElementById("ld-tab-content");
  const modal = document.getElementById("modal-load-details");
  if (!body || !modal || modal.classList.contains("hidden")) return;
  if (!document.getElementById("ld-file-input")) return;
  if (document.getElementById("mjapp-paperwork-section")) return;

  ensureStyles();
  const generation = ++renderGeneration;
  const section = document.createElement("section");
  section.id = "mjapp-paperwork-section";
  section.className = "mjapp-paperwork-section";
  section.innerHTML = `<h4>Mobile App Paperwork</h4><div class="subtext">Checking for app submissions attached to this load…</div>`;
  body.appendChild(section);

  try {
    const resolved = await resolveShiftId();
    if (generation !== renderGeneration || !document.getElementById("mjapp-paperwork-section")) return;
    if (!resolved.id) {
      section.innerHTML = resolved.reason === "ambiguous"
        ? `<h4>Mobile App Paperwork</h4><div class="subtext">This Pro/date resolves to more than one load, so the site will not guess. Use the Paperwork Inbox to view or reattach the submission.</div>`
        : `<h4>Mobile App Paperwork</h4><div class="subtext">No mobile-app paperwork is attached to this load.</div>`;
      return;
    }
    const submissions = await loadMobilePaperwork(resolved.id);
    if (generation !== renderGeneration || !document.getElementById("mjapp-paperwork-section")) return;
    section.innerHTML = submissions.length
      ? `<h4>Mobile App Paperwork</h4><div class="subtext">Original app uploads are stored separately from the legacy trip-sheet bucket so archive cleanup cannot delete them.</div>${submissions.map(submissionHtml).join("")}`
      : `<h4>Mobile App Paperwork</h4><div class="subtext">No mobile-app paperwork is attached to this load.</div>`;
  } catch (error) {
    console.error("Mobile paperwork integration failed:", error);
    if (generation !== renderGeneration || !document.getElementById("mjapp-paperwork-section")) return;
    section.innerHTML = `<h4>Mobile App Paperwork</h4><div class="subtext">Could not load mobile paperwork right now.</div>`;
  }
}

function openPendingImagesTab() {
  if (!pendingImagesOpenUntil) return;
  if (Date.now() > pendingImagesOpenUntil) {
    pendingImagesOpenUntil = 0;
    return;
  }
  const modal = document.getElementById("modal-load-details");
  if (!modal || modal.classList.contains("hidden")) return;
  const imagesTab = document.querySelector('#ld-tabs .ld-tab[data-tab="images"]');
  if (!imagesTab) return;
  pendingImagesOpenUntil = 0;
  if (!imagesTab.classList.contains("is-active")) imagesTab.click();
}

function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => {
    openPendingImagesTab();
    renderIntoImagesTab();
  }, 40);
}

// Everything left in this module renders inside the Load Details modal, so
// watch the modal, not the whole document. The document-wide version re-ran on
// every board redraw and every class toggle anywhere on the page, which on a
// busy board is many times a second for no benefit.
const observer = new MutationObserver(scheduleRender);

function observeLoadDetails() {
  const modal = document.getElementById("modal-load-details");
  observer.observe(modal || document.documentElement, {
    childList: true, subtree: true, attributes: true, attributeFilter: ["class"],
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    ensureStyles();
    observeLoadDetails();
    scheduleRender();
  }, { once: true });
} else {
  ensureStyles();
  observeLoadDetails();
  scheduleRender();
}
