#!/usr/bin/env node

/**
 * Archive Atlanta / Building C / Delaware loads older than six months.
 *
 * Default behavior is NON-DESTRUCTIVE: export to a local folder and populate
 * permanent analytics history tables. Nothing is deleted unless --purge is
 * explicitly supplied.
 *
 * Required environment variables:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Examples:
 *   node scripts/archive-old-loads.mjs "C:\\Users\\Ron\\OneDrive - D&L Transport\\M-J Site Backups"
 *   node scripts/archive-old-loads.mjs "C:\\...\\M-J Site Backups" --cutoff=2026-02-21
 *   node scripts/archive-old-loads.mjs "C:\\...\\M-J Site Backups" --purge
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const outputRoot = process.argv[2];
const purge = process.argv.includes('--purge');
const cutoffArg = process.argv.find((a) => a.startsWith('--cutoff='));

if (!SUPABASE_URL || !SERVICE_KEY) {
  throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment.');
}
if (!outputRoot || outputRoot.startsWith('--')) {
  throw new Error('Pass the local synced OneDrive folder as the first argument.');
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const INTERNAL_LOCATIONS = ['atlanta', 'buildingc', 'delaware'];
const ROUTE_IMAGE_BUCKET = 'mondelez-routes';
const TRIP_SHEET_BUCKET = 'trip-sheets';
const PAGE_SIZE = 1000;

function sixMonthsAgoIso() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setMonth(d.getMonth() - 6);
  return d.toISOString().slice(0, 10);
}

const cutoff = cutoffArg ? cutoffArg.split('=')[1] : sixMonthsAgoIso();
if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoff)) throw new Error(`Invalid cutoff date: ${cutoff}`);

function safeName(value, fallback = 'Unknown') {
  const s = String(value ?? '').trim() || fallback;
  return s.replace(/[<>:"/\\|?*\x00-\x1F]/g, '-').replace(/\s+/g, ' ').slice(0, 120);
}

function monthFolder(dateKey) {
  const d = new Date(`${dateKey}T00:00:00`);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const monthName = d.toLocaleString('en-US', { month: 'long' });
  return `${month}-${monthName}`;
}

function csvEscape(value) {
  if (value == null) return '';
  const s = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows, preferredColumns = []) {
  if (!rows.length) return preferredColumns.length ? `${preferredColumns.join(',')}\n` : '';
  const seen = new Set(preferredColumns);
  const columns = [...preferredColumns];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) { seen.add(key); columns.push(key); }
    }
  }
  return [
    columns.map(csvEscape).join(','),
    ...rows.map((r) => columns.map((c) => csvEscape(r[c])).join(',')),
  ].join('\n') + '\n';
}

async function writeJson(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

async function writeCsv(filePath, rows, preferredColumns = []) {
  await fs.writeFile(filePath, toCsv(rows, preferredColumns), 'utf8');
}

async function fetchAll(table, select, apply) {
  let rows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    let q = supabase.from(table).select(select).range(from, from + PAGE_SIZE - 1);
    q = apply ? apply(q) : q;
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    rows = rows.concat(data || []);
    if (!data || data.length < PAGE_SIZE) break;
  }
  return rows;
}

async function downloadObject(bucket, objectPath, destination) {
  if (!objectPath) return false;
  const { data, error } = await supabase.storage.from(bucket).download(objectPath);
  if (error) {
    console.warn(`Could not download ${bucket}/${objectPath}: ${error.message}`);
    return false;
  }
  const bytes = Buffer.from(await data.arrayBuffer());
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, bytes);
  return true;
}

async function removeObjects(bucket, paths) {
  const unique = [...new Set(paths.filter(Boolean))];
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    const { error } = await supabase.storage.from(bucket).remove(chunk);
    if (error) throw new Error(`Failed deleting ${bucket} objects: ${error.message}`);
  }
}

async function getDriverName(shift) {
  if (shift.driver_name_text) return shift.driver_name_text;
  if (!shift.driver_id) return 'Unassigned';
  const { data, error } = await supabase
    .from('atlanta_drivers')
    .select('"Driver Name"')
    .eq('id', shift.driver_id)
    .maybeSingle();
  if (error) throw error;
  return data?.['Driver Name'] || `Driver ${shift.driver_id}`;
}

async function loadPackage(shift) {
  const trips = await fetchAll('loads_trips', '*', (q) => q.eq('shift_id', shift.id).order('trip_number'));
  const tripIds = trips.map((t) => t.id);

  let stops = [];
  if (tripIds.length) {
    for (let i = 0; i < tripIds.length; i += 150) {
      const { data, error } = await supabase.from('trip_stops').select('*').in('trip_id', tripIds.slice(i, i + 150));
      if (error) throw error;
      stops.push(...(data || []));
    }
  }

  const [notes, changes, attachments, accounting] = await Promise.all([
    fetchAll('load_notes', '*', (q) => q.eq('shift_id', shift.id).order('created_at')),
    fetchAll('load_change_history', '*', (q) => q.eq('shift_id', shift.id).order('changed_at')),
    fetchAll('load_attachments', '*', (q) => q.eq('shift_id', shift.id).order('uploaded_at')),
    fetchAll('loads_accounting', '*', (q) => q.eq('source_shift_id', shift.id).order('id')),
  ]);

  let accountingRoutes = [];
  const accountingIds = accounting.map((a) => a.id);
  if (accountingIds.length) {
    const { data, error } = await supabase
      .from('loads_accounting_routes')
      .select('*')
      .in('accounting_id', accountingIds)
      .order('accounting_id')
      .order('route_number');
    if (error) throw error;
    accountingRoutes = data || [];
  }

  return { shift, trips, stops, notes, changes, attachments, accounting, accountingRoutes };
}

async function saveAnalyticsHistory(pkg, driverName) {
  const { shift, trips, accounting } = pkg;
  const loadHistory = {
    original_shift_id: shift.id,
    shift_date: shift.shift_date,
    location: shift.location,
    driver_id: shift.driver_id,
    driver_name_snapshot: driverName,
    tonu: !!shift.tonu,
    called_off: !!shift.called_off,
    called_off_reason: shift.called_off_reason,
    shift_complete: !!shift.shift_complete,
  };
  let { error } = await supabase.from('analytics_load_history').upsert(loadHistory, { onConflict: 'original_shift_id' });
  if (error) throw error;

  if (trips.length) {
    const routeHistory = trips.map((t) => ({
      original_trip_id: t.id,
      original_shift_id: shift.id,
      route_id: t.route_id,
      trip_id: t.trip_id,
      route_miles: t.route_miles,
      stop_count: t.stop_count,
      salvage: t.salvage,
      backhaul: t.backhaul,
    }));
    ({ error } = await supabase.from('analytics_route_history').upsert(routeHistory, { onConflict: 'original_trip_id' }));
    if (error) throw error;
  }

  if (accounting.length) {
    const financialHistory = accounting.map((a) => ({
      original_accounting_id: a.id,
      original_shift_id: shift.id,
      shift_date: a.shift_date,
      location: a.location,
      total_cost: a.total_cost,
      total_revenue: a.total_revenue,
    }));
    ({ error } = await supabase.from('analytics_financial_history').upsert(financialHistory, { onConflict: 'original_accounting_id' }));
    if (error) throw error;
  }
}

async function archiveOne(shift) {
  const pkg = await loadPackage(shift);
  const driverName = await getDriverName(shift);
  const loadLabel = shift.aljex_load_number || shift.pro_number || shift.id;
  const year = shift.shift_date.slice(0, 4);
  const dayDir = path.join(outputRoot, 'Archive', year, monthFolder(shift.shift_date), shift.shift_date);
  const loadDir = path.join(dayDir, `Load ${safeName(loadLabel)} - ${safeName(driverName)}`);
  const docsDir = path.join(loadDir, 'Documents');
  await fs.mkdir(docsDir, { recursive: true });

  await writeJson(path.join(loadDir, 'Load Details.json'), { ...pkg.shift, driver_name_archive: driverName });
  await writeCsv(path.join(loadDir, 'Routes.csv'), pkg.trips);
  await writeCsv(path.join(loadDir, 'Stops.csv'), pkg.stops);
  await writeCsv(path.join(loadDir, 'Notes.csv'), pkg.notes);
  await writeCsv(path.join(loadDir, 'Change History.csv'), pkg.changes);
  await writeCsv(path.join(loadDir, 'Accounting.csv'), pkg.accounting);
  await writeCsv(path.join(loadDir, 'Accounting Routes.csv'), pkg.accountingRoutes);
  await writeCsv(path.join(loadDir, 'Attachments.csv'), pkg.attachments);

  const routeImagePaths = [...new Set([
    pkg.shift.route_image_path,
    ...pkg.trips.map((t) => t.route_image_path),
  ].filter(Boolean))];

  for (const objectPath of routeImagePaths) {
    await downloadObject(ROUTE_IMAGE_BUCKET, objectPath, path.join(docsDir, `Route Image - ${safeName(path.basename(objectPath))}`));
  }
  for (const att of pkg.attachments) {
    await downloadObject(TRIP_SHEET_BUCKET, att.file_path, path.join(docsDir, safeName(att.file_name || path.basename(att.file_path))));
  }

  await saveAnalyticsHistory(pkg, driverName);

  const manifest = {
    archived_at: new Date().toISOString(),
    cutoff,
    purge_requested: purge,
    shift_id: shift.id,
    shift_date: shift.shift_date,
    location: shift.location,
    load_number: loadLabel,
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
    storage: {
      route_images: routeImagePaths,
      trip_sheets: pkg.attachments.map((a) => a.file_path).filter(Boolean),
    },
  };
  await writeJson(path.join(loadDir, 'Archive Manifest.json'), manifest);

  if (purge) {
    await removeObjects(ROUTE_IMAGE_BUCKET, routeImagePaths);
    await removeObjects(TRIP_SHEET_BUCKET, pkg.attachments.map((a) => a.file_path));

    if (pkg.accounting.length) {
      const { error } = await supabase.from('loads_accounting').delete().in('id', pkg.accounting.map((a) => a.id));
      if (error) throw error;
    }
    if (pkg.notes.length) {
      const { error } = await supabase.from('load_notes').delete().eq('shift_id', shift.id);
      if (error) throw error;
    }
    const { error } = await supabase.from('loads_shifts').delete().eq('id', shift.id);
    if (error) throw error;
  }

  return {
    Date: shift.shift_date,
    Location: shift.location,
    'Load #': loadLabel,
    Driver: driverName,
    Routes: pkg.trips.filter((t) => (t.route_id && String(t.route_id).trim()) || (t.trip_id && String(t.trip_id).trim())).length,
    Miles: pkg.trips.reduce((sum, t) => sum + (Number(t.route_miles) || 0), 0),
    Stops: pkg.trips.reduce((sum, t) => sum + (Number(t.stop_count) || 0), 0),
    Revenue: pkg.accounting.reduce((sum, a) => sum + (Number(a.total_revenue) || 0), 0),
    Cost: pkg.accounting.reduce((sum, a) => sum + (Number(a.total_cost) || 0), 0),
    Margin: pkg.accounting.reduce((sum, a) => sum + (Number(a.total_revenue) || 0) - (Number(a.total_cost) || 0), 0),
    Purged: purge ? 'Yes' : 'No',
  };
}

async function main() {
  await fs.mkdir(path.join(outputRoot, 'Archive'), { recursive: true });

  const shifts = await fetchAll(
    'loads_shifts',
    '*',
    (q) => q.in('location', INTERNAL_LOCATIONS).lt('shift_date', cutoff).order('shift_date').order('id')
  );

  console.log(`Cutoff: ${cutoff}`);
  console.log(`Eligible loads: ${shifts.length}`);
  console.log(`Mode: ${purge ? 'ARCHIVE + PURGE' : 'ARCHIVE ONLY'}`);

  const summaryByDay = new Map();
  for (const shift of shifts) {
    console.log(`${purge ? 'Archiving/purging' : 'Archiving'} shift ${shift.id} (${shift.shift_date})...`);
    const summary = await archiveOne(shift);
    if (!summaryByDay.has(shift.shift_date)) summaryByDay.set(shift.shift_date, []);
    summaryByDay.get(shift.shift_date).push(summary);
  }

  for (const [dateKey, rows] of summaryByDay.entries()) {
    const year = dateKey.slice(0, 4);
    const dayDir = path.join(outputRoot, 'Archive', year, monthFolder(dateKey), dateKey);
    await writeCsv(path.join(dayDir, 'Daily Summary.csv'), rows, [
      'Date', 'Location', 'Load #', 'Driver', 'Routes', 'Miles', 'Stops', 'Revenue', 'Cost', 'Margin', 'Purged',
    ]);
  }

  const runManifest = {
    completed_at: new Date().toISOString(),
    cutoff,
    mode: purge ? 'archive-and-purge' : 'archive-only',
    loads_processed: shifts.length,
  };
  await writeJson(path.join(outputRoot, 'Archive', 'Last Archive Run.json'), runManifest);
  console.log(`Done. ${shifts.length} load(s) processed.`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
