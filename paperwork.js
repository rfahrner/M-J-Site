const SUPABASE_URL = "https://ygsapysqzwrpcimgvaqx.supabase.co";
const SUPABASE_KEY = "sb_publishable_8b8bSIiYm5TzLTw0WG1pAw_5ZWW5ZPL";
const PAPERWORK_BUCKET = "paperwork-submissions";
const INTERNAL_ROLES = new Set(["dispatcher", "accounting", "admin", "it"]);
const SIGNED_URL_SECONDS = 3600;

const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: "dl-dispatch-auth" },
});

const byId = (id) => document.getElementById(id);
const esc = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");

let currentSession = null;
let currentRole = null;
let submissions = [];
let imagesBySubmission = new Map();
let selectedSubmissionId = null;
let reattachSubmissionId = null;

function setStatus(message = "", isError = false) {
  const el = byId("pw-status");
  el.textContent = message;
  el.classList.toggle("error", !!isError);
}

function setReattachStatus(message = "", isError = false) {
  const el = byId("pw-reattach-status");
  el.textContent = message;
  el.classList.toggle("error", !!isError);
}

function formatReceived(value) {
  if (!value) return "—";
  const date = new Date(value);
  return new Intl.DateTimeFormat("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit",
  }).format(date);
}

function statusMarkup(row) {
  if (row.status === "attached") return '<span class="status-badge status-attached">Attached</span>';
  if (row.status === "archived_match") return '<span class="status-badge status-archived">Archived match</span>';
  return '<span class="status-badge status-review">Needs review</span>';
}

function attachmentLabel(row) {
  if (!row.matched_source_id) return "—";
  const load = row.matched_load_number || row.matched_source_id;
  const archived = row.matched_is_archived ? " (archived)" : "";
  return `${load}${archived}`;
}

function renderNav() {
  const tabs = byId("tabs");
  const items = [
    ["index.html", "Atlanta"],
    ["dalaware.html", "Delaware"],
    ["buildingc.html", "Building C"],
    ["houston.html", "Houston"],
    ["mondelez.html", "Mondelez"],
  ];
  if (["accounting", "admin", "it"].includes(currentRole)) items.push(["accounting.html", "Accounting"]);
  items.push(["paperwork.html", "Paperwork"], ["driverlist.html", "Driver List"]);
  tabs.innerHTML = items.map(([href, label]) =>
    `<a class="tab-btn ${href === "paperwork.html" ? "active" : ""}" href="${href}">${esc(label)}</a>`
  ).join("");
}

async function ensureInternalAuth() {
  const { data, error } = await client.auth.getSession();
  if (error || !data?.session) {
    window.location.replace("login.html");
    return false;
  }
  currentSession = data.session;

  const { data: roleRow, error: roleError } = await client
    .from("user_roles")
    .select("role")
    .eq("user_id", currentSession.user.id)
    .maybeSingle();

  if (roleError || !roleRow || !INTERNAL_ROLES.has(roleRow.role)) {
    window.location.replace("index.html");
    return false;
  }
  currentRole = roleRow.role;
  renderNav();
  return true;
}

function chunks(array, size = 150) {
  const out = [];
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
  return out;
}

async function loadImagesForSubmissions(ids) {
  imagesBySubmission = new Map();
  for (const idChunk of chunks(ids)) {
    const { data, error } = await client
      .from("paperwork_images")
      .select("*")
      .in("submission_id", idChunk)
      .order("sort_order", { ascending: true });
    if (error) throw error;
    for (const image of data || []) {
      const list = imagesBySubmission.get(image.submission_id) || [];
      list.push(image);
      imagesBySubmission.set(image.submission_id, list);
    }
  }
}

async function loadSubmissions() {
  setStatus("Loading paperwork…");
  const refresh = byId("pw-refresh");
  refresh.disabled = true;
  try {
    const { data, error } = await client
      .from("paperwork_submissions")
      .select("*")
      .is("deleted_at", null)
      .order("submitted_at", { ascending: false })
      .limit(500);
    if (error) throw error;
    submissions = data || [];
    await loadImagesForSubmissions(submissions.map((row) => row.id));
    renderTable();
    setStatus(`Showing ${submissions.length.toLocaleString()} active submission${submissions.length === 1 ? "" : "s"}.`);
  } catch (error) {
    console.error("Could not load paperwork:", error);
    setStatus(`Couldn't load paperwork (${error.message || error}).`, true);
  } finally {
    refresh.disabled = false;
  }
}

function filteredRows() {
  const status = byId("pw-status-filter").value;
  const query = byId("pw-search").value.trim().toLowerCase();
  return submissions.filter((row) => {
    if (status !== "active" && row.status !== status) return false;
    if (!query) return true;
    return String(row.pro_number || "").toLowerCase().includes(query)
      || String(row.matched_load_number || "").toLowerCase().includes(query);
  });
}

