/*
 * End-to-end test for the Archive page's local folder export.
 *
 * This is the path that works without any Microsoft account: the browser
 * counts what is eligible, then writes the records AND the images into a
 * folder the user picks. Two things it pins:
 *
 *  1. Counting is one RPC, not a download. The old preview pulled every
 *     eligible load with select *, then every trip, attachment and accounting
 *     row in 150-id chunks -- roughly 330 sequential requests before four
 *     numbers appeared, which is why the page looked dead and the six-month
 *     cutoff felt like it did nothing. Counting must now be a single
 *     archive_eligible_counts() call, and changing the date must re-count.
 *  2. The export still writes everything. Full records are fetched only when
 *     Export is actually pressed, and the folder tree, CSVs, manifests and
 *     downloaded image blobs must all land.
 *
 * Supabase is stubbed at the client boundary -- window.supabase.createClient --
 * so the real archive-page.js runs unmodified against known rows. The RPC's own
 * arithmetic was verified separately against the live database (see
 * supabase/migrations/20260921_archive_eligible_counts.sql).
 *
 * showDirectoryPicker is stubbed with an in-memory File System Access
 * implementation, so the test asserts on the actual tree the export produced.
 *
 * Run: npm i --no-save playwright && node scripts/archive-local-export.test.mjs
 *
 * Not wired into ci.yml: it needs playwright, which is deliberately not a
 * dependency of the site.
 */

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

const EXECUTABLE = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const read = (n) => readFileSync(new URL('../' + n, import.meta.url), 'utf8');

