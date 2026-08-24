const SUPABASE_URL = "https://ygsapysqzwrpcimgvaqx.supabase.co";
const SUPABASE_KEY = "sb_publishable_8b8bSIiYm5TzLTw0WG1pAw_5ZWW5ZPL";
const INTERNAL_LOCATIONS = ["atlanta", "buildingc", "delaware"];
const ROUTE_IMAGE_BUCKET = "mondelez-routes";
const TRIP_SHEET_BUCKET = "trip-sheets";
const PAGE_SIZE = 1000;

const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: "dl-dispatch-auth" },
});

const $ = (s) => document.querySelector(s);
const statusEl = $("#archive-status");
const exportBtn = $("#archive-export");
const previewBtn = $("#archive-preview");
const cutoffInput = $("#archive-cutoff");
const progressEl = $("#archive-progress");
let currentPreview = null;

function sixMonthsAgoIso() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setMonth(d.getMonth() - 6);
  return d.toISOString().slice(0, 10);
}

function safeName(value, fallback = "Unknown") {
  const s = String(value ?? "").trim() || fallback;
  return s.replace(/[<>:"/\\|?*\x00-\x1F]/g, "-").replace(/\s+/g, " ").slice(0, 120);
}

function monthFolder(dateKey) {
  const d = new Date(`${dateKey}T00:00:00`);
  const month = String(d.getMonth() + 1).padStart(2, "0");
  return `${month}-${d.toLocaleString("en-US", { month: "long" })}`;
}

function csvEscape(value) {
  if (value == null) return "";
  const s = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows, preferredColumns = []) {
  if (!rows.length) return preferredColumns.length ? `${preferredColumns.join(",")}\n` : "";
  const columns = [...preferredColumns];
  const seen = new Set(columns);
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) { seen.add(key); columns.push(key); }
    }
  }
  return [
    columns.map(csvEscape).join(","),
    ...rows.map((row) => columns.map((key) => csvEscape(row[key])).join(",")),
  ].join("\n") + "\n";
}

function fieldValueRows(object) {
  return Object.entries(object || {}).map(([field, value]) => ({
    Field: field,
    Value: value == null ? "" : (typeof value === "object" ? JSON.stringify(value) : value),
  }));
}

async function fetchAll(table, select = "*", apply = null) {
  const out = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    let q = client.from(table).select(select).range(from, from + PAGE_SIZE - 1);
    if (apply) q = apply(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) break;
  }
  return out;
}

async function fetchByIds(table, column, ids, select = "*") {
  if (!ids.length) return [];
  const out = [];
  for (let i = 0; i < ids.length; i += 150) {
    const { data, error } = await client.from(table).select(select).in(column, ids.slice(i, i + 150));
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data || []));
  }
  return out;
}

async function getCurrentRole() {
  const { data: sessionData, error: sessionError } = await client.auth.getSession();
  if (sessionError || !sessionData?.session?.user) return null;
  const { data, error } = await client
    .from("user_roles")
    .select("role")
    .eq("user_id", sessionData.session.user.id)
    .limit(1);
  if (error) throw error;
  return data?.[0]?.role || null;
}

async function getEligibleShifts(cutoff) {
  return fetchAll("loads_shifts", "*", (q) => q
    .in("location", INTERNAL_LOCATIONS)
    .lt("shift_date", cutoff)
    .order("shift_date", { ascending: true })
    .order("id", { ascending: true }));
}

