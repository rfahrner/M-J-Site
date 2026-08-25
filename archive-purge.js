const PURGE_SUPABASE_URL = "https://ygsapysqzwrpcimgvaqx.supabase.co";
const PURGE_SUPABASE_KEY = "sb_publishable_8b8bSIiYm5TzLTw0WG1pAw_5ZWW5ZPL";
const PAGE_SIZE = 1000;
const PURGE_CHUNK_SIZE = 2000;
const STORAGE_REMOVE_CHUNK_SIZE = 100;

const purgeClient = window.supabase.createClient(PURGE_SUPABASE_URL, PURGE_SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: "dl-dispatch-auth" },
});

let exportSnapshot = null;
let selectedRootHandle = null;
let purgeInProgress = false;

function byId(id) { return document.getElementById(id); }

function chunk(rows, size) {
  const out = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

async function fetchAllIds(table, cutoff) {
  const out = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await purgeClient
      .from(table)
      .select("id,shift_date")
      .lt("shift_date", cutoff)
      .order("shift_date", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data || []).map((row) => ({ source_table: table, id: row.id, shift_date: row.shift_date })));
    if (!data || data.length < PAGE_SIZE) break;
  }
  return out;
}

async function captureExportSnapshot() {
  const cutoff = byId("archive-cutoff")?.value;
  if (!cutoff) throw new Error("Archive cutoff is missing.");

  const [shifts, houston, mondelez] = await Promise.all([
    fetchAllIds("loads_shifts", cutoff),
    fetchAllIds("loads_houston", cutoff),
    fetchAllIds("mondelez_loads", cutoff),
  ]);

  // The main exporter only includes these three Kroger locations from loads_shifts.
  const allowedShiftIds = new Set();
  const filteredShifts = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await purgeClient
      .from("loads_shifts")
      .select("id")
      .in("location", ["atlanta", "buildingc", "delaware"])
      .lt("shift_date", cutoff)
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`loads_shifts locations: ${error.message}`);
    for (const row of data || []) allowedShiftIds.add(row.id);
    if (!data || data.length < PAGE_SIZE) break;
  }
  for (const row of shifts) if (allowedShiftIds.has(row.id)) filteredShifts.push(row);

  const records = [...filteredShifts, ...houston, ...mondelez].sort((a, b) =>
    a.shift_date.localeCompare(b.shift_date) ||
    a.source_table.localeCompare(b.source_table) ||
    Number(a.id) - Number(b.id));

  exportSnapshot = {
    cutoff,
    records,
    captured_at: new Date().toISOString(),
  };
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function ensureModal() {
  if (byId("archive-purge-modal")) return;

  const style = document.createElement("style");
  style.textContent = `
    .archive-purge-backdrop{position:fixed;inset:0;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;z-index:10000;padding:18px}
    .archive-purge-backdrop.hidden{display:none}
    .archive-purge-card{width:min(620px,100%);background:#fff;border-radius:12px;box-shadow:0 24px 60px rgba(0,0,0,.28);padding:22px}
    .archive-purge-card h2{margin:0 0 8px;font-size:22px}
    .archive-purge-card p{margin:8px 0;color:#475569;line-height:1.45}
    .archive-purge-danger{background:#fff1f2;border:1px solid #fecdd3;border-radius:8px;padding:11px 12px;color:#881337;margin:14px 0}
    .archive-purge-check{display:flex;gap:9px;align-items:flex-start;margin:14px 0;font-size:13px}
    .archive-purge-confirm{width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid #cbd5e1;border-radius:6px}
    .archive-purge-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:16px}
    .archive-purge-btn-danger{background:#b91c1c!important;border-color:#b91c1c!important;color:#fff!important}
    .archive-purge-meta{font-size:12px;color:#64748b;margin-top:8px}
    .archive-purge-progress{width:100%;margin-top:12px}
  `;
  document.head.appendChild(style);

  const modal = document.createElement("div");
  modal.id = "archive-purge-modal";
  modal.className = "archive-purge-backdrop hidden";
  modal.innerHTML = `
    <div class="archive-purge-card" role="dialog" aria-modal="true" aria-labelledby="archive-purge-title">
      <h2 id="archive-purge-title">Archive export complete</h2>
      <p id="archive-purge-message"></p>
      <div class="archive-purge-danger"><strong>This permanently removes the exported operational records from Supabase.</strong> Lightweight analytics history is preserved first. The local/OneDrive archive remains the full historical record.</div>
      <label class="archive-purge-check">
        <input type="checkbox" id="archive-purge-verified">
        <span>I uploaded this archive to OneDrive and verified that the archive opens and contains the expected records.</span>
      </label>
      <label for="archive-purge-confirm"><strong>Type PURGE to confirm</strong></label>
      <input id="archive-purge-confirm" class="archive-purge-confirm" autocomplete="off" placeholder="PURGE">
      <div id="archive-purge-meta" class="archive-purge-meta"></div>
      <progress id="archive-purge-progress" class="archive-purge-progress hidden" value="0" max="100"></progress>
      <div class="archive-purge-actions">
        <button type="button" class="btn btn-ghost" id="archive-purge-later">Keep records for now</button>
        <button type="button" class="btn archive-purge-btn-danger" id="archive-purge-now" disabled>Verify &amp; Purge</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  const verified = byId("archive-purge-verified");
  const confirm = byId("archive-purge-confirm");
  const now = byId("archive-purge-now");
  const updateEnabled = () => { now.disabled = purgeInProgress || !verified.checked || confirm.value.trim() !== "PURGE"; };
  verified.addEventListener("change", updateEnabled);
  confirm.addEventListener("input", updateEnabled);
  byId("archive-purge-later").addEventListener("click", closeModal);
  now.addEventListener("click", () => runVerifiedPurge().catch(showPurgeError));
}

function closeModal() {
  if (purgeInProgress) return;
  byId("archive-purge-modal")?.classList.add("hidden");
}

function showPurgeError(error) {
  console.error("Archive purge failed:", error);
  purgeInProgress = false;
  const meta = byId("archive-purge-meta");
  if (meta) meta.textContent = `Purge stopped: ${error.message || error}. Records already confirmed by completed chunks remain archived; unprocessed chunks remain in Supabase.`;
  const now = byId("archive-purge-now");
  if (now) now.disabled = false;
  const later = byId("archive-purge-later");
  if (later) later.disabled = false;
}

function showPurgeModal() {
  ensureModal();
  if (!exportSnapshot?.records?.length) return;
  byId("archive-purge-verified").checked = false;
  byId("archive-purge-confirm").value = "";
  byId("archive-purge-now").disabled = true;
  byId("archive-purge-later").disabled = false;
  byId("archive-purge-progress").classList.add("hidden");
  byId("archive-purge-message").textContent = `${exportSnapshot.records.length.toLocaleString()} exact records were included in the completed export. Would you like to purge those exported records from the live site after verifying the OneDrive copy?`;
  byId("archive-purge-meta").textContent = `Cutoff: ${exportSnapshot.cutoff}. Nothing will be removed unless you confirm below.`;
  byId("archive-purge-modal").classList.remove("hidden");
}

async function removeStorageItems(items) {
  const grouped = new Map();
  for (const item of items || []) {
    if (!item?.bucket || !item?.path) continue;
    if (!grouped.has(item.bucket)) grouped.set(item.bucket, []);
    grouped.get(item.bucket).push(item.path);
  }

  let removed = 0;
  const failed = [];
  for (const [bucket, paths] of grouped) {
    const unique = [...new Set(paths)];
    for (const pathChunk of chunk(unique, STORAGE_REMOVE_CHUNK_SIZE)) {
      const { data, error } = await purgeClient.storage.from(bucket).remove(pathChunk);
      if (error) {
        for (const path of pathChunk) failed.push({ bucket, path, error: error.message });
      } else {
        removed += Array.isArray(data) ? data.length : pathChunk.length;
      }
    }
  }
  return { removed, failed };
}

async function writePurgeReceipt(receipt) {
  if (!selectedRootHandle) return false;
  try {
    const archiveDir = await selectedRootHandle.getDirectoryHandle("Archive", { create: true });
    const file = await archiveDir.getFileHandle("Last Purge Run.json", { create: true });
    const writable = await file.createWritable();
    await writable.write(JSON.stringify(receipt, null, 2) + "\n");
    await writable.close();
    return true;
  } catch (error) {
    console.warn("Could not write purge receipt locally:", error);
    return false;
  }
}

async function runVerifiedPurge() {
  if (purgeInProgress || !exportSnapshot?.records?.length) return;
  if (!byId("archive-purge-verified")?.checked || byId("archive-purge-confirm")?.value.trim() !== "PURGE") return;

  purgeInProgress = true;
  byId("archive-purge-now").disabled = true;
  byId("archive-purge-later").disabled = true;
  const progress = byId("archive-purge-progress");
  const meta = byId("archive-purge-meta");
  progress.classList.remove("hidden");
  progress.value = 0;

  const manifestPayload = JSON.stringify({ cutoff: exportSnapshot.cutoff, records: exportSnapshot.records });
  const manifestSha256 = await sha256Hex(manifestPayload);
  const chunks = chunk(exportSnapshot.records, PURGE_CHUNK_SIZE);
  const receipt = {
    started_at: new Date().toISOString(),
    cutoff: exportSnapshot.cutoff,
    manifest_sha256: manifestSha256,
    records_requested: exportSnapshot.records.length,
    chunks: [],
  };

  for (let i = 0; i < chunks.length; i++) {
    const records = chunks[i];
    meta.textContent = `Validating purge chunk ${i + 1} of ${chunks.length}…`;

    const { error: dryError } = await purgeClient.rpc("purge_verified_archive_records", {
      p_records: records,
      p_cutoff: exportSnapshot.cutoff,
      p_manifest_sha256: manifestSha256,
      p_chunk_number: i + 1,
      p_confirmation: "DRY RUN",
      p_dry_run: true,
    });
    if (dryError) throw new Error(`Chunk ${i + 1} validation failed: ${dryError.message}`);

    meta.textContent = `Purging verified chunk ${i + 1} of ${chunks.length}…`;
    const { data, error } = await purgeClient.rpc("purge_verified_archive_records", {
      p_records: records,
      p_cutoff: exportSnapshot.cutoff,
      p_manifest_sha256: manifestSha256,
      p_chunk_number: i + 1,
      p_confirmation: "PURGE",
      p_dry_run: false,
    });
    if (error) throw new Error(`Chunk ${i + 1} purge failed: ${error.message}`);

    const cleanup = await removeStorageItems(data?.storage_items || []);
    if (data?.purge_run_id) {
      const { error: cleanupRecordError } = await purgeClient.rpc("record_archive_storage_cleanup", {
        p_purge_run_id: data.purge_run_id,
        p_removed_count: cleanup.removed,
        p_failed: cleanup.failed,
      });
      if (cleanupRecordError) console.warn("Could not record storage cleanup result:", cleanupRecordError);
    }

    receipt.chunks.push({
      chunk_number: i + 1,
      purge_run_id: data?.purge_run_id || null,
      requested: records.length,
      deleted: data?.deleted || {},
      storage_removed: cleanup.removed,
      storage_failures: cleanup.failed,
    });
    progress.value = Math.round(((i + 1) / chunks.length) * 100);
  }

  receipt.completed_at = new Date().toISOString();
  receipt.supabase_deleted = true;
  receipt.storage_failures = receipt.chunks.reduce((n, row) => n + row.storage_failures.length, 0);
  receipt.receipt_written_locally = await writePurgeReceipt(receipt);

  purgeInProgress = false;
  meta.textContent = receipt.storage_failures
    ? `Purge complete. ${exportSnapshot.records.length.toLocaleString()} operational records were removed. ${receipt.storage_failures} storage object(s) could not be cleaned up; details are in the purge receipt.`
    : `Purge complete. ${exportSnapshot.records.length.toLocaleString()} operational records were removed and storage cleanup completed.`;
  byId("archive-purge-later").disabled = false;
  byId("archive-purge-later").textContent = "Close";
  byId("archive-purge-now").classList.add("hidden");

  const status = byId("archive-status");
  if (status) status.textContent = `Archive verified and purge complete: ${exportSnapshot.records.length.toLocaleString()} exported operational records removed from Supabase. Permanent analytics history remains available.`;
}

function installDirectoryPickerCapture() {
  if (typeof window.showDirectoryPicker !== "function" || window.showDirectoryPicker.__archivePurgeWrapped) return;
  const original = window.showDirectoryPicker.bind(window);
  const wrapped = async (...args) => {
    const handle = await original(...args);
    selectedRootHandle = handle;
    return handle;
  };
  wrapped.__archivePurgeWrapped = true;
  window.showDirectoryPicker = wrapped;
}

function installExportSnapshotCapture() {
  const exportBtn = byId("archive-export");
  if (!exportBtn) return;
  exportBtn.addEventListener("click", () => {
    exportSnapshot = null;
    captureExportSnapshot().catch((error) => {
      console.error("Could not capture purge manifest before export:", error);
      const status = byId("archive-status");
      if (status) status.textContent = `Export can continue, but purge will stay disabled because the exact-record manifest could not be captured: ${error.message || error}`;
    });
  });
}

function installExportCompletionWatcher() {
  const status = byId("archive-status");
  if (!status) return;
  const observer = new MutationObserver(() => {
    if (status.textContent.startsWith("Export complete:") && exportSnapshot?.records?.length) {
      showPurgeModal();
    }
  });
  observer.observe(status, { childList: true, characterData: true, subtree: true });
}

installDirectoryPickerCapture();
installExportSnapshotCapture();
installExportCompletionWatcher();