let failures = 0;
function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}` + (ok ? '' : `\n       expected: ${expected}\n       actual:   ${actual}`));
}

// The page body, lifted from the real archive.html so the markup under test is
// the shipped markup.
const HTML = read('archive.html');
const bodyStart = HTML.indexOf('<body');
const bodyInner = HTML.slice(HTML.indexOf('>', bodyStart) + 1, HTML.indexOf('</body>'))
  .replace(/<script[\s\S]*?<\/script>/g, '');
const MODULE = read('archive-page.js');

const browser = await chromium.launch({ executablePath: EXECUTABLE });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
page.on('pageerror', (e) => { failures++; console.log('  FAIL page error:', String(e).slice(0, 300)); });
page.on('console', (m) => { if (m.type() === 'error') console.log('  [console.error]', m.text().slice(0, 200)); });

// archive-page.js imports its own siblings now, so the page has to be served
// rather than injected: a module given to setContent/addScriptTag has no base
// URL, and "./archive-documents.js" cannot resolve from one.
const repoRoot = new URL('../', import.meta.url).pathname;
const server = createServer((req, res) => {
  const rel = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  if (rel === '/' || rel === '/index') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><html><head><meta charset="utf-8"></head><body>${bodyInner}</body></html>`);
    return;
  }
  try {
    const body = readFileSync(join(repoRoot, rel));
    const type = extname(rel) === '.js' ? 'text/javascript' : 'text/plain';
    res.writeHead(200, { 'Content-Type': type });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
await page.goto(origin + '/');

// ---- stubs: Supabase client + folder picker ----
await page.evaluate(() => {
  window.__calls = { rpc: [], select: [], downloads: [] };

  const CUTOFF_ROWS = {
    loads_shifts: [{
      id: 41, location: 'atlanta', shift_date: '2025-02-03',
      aljex_load_number: '884512', driver_name_text: 'Marcus Whitfield',
      route_image_path: 'atlanta/41/route.png',
    }],
    loads_houston: [],
    mondelez_loads: [],
    loads_trips: [{ id: 900, shift_id: 41, trip_number: 1, route_id: 'ATL-1', trip_id: 'T-900',
                    route_miles: 140.5, stop_count: 3, route_image_path: 'atlanta/41/trip.png' }],
    trip_stops: [{ id: 5000, trip_id: 900, stop_number: 1 }],
    load_notes: [], load_change_history: [],
    load_attachments: [{ id: 77, shift_id: 41, file_name: 'trip sheet.jpg', file_path: 'atlanta/41/sheet.jpg',
                         uploaded_at: '2025-02-03T10:00:00Z' }],
    loads_accounting: [{ id: 301, source_shift_id: 41, source_houston_id: null, total_cost: 400, total_revenue: 700 }],
    loads_accounting_routes: [{ id: 700, accounting_id: 301 }],
    user_roles: [{ user_id: 'u-1', role: 'admin' }],
  };

  // A chainable, thenable PostgREST-ish query builder over the rows above.
  function builder(table) {
    let rows = (CUTOFF_ROWS[table] || []).slice();
    let ranged = false;
    const api = {
      select(sel) { window.__calls.select.push(`${table}:${String(sel).slice(0, 40)}`); return api; },
      eq(col, val) { rows = rows.filter((r) => String(r[col]) === String(val)); return api; },
      in(col, vals) { const s = new Set(vals.map(String)); rows = rows.filter((r) => s.has(String(r[col]))); return api; },
      lt() { return api; },
      order() { return api; },
      limit(n) { rows = rows.slice(0, n); return api; },
      range(from) { ranged = true; if (from > 0) rows = []; return api; },
      then(resolve) { return Promise.resolve({ data: rows, error: null, count: rows.length }).then(resolve); },
    };
    void ranged;
    return api;
  }

  const blobFor = (path) => new Blob([`fake-bytes-for:${path}`], { type: 'image/png' });

  window.supabase = {
    createClient() {
      return {
        auth: { getSession: async () => ({ data: { session: { user: { id: 'u-1' }, access_token: 't' } }, error: null }) },
        from: (table) => builder(table),
        rpc: async (name, args) => {
          window.__calls.rpc.push({ name, args });
          const cutoff = String(args.p_cutoff);
          // Two different answers so a re-count is observable.
          const wide = cutoff >= '2026-01-01';
          return {
            data: [wide
              ? { kroger_loads: 11792, houston_loads: 9398, mondelez_loads: 610,
                  routes: 32541, attachments: 0, accounting_rows: 11678 }
              : { kroger_loads: 1, houston_loads: 0, mondelez_loads: 0,
                  routes: 1, attachments: 1, accounting_rows: 1 }],
            error: null,
          };
        },
        storage: {
          from: (bucket) => ({
            download: async (path) => {
              window.__calls.downloads.push(`${bucket}/${path}`);
              return { data: blobFor(`${bucket}/${path}`), error: null };
            },
          }),
        },
      };
    },
  };

  // ---- in-memory File System Access ----
  function makeDir(name) {
    const dirs = new Map(), files = new Map();
    return {
      name, kind: 'directory', __dirs: dirs, __files: files,
      async getDirectoryHandle(n, opts = {}) {
        if (!dirs.has(n)) {
          if (!opts.create) { const e = new Error('nope'); e.name = 'NotFoundError'; throw e; }
          dirs.set(n, makeDir(n));
        }
        return dirs.get(n);
      },
      async getFileHandle(n, opts = {}) {
        if (!files.has(n)) {
          if (!opts.create) { const e = new Error('nope'); e.name = 'NotFoundError'; throw e; }
          files.set(n, { name: n, kind: 'file', __data: '' });
        }
        const entry = files.get(n);
        return {
          name: n, kind: 'file',
          async createWritable() {
            let buf = '';
            return {
              async write(chunk) { buf += (chunk instanceof Blob) ? await chunk.text() : String(chunk); },
              async close() { entry.__data = buf; },
            };
          },
          async getFile() { return new Blob([entry.__data]); },
        };
      },
      async requestPermission() { return 'granted'; },
    };
  }
  window.__root = makeDir('Dispatch Archive');
  window.showDirectoryPicker = async () => window.__root;

  window.__tree = () => {
    const walk = (dir, prefix) => {
      const out = [];
      for (const f of dir.__files.keys()) out.push(prefix + f);
      for (const [n, d] of dir.__dirs) out.push(...walk(d, prefix + n + '/'));
      return out.sort();
    };
    return walk(window.__root, '');
  };
  window.__fileText = (path) => {
    const parts = path.split('/'); const name = parts.pop();
    let dir = window.__root;
    for (const p of parts) dir = dir.__dirs.get(p);
    return dir?.__files.get(name)?.__data ?? null;
  };
});

// ---- run the real module ----
await page.addScriptTag({ url: origin + '/archive-page.js', type: 'module' });
await page.waitForFunction(() => document.querySelector('#archive-loads').textContent !== '—', null, { timeout: 15000 });

// ---- 1. counting is one RPC, and it fills the page ----
console.log('1. counting is a single server-side call');
const afterLoad = await page.evaluate(() => ({
  rpcCalls: window.__calls.rpc.length,
  rpcName: window.__calls.rpc[0]?.name,
  cutoff: document.querySelector('#archive-cutoff').value,
  loads: document.querySelector('#archive-loads').textContent,
  routes: document.querySelector('#archive-routes').textContent,
  attachments: document.querySelector('#archive-attachments').textContent,
  accounting: document.querySelector('#archive-accounting').textContent,
  status: document.querySelector('#archive-status').textContent,
  exportDisabled: document.querySelector('#archive-export').disabled,
  // the old path downloaded rows to count them; nothing but user_roles should
  // have been selected before Export is pressed
  selectedTables: [...new Set(window.__calls.select.map((s) => s.split(':')[0]))].sort().join(','),
}));
check('one rpc call on load', afterLoad.rpcCalls, 1);
check('it is archive_eligible_counts', afterLoad.rpcName, 'archive_eligible_counts');
check('the cutoff defaulted', /^\d{4}-\d{2}-\d{2}$/.test(afterLoad.cutoff), true);
check('loads counter = 11792+9398+610', afterLoad.loads, '21,800');
check('routes counter', afterLoad.routes, '32,541');
check('attachments counter', afterLoad.attachments, '0');
check('accounting counter', afterLoad.accounting, '11,678');
check('export is enabled', afterLoad.exportDisabled, false);
check('no load rows were downloaded to count', afterLoad.selectedTables, 'user_roles');
check('status names the cutoff and says nothing is deleted',
  /21,800 loads dated before .+Nothing is deleted from Supabase\.$/.test(afterLoad.status), true);

// ---- 2. changing the date re-counts ----
console.log('\n2. changing the date re-counts');
await page.evaluate(() => {
  const el = document.querySelector('#archive-cutoff');
  el.value = '2020-01-01';
  el.dispatchEvent(new Event('change'));
});
await page.waitForFunction(() => window.__calls.rpc.length === 2, null, { timeout: 10000 });
await page.waitForFunction(() => document.querySelector('#archive-loads').textContent === '1', null, { timeout: 10000 });
const afterChange = await page.evaluate(() => ({
  rpcCalls: window.__calls.rpc.length,
  sentCutoff: window.__calls.rpc[1]?.args?.p_cutoff,
  loads: document.querySelector('#archive-loads').textContent,
}));
check('a second rpc call went out', afterChange.rpcCalls, 2);
check('it used the new date', afterChange.sentCutoff, '2020-01-01');
check('counters followed the new date', afterChange.loads, '1');

// ---- 3. export writes records and images into the chosen folder ----
console.log('\n3. export writes the tree, including images');
await page.evaluate(() => document.querySelector('#archive-export').click());
// Wait for the LAST thing the export writes, not the first. A load's manifest
// appears well before the run is over, and waiting on it read the tree while
// the day's summary was still being written -- the assertions below then
// failed about one run in five.
await page.waitForFunction(
  () => {
    const tree = window.__tree();
    if (!tree.some((p) => p.endsWith('Daily Summary.csv'))) return false;
    const manifest = tree.find((p) => p.endsWith('Archive Manifest.json'));
    return !!manifest && /"supabase_deleted"/.test(window.__fileText(manifest) || '');
  },
  null, { timeout: 20000 });
const out = await page.evaluate(() => ({
  tree: window.__tree(),
  downloads: window.__calls.downloads,
  manifest: window.__fileText('Archive/Kroger/Atlanta/2025-02-03/Load 884512 - Marcus Whitfield/Archive Manifest.json'),
  // Exported documents are numbered now, so route.png lands as
  // "Route Image 0001 - route.png". Find it by the source filename rather than
  // pinning the counter, which is presentation and may well change again.
  routeImage: (() => {
    const dir = 'Archive/Kroger/Atlanta/2025-02-03/Load 884512 - Marcus Whitfield/Documents/';
    const hit = window.__tree().find((p) => p.startsWith(dir) && p.endsWith('route.png'));
    return hit ? window.__fileText(hit) : null;
  })(),
  status: document.querySelector('#archive-status').textContent,
}));
const has = (p) => out.tree.includes(p);
const LOAD = 'Archive/Kroger/Atlanta/2025-02-03/Load 884512 - Marcus Whitfield';
check('local-write marker written', has('Archive/Archive Export Info.txt'), true);
check('load details json', has(`${LOAD}/Load Details.json`), true);
check('routes csv', has(`${LOAD}/Routes.csv`), true);
check('accounting csv', has(`${LOAD}/Accounting.csv`), true);
check('manifest', has(`${LOAD}/Archive Manifest.json`), true);
check('daily summary', has('Archive/Kroger/Atlanta/2025-02-03/Daily Summary.csv'), true);
check('shift route image downloaded', out.downloads.includes('mondelez-routes/atlanta/41/route.png'), true);
check('trip route image downloaded', out.downloads.includes('mondelez-routes/atlanta/41/trip.png'), true);
check('trip sheet downloaded from its own bucket', out.downloads.includes('trip-sheets/atlanta/41/sheet.jpg'), true);
check('the image bytes actually landed on disk', out.routeImage, 'fake-bytes-for:mondelez-routes/atlanta/41/route.png');
check('manifest records nothing was deleted', /"supabase_deleted": false/.test(out.manifest || ''), true);

// ---- 4. the export fetches in bulk, not per load ----
console.log('\n4. every table is read once, not once per load');
// It used to run six queries for each Kroger load and two for each Houston
// load, on top of the preview. Across ~14,700 eligible loads that is roughly
// 90,000 sequential requests -- about two hours of network latency before the
// disk is touched, which is the only reason a run was ever left unattended
// long enough for the idle pause to kill it. All of it is 38 MB; fetched up
// front it is a few hundred paged requests.
const reads = await page.evaluate(() => {
  const counts = {};
  for (const entry of window.__calls.select) {
    const table = entry.split(':')[0];
    counts[table] = (counts[table] || 0) + 1;
  }
  return counts;
});
check('routes read once for the whole run', reads.loads_trips, 1);
check('stops read once', reads.trip_stops, 1);
check('accounting read once', reads.loads_accounting, 1);
check('accounting routes read once', reads.loads_accounting_routes, 1);
check('change history read once', reads.load_change_history, 1);
check('attachments read once', reads.load_attachments, 1);

// Reading in bulk is only worth anything if the rows still reach the right
// load. These are assembled in memory now rather than queried per load.
const csv = await page.evaluate((dir) => ({
  routes: window.__fileText(dir + '/Routes.csv'),
  stops: window.__fileText(dir + '/Stops.csv'),
  acctRoutes: window.__fileText(dir + '/Accounting Routes.csv'),
  attachments: window.__fileText(dir + '/Attachments.csv'),
}), LOAD);
check("the load's route is in its Routes.csv", /(^|,)T-900(,|$)/m.test(csv.routes), true);
check("its stop is in Stops.csv", /(^|,)5000(,|$)/m.test(csv.stops), true);
check("its accounting route is in Accounting Routes.csv", /(^|,)700(,|$)/m.test(csv.acctRoutes), true);
check("its attachment is listed", /trip sheet\.jpg/.test(csv.attachments), true);

await browser.close();
server.close();
console.log(failures ? `\n  ${failures} check(s) FAILED\n` : '\n  All checks passed.\n');
process.exit(failures ? 1 : 0);