async function buildPreview(cutoff) {
  statusEl.textContent = "Checking historical loads…";
  exportBtn.disabled = true;
  currentPreview = null;

  const shifts = await getEligibleShifts(cutoff);
  const shiftIds = shifts.map((s) => s.id);
  const [trips, attachments, accounting] = await Promise.all([
    fetchByIds("loads_trips", "shift_id", shiftIds, "id,shift_id,route_id,trip_id,route_miles,stop_count"),
    fetchByIds("load_attachments", "shift_id", shiftIds, "id,shift_id,file_name,file_path"),
    fetchByIds("loads_accounting", "source_shift_id", shiftIds, "id,source_shift_id"),
  ]);

  const oldest = shifts[0]?.shift_date || null;
  const newest = shifts[shifts.length - 1]?.shift_date || null;
  currentPreview = { cutoff, shifts, trips, attachments, accounting };

  $("#archive-loads").textContent = shifts.length.toLocaleString();
  $("#archive-routes").textContent = trips.filter((t) => String(t.route_id || t.trip_id || "").trim()).length.toLocaleString();
  $("#archive-attachments").textContent = attachments.length.toLocaleString();
  $("#archive-accounting").textContent = accounting.length.toLocaleString();

  if (!shifts.length) {
    statusEl.textContent = `No load-board loads are older than ${cutoff}. Nothing is due yet.`;
    return;
  }

  statusEl.textContent = `${shifts.length.toLocaleString()} loads ready, covering ${oldest} through ${newest}. No Supabase records will be deleted.`;
  exportBtn.disabled = false;
}

async function getOrCreateDir(parent, name) {
  return parent.getDirectoryHandle(safeName(name), { create: true });
}

async function writeFile(dir, name, contents) {
  const handle = await dir.getFileHandle(safeName(name), { create: true });
  const writable = await handle.createWritable();
  await writable.write(contents);
  await writable.close();
}

async function verifyLocalWrite(chosenRoot, archiveDir) {
  if (typeof chosenRoot.requestPermission === "function") {
    const permission = await chosenRoot.requestPermission({ mode: "readwrite" });
    if (permission !== "granted") {
      throw new Error("Windows/browser did not grant write access to the selected folder.");
    }
  }

  const markerName = "Archive Export Info.txt";
  const markerText = [
    "M-J Site archive local-write verification",
    `Selected folder: ${chosenRoot.name || "(browser did not provide a folder name)"}`,
    `Verified at: ${new Date().toISOString()}`,
    "If you can read this file in File Explorer, the browser has write access to this Archive folder.",
    "This file is safe to keep.",
    "",
  ].join("\n");

  await writeFile(archiveDir, markerName, markerText);
  const markerHandle = await archiveDir.getFileHandle(markerName);
  const markerFile = await markerHandle.getFile();
  const readBack = await markerFile.text();
  if (readBack !== markerText) {
    throw new Error("The browser created the archive test file but could not read back the same contents.");
  }

  return markerName;
}

async function writeBlob(dir, name, blob) {
  const handle = await dir.getFileHandle(safeName(name), { create: true });
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
}

async function downloadStorageObject(bucket, objectPath) {
  if (!objectPath) return null;
  const { data, error } = await client.storage.from(bucket).download(objectPath);
  if (error) throw new Error(`Storage ${bucket}/${objectPath}: ${error.message}`);
  return data;
}

async function loadPackage(shift) {
  const trips = await fetchAll("loads_trips", "*", (q) => q.eq("shift_id", shift.id).order("trip_number", { ascending: true }));
  const tripIds = trips.map((t) => t.id);
  const [stops, notes, changes, attachments, accounting] = await Promise.all([
    fetchByIds("trip_stops", "trip_id", tripIds),
    fetchAll("load_notes", "*", (q) => q.eq("shift_id", shift.id).order("created_at", { ascending: true })),
    fetchAll("load_change_history", "*", (q) => q.eq("shift_id", shift.id).order("changed_at", { ascending: true })),
    fetchAll("load_attachments", "*", (q) => q.eq("shift_id", shift.id).order("uploaded_at", { ascending: true })),
    fetchAll("loads_accounting", "*", (q) => q.eq("source_shift_id", shift.id).order("id", { ascending: true })),
  ]);
  const accountingRoutes = await fetchByIds("loads_accounting_routes", "accounting_id", accounting.map((a) => a.id));
  return { shift, trips, stops, notes, changes, attachments, accounting, accountingRoutes };
}

function driverNameFor(shift) {
  return shift.driver_name_text || `Driver ${shift.driver_id || "Unassigned"}`;
}