function renderSummary() {
  const counts = {
    total: submissions.length,
    review: submissions.filter((x) => x.status === "needs_review").length,
    attached: submissions.filter((x) => x.status === "attached").length,
    archived: submissions.filter((x) => x.status === "archived_match").length,
  };
  byId("pw-summary").innerHTML = [
    `${counts.total} active`,
    `${counts.review} need review`,
    `${counts.attached} attached`,
    `${counts.archived} archived matches`,
  ].map((text) => `<span class="paperwork-pill">${esc(text)}</span>`).join("");
}

function renderTable() {
  renderSummary();
  const rows = filteredRows();
  const body = byId("pw-body");
  byId("pw-empty").classList.toggle("hidden", rows.length > 0);
  body.innerHTML = rows.map((row) => {
    const count = (imagesBySubmission.get(row.id) || []).length;
    const rowClass = row.status === "needs_review" ? "needs-review" : row.status === "archived_match" ? "archived-match" : "";
    return `<tr class="${rowClass}">
      <td>${esc(formatReceived(row.submitted_at))}</td>
      <td><strong>${esc(row.pro_number)}</strong></td>
      <td>${count}</td>
      <td>${statusMarkup(row)}</td>
      <td>${esc(attachmentLabel(row))}</td>
      <td>
        <div class="paperwork-actions">
          <button class="btn btn-ghost" type="button" data-view="${row.id}">View</button>
          <button class="btn btn-ghost" type="button" data-reattach="${row.id}">Reattach</button>
          <button class="btn btn-ghost btn-danger-lite" type="button" data-delete="${row.id}">Delete</button>
        </div>
      </td>
    </tr>`;
  }).join("");
}

function metaCard(key, value) {
  return `<div class="pw-meta"><div class="k">${esc(key)}</div><div class="v">${esc(value)}</div></div>`;
}

async function signedImages(images) {
  if (!images.length) return [];
  const paths = images.map((image) => image.storage_path);
  const { data, error } = await client.storage.from(PAPERWORK_BUCKET).createSignedUrls(paths, SIGNED_URL_SECONDS);
  if (error) throw error;
  return images.map((image, index) => ({ ...image, signedUrl: data?.[index]?.signedUrl || null }));
}

