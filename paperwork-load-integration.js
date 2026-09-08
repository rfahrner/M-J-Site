/* Mobile-app paperwork integration for the existing Load Details modal.
   This module is loaded by alerts.js on the normal M-J Site pages.
   It intentionally does not modify loadboard.js or the existing trip-sheet
   upload flow. It only adds durable M-J-App submissions to the existing
   "Trip Sheet Images" view when the current load can be resolved exactly. */

const SUPABASE_URL = "https://ygsapysqzwrpcimgvaqx.supabase.co";
const SUPABASE_KEY = "sb_publishable_8b8bSIiYm5TzLTw0WG1pAw_5ZWW5ZPL";
const PAPERWORK_BUCKET = "paperwork-submissions";
const SIGNED_URL_SECONDS = 3600;

let client = null;
let lastOpenContext = null;
let renderTimer = null;
let renderGeneration = 0;

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
    .select("id, sender_phone, pro_number, submitted_at, status, note")
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

function phoneLabel(value) {
  const digits = normalizeNumber(value).replace(/^1(?=\d{10}$)/, "");
  if (digits.length !== 10) return value || "unknown number";
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
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
        <span>Sent from ${esc(phoneLabel(submission.sender_phone))}</span>
        <span>Entered Pro # ${esc(submission.pro_number || "—")}</span>
      </div>
      <div class="mjapp-paperwork-images">${images}</div>
      ${submission.note ? `<div class="calc-note" style="margin-top:7px;">Sender note: ${esc(submission.note)}</div>` : ""}
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
  `;
  document.head.appendChild(style);
}

async function renderIntoImagesTab() {
  const body = document.getElementById("ld-tab-content");
  const modal = document.getElementById("modal-load-details");
  if (!body || !modal || modal.classList.contains("hidden")) return;
  if (!document.getElementById("ld-file-input")) return; // Trip Sheet Images tab is not active.
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

function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => renderIntoImagesTab(), 40);
}

const observer = new MutationObserver(scheduleRender);
observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
document.addEventListener("DOMContentLoaded", scheduleRender);