function summaryRow(pkg) {
  const driverName = driverNameFor(pkg.shift);
  const revenue = pkg.accounting.reduce((n, a) => n + (Number(a.total_revenue) || 0), 0);
  const cost = pkg.accounting.reduce((n, a) => n + (Number(a.total_cost) || 0), 0);
  return {
    Date: pkg.shift.shift_date,
    Location: pkg.shift.location,
    "Load #": pkg.shift.aljex_load_number || pkg.shift.pro_number || pkg.shift.id,
    Driver: driverName,
    Routes: pkg.trips.filter((t) => String(t.route_id || t.trip_id || "").trim()).length,
    Miles: pkg.trips.reduce((n, t) => n + (Number(t.route_miles) || 0), 0),
    Stops: pkg.trips.reduce((n, t) => n + (Number(t.stop_count) || 0), 0),
    Revenue: revenue,
    Cost: cost,
    Margin: revenue - cost,
  };
}

async function archiveOne(rootArchiveDir, shift, cutoff) {
  const pkg = await loadPackage(shift);
  const yearDir = await getOrCreateDir(rootArchiveDir, shift.shift_date.slice(0, 4));
  const monthDir = await getOrCreateDir(yearDir, monthFolder(shift.shift_date));
  const dayDir = await getOrCreateDir(monthDir, shift.shift_date);
  const loadNumber = shift.aljex_load_number || shift.pro_number || shift.id;
  const driverName = driverNameFor(shift);
  const loadDir = await getOrCreateDir(dayDir, `Load ${loadNumber} - ${driverName}`);
  const docsDir = await getOrCreateDir(loadDir, "Documents");

  const loadDetails = { ...pkg.shift, driver_name_archive: driverName };
  await writeFile(loadDir, "Load Details.json", JSON.stringify(loadDetails, null, 2) + "\n");
  await writeFile(loadDir, "Load Details.csv", toCsv(fieldValueRows(loadDetails), ["Field", "Value"]));
  await writeFile(loadDir, "Routes.csv", toCsv(pkg.trips));
  await writeFile(loadDir, "Stops.csv", toCsv(pkg.stops));
  await writeFile(loadDir, "Notes.csv", toCsv(pkg.notes));
  await writeFile(loadDir, "Change History.csv", toCsv(pkg.changes));
  await writeFile(loadDir, "Accounting.csv", toCsv(pkg.accounting));
  await writeFile(loadDir, "Accounting Routes.csv", toCsv(pkg.accountingRoutes));
  await writeFile(loadDir, "Attachments.csv", toCsv(pkg.attachments));

  const routeImagePaths = [...new Set([shift.route_image_path, ...pkg.trips.map((t) => t.route_image_path)].filter(Boolean))];
  const documentResults = [];

  for (const objectPath of routeImagePaths) {
    const blob = await downloadStorageObject(ROUTE_IMAGE_BUCKET, objectPath);
    const name = `Route Image - ${safeName(objectPath.split("/").pop())}`;
    await writeBlob(docsDir, name, blob);
    documentResults.push({ bucket: ROUTE_IMAGE_BUCKET, path: objectPath, file: name });
  }

  for (const attachment of pkg.attachments) {
    if (!attachment.file_path) continue;
    const blob = await downloadStorageObject(TRIP_SHEET_BUCKET, attachment.file_path);
    const name = safeName(attachment.file_name || attachment.file_path.split("/").pop());
    await writeBlob(docsDir, name, blob);
    documentResults.push({ bucket: TRIP_SHEET_BUCKET, path: attachment.file_path, file: name });
  }

  const manifest = {
    exported_at: new Date().toISOString(),
    cutoff,
    source_shift_id: shift.id,
    shift_date: shift.shift_date,
    location: shift.location,
    load_number: loadNumber,
    driver_name: driverName,
    counts: {
      trips: pkg.trips.length,
      stops: pkg.stops.length,
      notes: pkg.notes.length,
      changes: pkg.changes.length,
      attachments: pkg.attachments.length,
      accounting: pkg.accounting.length,
      accounting_routes: pkg.accountingRoutes.length,
    },
    documents: documentResults,
    supabase_deleted: false,
  };
  await writeFile(loadDir, "Archive Manifest.json", JSON.stringify(manifest, null, 2) + "\n");

  return { dayDir, dayKey: shift.shift_date, summary: summaryRow(pkg) };
}