async function loadNotes(submissionId) {
  const { data, error } = await client
    .from("paperwork_notes")
    .select("*")
    .eq("submission_id", submissionId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data || [];
}

function renderNotes(notes) {
  byId("pw-note-list").innerHTML = notes.length
    ? notes.map((note) => `<div class="pw-note-item">
        <div>${esc(note.note_text)}</div>
        <div class="meta">${esc(formatReceived(note.created_at))}</div>
      </div>`).join("")
    : '<div class="subtext">No office notes yet.</div>';
}

async function openView(submissionId) {
  const row = submissions.find((item) => item.id === submissionId);
  if (!row) return;
  selectedSubmissionId = submissionId;
  byId("pw-view-backdrop").classList.remove("hidden");
  byId("pw-view-title").textContent = `Paperwork — Pro ${row.pro_number}`;
  byId("pw-view-subtitle").textContent = `Received ${formatReceived(row.submitted_at)}`;
  byId("pw-meta-grid").innerHTML = [
    metaCard("Entered Pro #", row.pro_number),
    metaCard("Status", row.status.replaceAll("_", " ")),
    metaCard("Attached To", attachmentLabel(row)),
  ].join("");
  byId("pw-images").innerHTML = '<div class="subtext">Loading images…</div>';
  byId("pw-note-list").innerHTML = '<div class="subtext">Loading notes…</div>';
  byId("pw-new-note").value = "";

  try {
    const [images, notes] = await Promise.all([
      signedImages(imagesBySubmission.get(submissionId) || []),
      loadNotes(submissionId),
    ]);
    byId("pw-images").innerHTML = images.length ? images.map((image, index) => `<div class="pw-image-card">
      ${image.signedUrl
        ? `<img src="${esc(image.signedUrl)}" alt="Trip sheet ${index + 1}" data-lightbox="${esc(image.signedUrl)}">`
        : '<div class="paperwork-empty">Image unavailable</div>'}
      <div class="pw-image-name" title="${esc(image.original_file_name)}">${esc(image.original_file_name)}</div>
      <textarea class="pw-image-note" maxlength="1000" data-image-note="${image.id}" placeholder="Image note…">${esc(image.note || "")}</textarea>
      <button class="btn btn-ghost" type="button" style="margin-top:6px;" data-save-image-note="${image.id}">Save Image Note</button>
    </div>`).join("") : '<div class="subtext">No images on this submission.</div>';
    renderNotes(notes);
  } catch (error) {
    console.error("Could not load submission details:", error);
    byId("pw-images").innerHTML = `<div class="paperwork-status error">Couldn't load submission details (${esc(error.message || error)}).</div>`;
  }
}

async function addOfficeNote() {
  if (!selectedSubmissionId || !currentSession) return;
  const textarea = byId("pw-new-note");
  const text = textarea.value.trim();
  if (!text) return;
  const button = byId("pw-add-note");
  button.disabled = true;
  try {
    const { error } = await client.from("paperwork_notes").insert({
      submission_id: selectedSubmissionId,
      note_text: text,
      created_by: currentSession.user.id,
    });
    if (error) throw error;
    const { error: eventError } = await client.from("paperwork_submission_events").insert({
      submission_id: selectedSubmissionId,
      event_type: "note_added",
      event_note: "Office note added",
      created_by: currentSession.user.id,
    });
    if (eventError) console.warn("Could not write note audit event:", eventError);
    textarea.value = "";
    renderNotes(await loadNotes(selectedSubmissionId));
  } catch (error) {
    alert(`Couldn't add note: ${error.message || error}`);
  } finally {
    button.disabled = false;
  }
}

async function saveImageNote(imageId) {
  const textarea = document.querySelector(`[data-image-note="${CSS.escape(imageId)}"]`);
  if (!textarea) return;
  const { error } = await client
    .from("paperwork_images")
    .update({ note: textarea.value.trim() || null })
    .eq("id", imageId);
  if (error) throw error;

  const images = imagesBySubmission.get(selectedSubmissionId) || [];
  const image = images.find((item) => item.id === imageId);
  if (image) image.note = textarea.value.trim() || null;

  if (currentSession && selectedSubmissionId) {
    const { error: eventError } = await client.from("paperwork_submission_events").insert({
      submission_id: selectedSubmissionId,
      event_type: "note_added",
      event_note: `Image note updated for ${image?.original_file_name || imageId}`,
      created_by: currentSession.user.id,
    });
    if (eventError) console.warn("Could not write image-note audit event:", eventError);
  }
}

function openReattach(submissionId) {
  const row = submissions.find((item) => item.id === submissionId);
  if (!row) return;
  reattachSubmissionId = submissionId;
  byId("pw-reattach-backdrop").classList.remove("hidden");
  byId("pw-reattach-pro").value = row.matched_load_number || row.pro_number || "";
  byId("pw-candidates").innerHTML = "";
  setReattachStatus("");
  setTimeout(() => byId("pw-reattach-pro").focus(), 0);
}

async function findLoadCandidates() {
  const input = byId("pw-reattach-pro");
  const pro = input.value.replace(/\D/g, "");
  input.value = pro;
  if (!pro) {
    setReattachStatus("Enter a Pro / Aljex number.", true);
    return;
  }
  const button = byId("pw-find-loads");
  button.disabled = true;
  byId("pw-candidates").innerHTML = "";
  setReattachStatus("Searching…");
  try {
    const [directResult, factsResult] = await Promise.all([
      client.from("loads_shifts")
        .select("id,shift_date,location,pro_number,aljex_load_number")
        .or(`pro_number.eq.${pro},aljex_load_number.eq.${pro}`)
        .limit(50),
      client.from("analytics_load_facts_all")
        .select("source_table,original_id,load_number,shift_date,location,is_archived")
        .eq("load_number", pro)
        .limit(50),
    ]);
    if (directResult.error) throw directResult.error;
    if (factsResult.error) throw factsResult.error;

    const map = new Map();
    for (const row of directResult.data || []) {
      map.set(`loads_shifts:${row.id}`, {
        sourceTable: "loads_shifts", sourceId: row.id,
        loadNumber: row.aljex_load_number || row.pro_number || pro,
        shiftDate: row.shift_date, location: row.location, isArchived: false,
      });
    }
    for (const row of factsResult.data || []) {
      const key = `${row.source_table}:${row.original_id}`;
      const existing = map.get(key);
      if (!existing || row.is_archived) {
        map.set(key, {
          sourceTable: row.source_table, sourceId: row.original_id,
          loadNumber: row.load_number || pro, shiftDate: row.shift_date,
          location: row.location, isArchived: !!row.is_archived,
        });
      }
    }
    const candidates = [...map.values()].sort((a, b) => String(b.shiftDate || "").localeCompare(String(a.shiftDate || "")));
    if (!candidates.length) {
      setReattachStatus(`No load found for ${pro}.`, true);
      return;
    }
    setReattachStatus(candidates.length === 1 ? "1 load found." : `${candidates.length} loads found — choose the exact one.`);
    byId("pw-candidates").innerHTML = candidates.map((row) => `<button type="button" class="candidate"
      data-candidate-source="${esc(row.sourceTable)}" data-candidate-id="${esc(row.sourceId)}">
      <strong>Pro ${esc(row.loadNumber)}${row.isArchived ? " — Archived" : ""}</strong>
      <span class="sub">${esc(row.shiftDate || "Date unknown")} · ${esc(row.location || "Location unknown")} · ${esc(row.sourceTable)}</span>
    </button>`).join("");
  } catch (error) {
    console.error("Load lookup failed:", error);
    setReattachStatus(`Couldn't search loads (${error.message || error}).`, true);
  } finally {
    button.disabled = false;
  }
}

async function assignCandidate(sourceTable, sourceId) {
  if (!reattachSubmissionId) return;
  setReattachStatus("Attaching…");
  byId("pw-candidates").querySelectorAll("button").forEach((button) => { button.disabled = true; });
  try {
    const { error } = await client.rpc("assign_paperwork_submission", {
      p_submission_id: reattachSubmissionId,
      p_source_table: sourceTable,
      p_source_id: Number(sourceId),
    });
    if (error) throw error;
    closeModal("pw-reattach-backdrop");
    await loadSubmissions();
    if (selectedSubmissionId === reattachSubmissionId) await openView(reattachSubmissionId);
  } catch (error) {
    console.error("Reattach failed:", error);
    setReattachStatus(`Couldn't attach paperwork (${error.message || error}).`, true);
    byId("pw-candidates").querySelectorAll("button").forEach((button) => { button.disabled = false; });
  }
}

async function softDelete(submissionId) {
  const row = submissions.find((item) => item.id === submissionId);
  if (!row) return;
  if (!confirm(`Remove the paperwork for Pro ${row.pro_number} from the inbox?\n\nThe original images will be retained.`)) return;
  try {
    const { error } = await client.rpc("soft_delete_paperwork_submission", {
      p_submission_id: submissionId,
    });
    if (error) throw error;
    submissions = submissions.filter((item) => item.id !== submissionId);
    imagesBySubmission.delete(submissionId);
    renderTable();
    setStatus("Paperwork removed from the inbox. Original images were retained.");
  } catch (error) {
    alert(`Couldn't delete paperwork: ${error.message || error}`);
  }
}

function closeModal(id) {
  byId(id)?.classList.add("hidden");
  if (id === "pw-view-backdrop") selectedSubmissionId = null;
  if (id === "pw-reattach-backdrop") reattachSubmissionId = null;
}

function openLightbox(url) {
  byId("pw-lightbox-image").src = url;
  byId("pw-lightbox").classList.remove("hidden");
}

function closeLightbox() {
  byId("pw-lightbox").classList.add("hidden");
  byId("pw-lightbox-image").removeAttribute("src");
}

function installEvents() {
  byId("pw-refresh").addEventListener("click", loadSubmissions);
  byId("pw-status-filter").addEventListener("change", renderTable);
  byId("pw-search").addEventListener("input", renderTable);
  byId("pw-add-note").addEventListener("click", addOfficeNote);
  byId("pw-find-loads").addEventListener("click", findLoadCandidates);
  byId("pw-reattach-pro").addEventListener("keydown", (event) => {
    if (event.key === "Enter") findLoadCandidates();
  });

  document.addEventListener("click", async (event) => {
    const target = event.target.closest("button, img");
    if (!target) return;
    if (target.dataset.view) return openView(target.dataset.view);
    if (target.dataset.reattach) return openReattach(target.dataset.reattach);
    if (target.dataset.delete) return softDelete(target.dataset.delete);
    if (target.dataset.close) return closeModal(target.dataset.close);
    if (target.dataset.lightbox) return openLightbox(target.dataset.lightbox);
    if (target.dataset.saveImageNote) {
      target.disabled = true;
      try {
        await saveImageNote(target.dataset.saveImageNote);
        const original = target.textContent;
        target.textContent = "Saved";
        setTimeout(() => { target.textContent = original; }, 900);
      } catch (error) {
        alert(`Couldn't save image note: ${error.message || error}`);
      } finally {
        target.disabled = false;
      }
      return;
    }
    if (target.dataset.candidateSource && target.dataset.candidateId) {
      return assignCandidate(target.dataset.candidateSource, target.dataset.candidateId);
    }
  });

  document.querySelectorAll(".pw-modal-backdrop").forEach((backdrop) => {
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) closeModal(backdrop.id);
    });
  });
  byId("pw-lightbox-close").addEventListener("click", closeLightbox);
  byId("pw-lightbox").addEventListener("click", (event) => {
    if (event.target === byId("pw-lightbox")) closeLightbox();
  });
}

async function init() {
  if (!(await ensureInternalAuth())) return;
  installEvents();
  await loadSubmissions();
}

init().catch((error) => {
  console.error("Paperwork page failed to initialize:", error);
  setStatus(`Paperwork page could not start (${error.message || error}).`, true);
});
