import { ARCHIVE_FORMAT_VERSION, exportRouteDocuments, archivedDocumentsPresent } from './archive-documents.js';

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
let currentCounts = null;

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

// Counting used to mean downloading. The old preview pulled every eligible
// load with select *, then every trip, attachment and accounting row for them
// in 150-id chunks -- with ~21,000 old loads that is roughly 330 sequential
// requests before the page can show four numbers, which is why the Archive
// page looked dead on arrival and the six-month cutoff felt like it did
// nothing. One server-side call replaces all of it, in about two seconds.
//
// archive_eligible_counts() is SECURITY INVOKER, so it counts exactly the rows
// the signed-in user is allowed to read -- see
// supabase/migrations/20260921_archive_eligible_counts.sql, which also records
// the live numbers it was checked against.
//
// The full records are still needed to write the files, but they are fetched
// only once Export is actually pressed.
async function countEligible(cutoff) {
  const { data, error } = await client.rpc("archive_eligible_counts", { p_cutoff: cutoff });
  if (error) throw new Error(`Archive counts: ${error.message}`);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error("Archive counts came back empty.");

  const num = (value) => Number(value || 0);
  const kroger = num(row.kroger_loads) + num(row.houston_loads);
  const mondelez = num(row.mondelez_loads);

  return {
    cutoff,
    loads: kroger + mondelez,
    kroger,
    mondelez,
    routes: num(row.routes),
    attachments: num(row.attachments),
    accounting: num(row.accounting_rows),
  };
}