async function runExport() {
  if (!currentPreview || !currentPreview.shifts.length) return;
  if (!("showDirectoryPicker" in window)) {
    statusEl.textContent = "This browser does not support folder export. Use current Chrome or Edge on desktop.";
    return;
  }

  exportBtn.disabled = true;
  previewBtn.disabled = true;
  progressEl.classList.remove("hidden");
  progressEl.value = 0;

  try {
    statusEl.textContent = "Choose the local Windows folder that should contain the Archive folder…";
    const chosenRoot = await window.showDirectoryPicker({ mode: "readwrite" });
    const archiveDir = await getOrCreateDir(chosenRoot, "Archive");
    const markerName = await verifyLocalWrite(chosenRoot, archiveDir);
    const selectedLabel = chosenRoot.name || "selected folder";
    statusEl.textContent = `Local write verified: ${selectedLabel}\\Archive\\${markerName}. Starting archive export…`;

    const summariesByDay = new Map();
    const total = currentPreview.shifts.length;

    for (let i = 0; i < total; i++) {
      const shift = currentPreview.shifts[i];
      statusEl.textContent = `Writing to ${selectedLabel}\\Archive — exporting ${i + 1} of ${total}: ${shift.shift_date} — ${shift.aljex_load_number || shift.pro_number || shift.id}`;
      const result = await archiveOne(archiveDir, shift, currentPreview.cutoff);
      if (!summariesByDay.has(result.dayKey)) summariesByDay.set(result.dayKey, { dir: result.dayDir, rows: [] });
      summariesByDay.get(result.dayKey).rows.push(result.summary);
      progressEl.value = Math.round(((i + 1) / total) * 100);
    }

    for (const { dir, rows } of summariesByDay.values()) {
      await writeFile(dir, "Daily Summary.csv", toCsv(rows, [
        "Date", "Location", "Load #", "Driver", "Routes", "Miles", "Stops", "Revenue", "Cost", "Margin",
      ]));
    }

    await writeFile(archiveDir, "Last Archive Run.json", JSON.stringify({
      completed_at: new Date().toISOString(),
      cutoff: currentPreview.cutoff,
      loads_exported: total,
      selected_folder_name: selectedLabel,
      local_write_verified: true,
      supabase_deleted: false,
    }, null, 2) + "\n");

    statusEl.textContent = `Export complete: ${total.toLocaleString()} loads written locally. In File Explorer, open the folder you selected (${selectedLabel}) and then open Archive. You should see ${markerName}, Last Archive Run.json, and the dated archive folders. Nothing was deleted from Supabase.`;
  } catch (error) {
    if (error?.name === "AbortError") {
      statusEl.textContent = "Export cancelled. Nothing was changed in Supabase.";
    } else {
      console.error("Archive export failed:", error);
      statusEl.textContent = `Local export stopped: ${error.message || error}. No Supabase records were deleted. If an Archive folder was created, it may contain the write-test file and any files completed before the error.`;
    }
  } finally {
    progressEl.classList.add("hidden");
    previewBtn.disabled = false;
    exportBtn.disabled = !(currentPreview?.shifts?.length);
  }
}

async function init() {
  const role = await getCurrentRole();
  if (role !== "admin" && role !== "it") {
    window.location.href = role ? "index.html" : "login.html";
    return;
  }

  cutoffInput.value = sixMonthsAgoIso();
  previewBtn.addEventListener("click", () => buildPreview(cutoffInput.value).catch((e) => {
    console.error(e);
    statusEl.textContent = `Could not load archive preview: ${e.message || e}`;
  }));
  cutoffInput.addEventListener("change", () => buildPreview(cutoffInput.value).catch((e) => {
    console.error(e);
    statusEl.textContent = `Could not load archive preview: ${e.message || e}`;
  }));
  exportBtn.addEventListener("click", runExport);

  await buildPreview(cutoffInput.value);
}

init().catch((error) => {
  console.error("Archive page initialization failed:", error);
  statusEl.textContent = `Archive page could not start: ${error.message || error}`;
});