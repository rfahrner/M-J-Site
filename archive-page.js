const SUPABASE_URL = "https://ygsapysqzwrpcimgvaqx.supabase.co";
const SUPABASE_KEY = "sb_publishable_8b8bSIiYm5TzLTw0WG1pAw_5ZWW5ZPL";
const ROUTE_IMAGE_BUCKET = "mondelez-routes";
const TRIP_SHEET_BUCKET = "trip-sheets";
const PAGE_SIZE = 1000;

const KROGER_LOCATION_LABELS = {
  atlanta: "Atlanta",
  buildingc: "Building C",
  delaware: "Delaware",
  houston: "Houston",
};
const MONDELEZ_LOCATION_LABELS = {
  westchester: "West Chester",
  morris: "Morris",
  addison: "Addison",
  indianapolis: "Indianapolis",
  louisville: "Louisville",
  spokane: "Spokane",
  lasvegas: "Las Vegas",
  boise: "Boise",
  kent: "Kent",
  saltlakecity: "Salt Lake City",
  newberlin: "New Berlin",
};

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

function titleCaseLocation(value) {
  const raw = String(value || "Unknown").replace(/[_-]+/g, " ").trim();
  return raw.replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function locationLabel(item) {
  if (item.customer === "Kroger") return KROGER_LOCATION_LABELS[item.location] || titleCaseLocation(item.location);
  return MONDELEZ_LOCATION_LABELS[item.location] || titleCaseLocation(item.location);
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

async function getEligibleRecords(cutoff) {
  const [krogerRows, houstonRows, mondelezRows] = await Promise.all([
    fetchAll("loads_shifts", "*", (q) => q
      .in("location", ["atlanta", "buildingc", "delaware"])
      .lt("shift_date", cutoff)
      .order("shift_date", { ascending: true })
      .order("id", { ascending: true })),
    fetchAll("loads_houston", "*", (q) => q
      .lt("shift_date", cutoff)
      .order("shift_date", { ascending: true })
      .order("id", { ascending: true })),
    fetchAll("mondelez_loads", "*", (q) => q
      .lt("shift_date", cutoff)
      .order("shift_date", { ascending: true })
      .order("location", { ascending: true })
      .order("id", { ascending: true })),
  ]);

  const items = [
    ...krogerRows.map((record) => ({ source: "loads_shifts", customer: "Kroger", location: record.location, record })),
    ...houstonRows.map((record) => ({ source: "loads_houston", customer: "Kroger", location: "houston", record })),
    ...mondelezRows.map((record) => ({ source: "mondelez_loads", customer: "Mondelez", location: record.location || "unknown", record })),
  ];

  items.sort((a, b) =>
    String(a.record.shift_date).localeCompare(String(b.record.shift_date)) ||
    a.customer.localeCompare(b.customer) ||
    locationLabel(a).localeCompare(locationLabel(b)) ||
    Number(a.record.id) - Number(b.record.id));

  return { items, krogerRows, houstonRows, mondelezRows };
}

async function buildPreview(cutoff) {
  statusEl.textContent = "Checking historical loads across all locations…";
  exportBtn.disabled = true;
  currentPreview = null;

  const eligible = await getEligibleRecords(cutoff);
  const shiftIds = eligible.krogerRows.map((s) => s.id);
  const houstonIds = eligible.houstonRows.map((s) => s.id);
  const [trips, attachments, shiftAccounting, houstonAccounting] = await Promise.all([
    fetchByIds("loads_trips", "shift_id", shiftIds, "id,shift_id,route_id,trip_id,route_miles,stop_count"),
    fetchByIds("load_attachments", "shift_id", shiftIds, "id,shift_id,file_name,file_path"),
    fetchByIds("loads_accounting", "source_shift_id", shiftIds, "id,source_shift_id"),
    fetchByIds("loads_accounting", "source_houston_id", houstonIds, "id,source_houston_id"),
  ]);

  const oldest = eligible.items[0]?.record?.shift_date || null;
  const newest = eligible.items[eligible.items.length - 1]?.record?.shift_date || null;
  const mondelezRouteCount = eligible.mondelezRows.length;
  const internalRouteCount = trips.filter((t) => String(t.route_id || t.trip_id || "").trim()).length;

  currentPreview = {
    cutoff,
    ...eligible,
    trips,
    attachments,
    accounting: [...shiftAccounting, ...houstonAccounting],
  };

  $("#archive-loads").textContent = eligible.items.length.toLocaleString();
  $("#archive-routes").textContent = (internalRouteCount + mondelezRouteCount).toLocaleString();
  $("#archive-attachments").textContent = attachments.length.toLocaleString();
  $("#archive-accounting").textContent = (shiftAccounting.length + houstonAccounting.length).toLocaleString();

  if (!eligible.items.length) {
    statusEl.textContent = `No loads from any active location are older than ${cutoff}. Nothing is due yet.`;
    return;
  }

  const byCustomer = eligible.items.reduce((acc, item) => {
    acc[item.customer] = (acc[item.customer] || 0) + 1;
    return acc;
  }, {});
  const breakdown = Object.entries(byCustomer).map(([name, count]) => `${name}: ${count.toLocaleString()}`).join(" • ");
  statusEl.textContent = `${eligible.items.length.toLocaleString()} loads ready across all locations, covering ${oldest} through ${newest}. ${breakdown}. No Supabase records will be deleted.`;
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
    if (permission !== "granted") throw new Error("Windows/browser did not grant write access to the selected folder.");
  }

  const markerName = "Archive Export Info.txt";
  const markerText = [
    "M-J Site archive local-write verification",
    `Selected folder: ${chosenRoot.name || "(browser did not provide a folder name)"}`,
    `Verified at: ${new Date().toISOString()}`,
    "Archive layout: Customer / Location / Date / Load",
    "If you can read this file in File Explorer, the browser has write access to this Archive folder.",
    "",
  ].join("\n");

  await writeFile(archiveDir, markerName, markerText);
  const markerHandle = await archiveDir.getFileHandle(markerName);
  const markerFile = await markerHandle.getFile();
  const readBack = await markerFile.text();
  if (readBack !== markerText) throw new Error("The browser created the archive test file but could not read back the same contents.");
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

async function archiveDateDir(rootArchiveDir, item) {
  const customerDir = await getOrCreateDir(rootArchiveDir, item.customer);
  const locationDir = await getOrCreateDir(customerDir, locationLabel(item));
  return getOrCreateDir(locationDir, item.record.shift_date);
}

function loadNumberFor(item) {
  if (item.source === "loads_shifts") return item.record.aljex_load_number || item.record.pro_number || item.record.id;
  return item.record.aljex_number || item.record.id;
}

function driverNameFor(item) {
  if (item.source === "loads_shifts") return item.record.driver_name_text || `Driver ${item.record.driver_id || "Unassigned"}`;
  return item.record.driver_name || `Driver ${item.record.driver_id || "Unassigned"}`;
}

function summaryRow(item, pkg = {}) {
  const record = item.record;
  const driver = driverNameFor(item);
  let routes = 0;
  let miles = 0;
  let stops = 0;
  let revenue = 0;
  let cost = 0;

  if (item.source === "loads_shifts") {
    routes = (pkg.trips || []).filter((t) => String(t.route_id || t.trip_id || "").trim()).length;
    miles = (pkg.trips || []).reduce((n, t) => n + (Number(t.route_miles) || 0), 0);
    stops = (pkg.trips || []).reduce((n, t) => n + (Number(t.stop_count) || 0), 0);
    revenue = (pkg.accounting || []).reduce((n, a) => n + (Number(a.total_revenue) || 0), 0);
    cost = (pkg.accounting || []).reduce((n, a) => n + (Number(a.total_cost) || 0), 0);
  } else if (item.source === "loads_houston") {
    revenue = (pkg.accounting || []).reduce((n, a) => n + (Number(a.total_revenue) || 0), 0);
    cost = (pkg.accounting || []).reduce((n, a) => n + (Number(a.total_cost) || 0), 0);
  } else {
    routes = 1;
    miles = Number(record.miles) || 0;
    stops = Number(record.stop_count) || 0;
    revenue = Number(record.revenue_total) || 0;
    cost = Number(record.carrier_pay) || 0;
  }

  return {
    Date: record.shift_date,
    Customer: item.customer,
    Location: locationLabel(item),
    "Load #": loadNumberFor(item),
    Driver: driver,
    Routes: routes,
    Miles: miles,
    Stops: stops,
    Revenue: revenue,
    Cost: cost,
    Margin: revenue - cost,
  };
}

async function loadInternalPackage(shift) {
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
  return { trips, stops, notes, changes, attachments, accounting, accountingRoutes };
}

async function loadHoustonPackage(row) {
  const accounting = await fetchAll("loads_accounting", "*", (q) => q.eq("source_houston_id", row.id).order("id", { ascending: true }));
  const accountingRoutes = await fetchByIds("loads_accounting_routes", "accounting_id", accounting.map((a) => a.id));
  return { accounting, accountingRoutes };
}

async function writeRouteImage(docsDir, objectPath, prefix = "Route Image") {
  if (!objectPath) return [];
  const blob = await downloadStorageObject(ROUTE_IMAGE_BUCKET, objectPath);
  const name = `${prefix} - ${safeName(objectPath.split("/").pop())}`;
  await writeBlob(docsDir, name, blob);
  return [{ bucket: ROUTE_IMAGE_BUCKET, path: objectPath, file: name }];
}

async function archiveInternal(rootArchiveDir, item, cutoff) {
  const shift = item.record;
  const pkg = await loadInternalPackage(shift);
  const dayDir = await archiveDateDir(rootArchiveDir, item);
  const loadDir = await getOrCreateDir(dayDir, `Load ${loadNumberFor(item)} - ${driverNameFor(item)}`);
  const docsDir = await getOrCreateDir(loadDir, "Documents");

  const loadDetails = { ...shift, driver_name_archive: driverNameFor(item) };
  await writeFile(loadDir, "Load Details.json", JSON.stringify(loadDetails, null, 2) + "\n");
  await writeFile(loadDir, "Load Details.csv", toCsv(fieldValueRows(loadDetails), ["Field", "Value"]));
  await writeFile(loadDir, "Routes.csv", toCsv(pkg.trips));
  await writeFile(loadDir, "Stops.csv", toCsv(pkg.stops));
  await writeFile(loadDir, "Notes.csv", toCsv(pkg.notes));
  await writeFile(loadDir, "Change History.csv", toCsv(pkg.changes));
  await writeFile(loadDir, "Accounting.csv", toCsv(pkg.accounting));
  await writeFile(loadDir, "Accounting Routes.csv", toCsv(pkg.accountingRoutes));
  await writeFile(loadDir, "Attachments.csv", toCsv(pkg.attachments));

  const documentResults = [];
  const routeImagePaths = [...new Set([shift.route_image_path, ...pkg.trips.map((t) => t.route_image_path)].filter(Boolean))];
  for (const objectPath of routeImagePaths) {
    const result = await writeRouteImage(docsDir, objectPath);
    documentResults.push(...result);
  }
  for (const attachment of pkg.attachments) {
    if (!attachment.file_path) continue;
    const blob = await downloadStorageObject(TRIP_SHEET_BUCKET, attachment.file_path);
    const name = safeName(attachment.file_name || attachment.file_path.split("/").pop());
    await writeBlob(docsDir, name, blob);
    documentResults.push({ bucket: TRIP_SHEET_BUCKET, path: attachment.file_path, file: name });
  }

  const manifest = {
    exported_at: new Date().toISOString(), cutoff, source_table: item.source, source_id: shift.id,
    customer: item.customer, location: item.location, location_label: locationLabel(item),
    shift_date: shift.shift_date, load_number: loadNumberFor(item), driver_name: driverNameFor(item),
    counts: { trips: pkg.trips.length, stops: pkg.stops.length, notes: pkg.notes.length, changes: pkg.changes.length, attachments: pkg.attachments.length, accounting: pkg.accounting.length, accounting_routes: pkg.accountingRoutes.length },
    documents: documentResults, supabase_deleted: false,
  };
  await writeFile(loadDir, "Archive Manifest.json", JSON.stringify(manifest, null, 2) + "\n");
  return { dayDir, groupKey: `${item.customer}|${item.location}|${shift.shift_date}`, summary: summaryRow(item, pkg) };
}

async function archiveHouston(rootArchiveDir, item, cutoff) {
  const row = item.record;
  const pkg = await loadHoustonPackage(row);
  const dayDir = await archiveDateDir(rootArchiveDir, item);
  const loadDir = await getOrCreateDir(dayDir, `Load ${loadNumberFor(item)} - ${driverNameFor(item)}`);
  const docsDir = await getOrCreateDir(loadDir, "Documents");

  const loadDetails = { ...row, driver_name_archive: driverNameFor(item) };
  await writeFile(loadDir, "Load Details.json", JSON.stringify(loadDetails, null, 2) + "\n");
  await writeFile(loadDir, "Load Details.csv", toCsv(fieldValueRows(loadDetails), ["Field", "Value"]));
  await writeFile(loadDir, "Accounting.csv", toCsv(pkg.accounting));
  await writeFile(loadDir, "Accounting Routes.csv", toCsv(pkg.accountingRoutes));

  const documents = await writeRouteImage(docsDir, row.route_image_path);
  const manifest = {
    exported_at: new Date().toISOString(), cutoff, source_table: item.source, source_id: row.id,
    customer: item.customer, location: item.location, location_label: locationLabel(item),
    shift_date: row.shift_date, load_number: loadNumberFor(item), driver_name: driverNameFor(item),
    counts: { accounting: pkg.accounting.length, accounting_routes: pkg.accountingRoutes.length },
    documents, supabase_deleted: false,
  };
  await writeFile(loadDir, "Archive Manifest.json", JSON.stringify(manifest, null, 2) + "\n");
  return { dayDir, groupKey: `${item.customer}|${item.location}|${row.shift_date}`, summary: summaryRow(item, pkg) };
}

async function archiveMondelez(rootArchiveDir, item, cutoff) {
  const row = item.record;
  const dayDir = await archiveDateDir(rootArchiveDir, item);
  const loadDir = await getOrCreateDir(dayDir, `Load ${loadNumberFor(item)} - ${driverNameFor(item)}`);
  const docsDir = await getOrCreateDir(loadDir, "Documents");

  const loadDetails = { ...row, driver_name_archive: driverNameFor(item) };
  await writeFile(loadDir, "Load Details.json", JSON.stringify(loadDetails, null, 2) + "\n");
  await writeFile(loadDir, "Load Details.csv", toCsv(fieldValueRows(loadDetails), ["Field", "Value"]));

  const documents = await writeRouteImage(docsDir, row.route_image_path);
  const manifest = {
    exported_at: new Date().toISOString(), cutoff, source_table: item.source, source_id: row.id,
    customer: item.customer, location: item.location, location_label: locationLabel(item),
    shift_date: row.shift_date, load_number: loadNumberFor(item), driver_name: driverNameFor(item),
    documents, supabase_deleted: false,
  };
  await writeFile(loadDir, "Archive Manifest.json", JSON.stringify(manifest, null, 2) + "\n");
  return { dayDir, groupKey: `${item.customer}|${item.location}|${row.shift_date}`, summary: summaryRow(item) };
}

async function archiveOne(rootArchiveDir, item, cutoff) {
  if (item.source === "loads_shifts") return archiveInternal(rootArchiveDir, item, cutoff);
  if (item.source === "loads_houston") return archiveHouston(rootArchiveDir, item, cutoff);
  if (item.source === "mondelez_loads") return archiveMondelez(rootArchiveDir, item, cutoff);
  throw new Error(`Unsupported archive source: ${item.source}`);
}

async function runExport() {
  if (!currentPreview || !currentPreview.items.length) return;
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
    statusEl.textContent = `Local write verified: ${selectedLabel}\\Archive\\${markerName}. Starting all-location archive export…`;

    const summariesByDay = new Map();
    const total = currentPreview.items.length;
    const locationCounts = {};

    for (let i = 0; i < total; i++) {
      const item = currentPreview.items[i];
      const loc = locationLabel(item);
      statusEl.textContent = `Writing to ${selectedLabel}\\Archive\\${item.customer}\\${loc} — exporting ${i + 1} of ${total}: ${item.record.shift_date} — ${loadNumberFor(item)}`;
      const result = await archiveOne(archiveDir, item, currentPreview.cutoff);
      if (!summariesByDay.has(result.groupKey)) summariesByDay.set(result.groupKey, { dir: result.dayDir, rows: [] });
      summariesByDay.get(result.groupKey).rows.push(result.summary);
      const countKey = `${item.customer} / ${loc}`;
      locationCounts[countKey] = (locationCounts[countKey] || 0) + 1;
      progressEl.value = Math.round(((i + 1) / total) * 100);
    }

    for (const { dir, rows } of summariesByDay.values()) {
      await writeFile(dir, "Daily Summary.csv", toCsv(rows, [
        "Date", "Customer", "Location", "Load #", "Driver", "Routes", "Miles", "Stops", "Revenue", "Cost", "Margin",
      ]));
    }

    await writeFile(archiveDir, "Last Archive Run.json", JSON.stringify({
      completed_at: new Date().toISOString(),
      cutoff: currentPreview.cutoff,
      loads_exported: total,
      loads_by_location: locationCounts,
      selected_folder_name: selectedLabel,
      local_write_verified: true,
      folder_layout: "Archive/Customer/Location/YYYY-MM-DD/Load...",
      supabase_deleted: false,
    }, null, 2) + "\n");

    statusEl.textContent = `Export complete: ${total.toLocaleString()} loads written locally and separated by customer/location. In File Explorer, open ${selectedLabel}\\Archive. Nothing was deleted from Supabase.`;
  } catch (error) {
    if (error?.name === "AbortError") {
      statusEl.textContent = "Export cancelled. Nothing was changed in Supabase.";
    } else {
      console.error("Archive export failed:", error);
      statusEl.textContent = `Local export stopped: ${error.message || error}. No Supabase records were deleted. Files completed before the error are safe to keep.`;
    }
  } finally {
    progressEl.classList.add("hidden");
    previewBtn.disabled = false;
    exportBtn.disabled = !(currentPreview?.items?.length);
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