function describeCutoff(cutoff) {
  const date = new Date(`${cutoff}T00:00:00`);
  if (Number.isNaN(date.getTime())) return cutoff;
  return date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

async function refreshCounts(cutoff) {
  statusEl.textContent = `Counting everything dated before ${describeCutoff(cutoff)}\u2026`;
  exportBtn.disabled = true;
  currentCounts = null;
  currentPreview = null;

  const counts = await countEligible(cutoff);
  currentCounts = counts;

  $("#archive-loads").textContent = counts.loads.toLocaleString();
  $("#archive-routes").textContent = counts.routes.toLocaleString();
  $("#archive-attachments").textContent = counts.attachments.toLocaleString();
  $("#archive-accounting").textContent = counts.accounting.toLocaleString();

  if (!counts.loads) {
    statusEl.textContent = `Nothing is dated before ${describeCutoff(cutoff)}. Pick a later date to include more.`;
    return counts;
  }

  const breakdown = [
    counts.kroger ? `Kroger: ${counts.kroger.toLocaleString()}` : null,
    counts.mondelez ? `Mondelez: ${counts.mondelez.toLocaleString()}` : null,
  ].filter(Boolean).join(" \u2022 ");

  statusEl.textContent =
    `${counts.loads.toLocaleString()} loads dated before ${describeCutoff(cutoff)} \u2014 ${breakdown}. ` +
    `Export writes them to a folder you choose, images included. Nothing is deleted from Supabase.`;
  exportBtn.disabled = false;
  return counts;
}

// The full record set, fetched only when an export actually starts.
async function loadFullRecords(cutoff) {
  const eligible = await getEligibleRecords(cutoff);
  const shiftIds = eligible.krogerRows.map((s) => s.id);
  const houstonIds = eligible.houstonRows.map((s) => s.id);
  const [trips, attachments, shiftAccounting, houstonAccounting] = await Promise.all([
    fetchByIds("loads_trips", "shift_id", shiftIds, "id,shift_id,route_id,trip_id,route_miles,stop_count"),
    fetchByIds("load_attachments", "shift_id", shiftIds, "id,shift_id,file_name,file_path"),
    fetchByIds("loads_accounting", "source_shift_id", shiftIds, "id,source_shift_id,total_cost,total_revenue"),
    fetchByIds("loads_accounting", "source_houston_id", houstonIds, "id,source_houston_id,total_cost,total_revenue"),
  ]);

  currentPreview = {
    cutoff,
    ...eligible,
    trips,
    attachments,
    accounting: [...shiftAccounting, ...houstonAccounting],
  };
  return currentPreview;
}

async function getOrCreateDir(parent, name) {
  return parent.getDirectoryHandle(safeName(name), { create: true });
}

async function getExistingDir(parent, name) {
  try {
    return await parent.getDirectoryHandle(safeName(name), { create: false });
  } catch (error) {
    if (error?.name === "NotFoundError") return null;
    throw error;
  }
}

async function readJsonFile(dir, name) {
  try {
    const handle = await dir.getFileHandle(safeName(name), { create: false });
    const file = await handle.getFile();
    return JSON.parse(await file.text());
  } catch (error) {
    if (error?.name === "NotFoundError" || error instanceof SyntaxError) return null;
    throw error;
  }
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
  if ((await handle.getFile()).size !== blob.size) throw new Error(`Incomplete document write: ${name}`);
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

async function existingArchiveDateDir(rootArchiveDir, item) {
  const customerDir = await getExistingDir(rootArchiveDir, item.customer);
  if (!customerDir) return null;
  const locationDir = await getExistingDir(customerDir, locationLabel(item));
  if (!locationDir) return null;
  return getExistingDir(locationDir, item.record.shift_date);
}

function loadNumberFor(item) {
  if (item.source === "loads_shifts") return item.record.aljex_load_number || item.record.pro_number || item.record.id;
  return item.record.aljex_number || item.record.id;
}

function driverNameFor(item) {
  if (item.source === "loads_shifts") return item.record.driver_name_text || `Driver ${item.record.driver_id || "Unassigned"}`;
  return item.record.driver_name || `Driver ${item.record.driver_id || "Unassigned"}`;
}

function previewPackageFor(item) {
  if (!currentPreview) return {};
  if (item.source === "loads_shifts") {
    return {
      trips: currentPreview.trips.filter((row) => Number(row.shift_id) === Number(item.record.id)),
      accounting: currentPreview.accounting.filter((row) => Number(row.source_shift_id) === Number(item.record.id)),
    };
  }
  if (item.source === "loads_houston") {
    return {
      accounting: currentPreview.accounting.filter((row) => Number(row.source_houston_id) === Number(item.record.id)),
    };
  }
  return {};
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

async function findCompletedArchive(rootArchiveDir, item) {
  const dayDir = await existingArchiveDateDir(rootArchiveDir, item);
  if (!dayDir) return null;
  const loadDir = await getExistingDir(dayDir, `Load ${loadNumberFor(item)} - ${driverNameFor(item)}`);
  if (!loadDir) return null;
  const manifest = await readJsonFile(loadDir, "Archive Manifest.json");
  if (!manifest) return null;

  const matches =
    manifest.exported_at &&
    manifest.source_table === item.source &&
    Number(manifest.source_id) === Number(item.record.id) &&
    String(manifest.shift_date) === String(item.record.shift_date);
  if (!matches || !(await archivedDocumentsPresent(loadDir, manifest))) return null;

  return {
    dayDir,
    groupKey: `${item.customer}|${item.location}|${item.record.shift_date}`,
    summary: summaryRow(item, previewPackageFor(item)),
    manifest,
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

async function writeRouteImage(docsDir, objectPath) {
  return exportRouteDocuments(docsDir, objectPath, {
    bucket: ROUTE_IMAGE_BUCKET, download: downloadStorageObject, write: writeBlob, safeName,
  });
}

async function archiveInternal(rootArchiveDir, item, cutoff) {
  const shift = item.record;
  const pkg = await loadInternalPackage(shift);
  const dayDir = await archiveDateDir(rootArchiveDir, item);
  const loadDir = await getOrCreateDir(dayDir, `Load ${loadNumberFor(item)} - ${driverNameFor(item)}`);
  const docsDir = await getOrCreateDir(loadDir, "Documents");
  await writeFile(loadDir, "Archive Manifest.json", JSON.stringify({ archive_format_version: ARCHIVE_FORMAT_VERSION, status: "incomplete" }));

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

  const documentResults = await writeRouteImage(docsDir, [shift.route_image_path, ...pkg.trips.map((t) => t.route_image_path)]);
  for (const attachment of pkg.attachments) {
    if (!attachment.file_path) continue;
    const blob = await downloadStorageObject(TRIP_SHEET_BUCKET, attachment.file_path);
    const name = safeName(`Attachment ${attachment.id} - ${attachment.file_name || attachment.file_path.split("/").pop()}`);
    await writeBlob(docsDir, name, blob);
    documentResults.push({ bucket: TRIP_SHEET_BUCKET, path: attachment.file_path, file: name, size: blob.size });
  }

  const manifest = {
    archive_format_version: ARCHIVE_FORMAT_VERSION,
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
  await writeFile(loadDir, "Archive Manifest.json", JSON.stringify({ archive_format_version: ARCHIVE_FORMAT_VERSION, status: "incomplete" }));

  const loadDetails = { ...row, driver_name_archive: driverNameFor(item) };
  await writeFile(loadDir, "Load Details.json", JSON.stringify(loadDetails, null, 2) + "\n");
  await writeFile(loadDir, "Load Details.csv", toCsv(fieldValueRows(loadDetails), ["Field", "Value"]));
  await writeFile(loadDir, "Accounting.csv", toCsv(pkg.accounting));
  await writeFile(loadDir, "Accounting Routes.csv", toCsv(pkg.accountingRoutes));

  const documents = await writeRouteImage(docsDir, row.route_image_path);
  const manifest = {
    archive_format_version: ARCHIVE_FORMAT_VERSION,
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
  await writeFile(loadDir, "Archive Manifest.json", JSON.stringify({ archive_format_version: ARCHIVE_FORMAT_VERSION, status: "incomplete" }));

  const loadDetails = { ...row, driver_name_archive: driverNameFor(item) };
  await writeFile(loadDir, "Load Details.json", JSON.stringify(loadDetails, null, 2) + "\n");
  await writeFile(loadDir, "Load Details.csv", toCsv(fieldValueRows(loadDetails), ["Field", "Value"]));

  const documents = await writeRouteImage(docsDir, row.route_image_path);
  const manifest = {
    archive_format_version: ARCHIVE_FORMAT_VERSION,
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
  const cutoff = cutoffInput.value;
  if (!currentCounts || currentCounts.cutoff !== cutoff || !currentCounts.loads) return;
  if (!("showDirectoryPicker" in window)) {
    statusEl.textContent = "This browser does not support folder export. Use current Chrome or Edge on desktop.";
    return;
  }

  exportBtn.disabled = true;
  previewBtn.disabled = true;

  // The counts came from the server; the rows themselves are pulled now, once,
  // for the export that is actually about to run.
  if (!currentPreview || currentPreview.cutoff !== cutoff) {
    statusEl.textContent =
      `Loading the ${currentCounts.loads.toLocaleString()} load records to export\u2026 this part takes a minute.`;
    try {
      await loadFullRecords(cutoff);
    } catch (error) {
      console.error(error);
      statusEl.textContent = `Could not load the records to export: ${error.message || error}`;
      previewBtn.disabled = false;
      exportBtn.disabled = false;
      return;
    }
  }
  if (!currentPreview?.items?.length) {
    statusEl.textContent = "Nothing to export for that date.";
    previewBtn.disabled = false;
    return;
  }

  progressEl.classList.remove("hidden");
  progressEl.value = 0;

  // Progress state lives out here, not inside the try. A catch block can't
  // read variables scoped to the try it's attached to, which is the whole
  // reason a failed export used to report nothing but the error text --
  // every counter describing how far it got died with the scope. On a run
  // that takes hours, "it stopped" without "where" is the difference
  // between resuming and starting over.
  const total = currentPreview.items.length;
  const locationCounts = {};
  let archiveDir = null;
  let selectedLabel = "selected folder";
  let exportedCount = 0;
  let skippedCount = 0;
  let position = 0;      // 1-based index of the load being worked on
  let lastDone = null;   // last load actually finished
  let stoppedOn = null;  // load in hand when it failed

  try {
    statusEl.textContent = "Choose the local Windows folder that should contain the Archive folder…";
    const chosenRoot = await window.showDirectoryPicker({ mode: "readwrite" });
    archiveDir = await getOrCreateDir(chosenRoot, "Archive");
    const markerName = await verifyLocalWrite(chosenRoot, archiveDir);
    selectedLabel = chosenRoot.name || "selected folder";
    statusEl.textContent = `Local write verified: ${selectedLabel}\\Archive\\${markerName}. Starting all-location archive export…`;

    const summariesByDay = new Map();

    for (let i = 0; i < total; i++) {
      const item = currentPreview.items[i];
      const loc = locationLabel(item);
      position = i + 1;
      stoppedOn = `${item.record.shift_date} — ${loadNumberFor(item)} (${item.customer} / ${loc})`;
      const existing = await findCompletedArchive(archiveDir, item);
      let result;

      if (existing) {
        skippedCount += 1;
        result = existing;
        statusEl.textContent = `Resume check: ${selectedLabel}\\Archive\\${item.customer}\\${loc} — skipped completed load ${i + 1} of ${total}: ${item.record.shift_date} — ${loadNumberFor(item)} (${skippedCount.toLocaleString()} skipped)`;
      } else {
        statusEl.textContent = `Writing to ${selectedLabel}\\Archive\\${item.customer}\\${loc} — exporting ${i + 1} of ${total}: ${item.record.shift_date} — ${loadNumberFor(item)}`;
        result = await archiveOne(archiveDir, item, currentPreview.cutoff);
        exportedCount += 1;
      }

      if (!summariesByDay.has(result.groupKey)) summariesByDay.set(result.groupKey, { dir: result.dayDir, rows: [] });
      summariesByDay.get(result.groupKey).rows.push(result.summary);
      const countKey = `${item.customer} / ${loc}`;
      locationCounts[countKey] = (locationCounts[countKey] || 0) + 1;
      progressEl.value = Math.round(((i + 1) / total) * 100);
      lastDone = stoppedOn; // this one is on disk now, so it's the high-water mark
      stoppedOn = null;
    }

    for (const { dir, rows } of summariesByDay.values()) {
      await writeFile(dir, "Daily Summary.csv", toCsv(rows, [
        "Date", "Customer", "Location", "Load #", "Driver", "Routes", "Miles", "Stops", "Revenue", "Cost", "Margin",
      ]));
    }

    await writeFile(archiveDir, "Last Archive Run.json", JSON.stringify({
      completed_at: new Date().toISOString(),
      cutoff: currentPreview.cutoff,
      loads_completed_total: total,
      loads_exported: exportedCount,
      loads_skipped_existing: skippedCount,
      loads_by_location: locationCounts,
      selected_folder_name: selectedLabel,
      local_write_verified: true,
      resume_enabled: true,
      folder_layout: "Archive/Customer/Location/YYYY-MM-DD/Load...",
      supabase_deleted: false,
    }, null, 2) + "\n");

    statusEl.textContent = `Export complete: ${total.toLocaleString()} loads confirmed in the local archive — ${exportedCount.toLocaleString()} written this run, ${skippedCount.toLocaleString()} already complete and skipped. In File Explorer, open ${selectedLabel}\\Archive. Next: open OneDrive in your browser and upload this Archive folder. Wait for the upload to finish and verify the uploaded files before confirming any purge. Nothing was deleted from Supabase.`;
  } catch (error) {
    if (error?.name === "AbortError") {
      statusEl.textContent = `Export cancelled after ${(exportedCount + skippedCount).toLocaleString()} of ${total.toLocaleString()} loads. Nothing was changed in Supabase. Re-running picks up where this left off.`;
    } else {
      console.error("Archive export failed:", error);
      const done = exportedCount + skippedCount;
      const where = position
        ? `at load ${position.toLocaleString()} of ${total.toLocaleString()}`
        : "before the first load";
      const onLoad = stoppedOn
        ? ` It failed on ${stoppedOn}.`
        : (lastDone ? ` The last load written was ${lastDone}.` : "");
      const byLocation = Object.entries(locationCounts)
        .map(([k, n]) => `${k}: ${n.toLocaleString()}`)
        .join(", ");

      statusEl.textContent =
        `Local export stopped ${where} — ${error.message || error}.` +
        onLoad +
        ` ${done.toLocaleString()} load(s) are safely on disk (${exportedCount.toLocaleString()} written this run, ` +
        `${skippedCount.toLocaleString()} already complete and skipped)` +
        (byLocation ? ` — ${byLocation}.` : ".") +
        ` No Supabase records were deleted, and everything already written is safe to keep.` +
        ` Re-run the export and point it at the same folder: completed loads are detected and skipped, so it resumes from here rather than starting over.`;

      // Leave the same detail on disk. The status line is one browser
      // refresh away from being gone, and the whole complaint about this
      // alert was not knowing afterwards how far the run actually got.
      if (archiveDir) {
        try {
          await writeFile(archiveDir, "Last Archive Run (interrupted).json", JSON.stringify({
            stopped_at: new Date().toISOString(),
            error: String(error.message || error),
            cutoff: currentPreview?.cutoff ?? null,
            stopped_at_position: position,
            loads_total: total,
            loads_confirmed_on_disk: done,
            loads_exported_this_run: exportedCount,
            loads_skipped_existing: skippedCount,
            failed_on_load: stoppedOn,
            last_load_written: lastDone,
            loads_by_location: locationCounts,
            selected_folder_name: selectedLabel,
            supabase_deleted: false,
            resume_enabled: true,
          }, null, 2) + "\n");
        } catch (writeError) {
          // Best effort only -- if the folder handle is what broke, this
          // will fail too, and that must not replace the real error.
          console.error("Could not write interrupted-run report:", writeError);
        }
      }
    }
  } finally {
    progressEl.classList.add("hidden");
    previewBtn.disabled = false;
    exportBtn.disabled = !(currentCounts?.loads);
  }
}

async function init() {
  const role = await getCurrentRole();
  if (role !== "admin" && role !== "it") {
    window.location.href = role ? "index.html" : "login.html";
    return;
  }

  cutoffInput.value = sixMonthsAgoIso();
  const recount = () => refreshCounts(cutoffInput.value).catch((e) => {
    console.error(e);
    statusEl.textContent = `Could not count the archive: ${e.message || e}`;
  });
  previewBtn.addEventListener("click", recount);
  cutoffInput.addEventListener("change", recount);
  exportBtn.addEventListener("click", runExport);

  await recount();
}

init().catch((error) => {
  console.error("Archive page initialization failed:", error);
  statusEl.textContent = `Archive page could not start: ${error.message || error}`;
});
