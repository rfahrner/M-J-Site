/*
 * Regression test: Released works on every board, not just the three that
 * have a `loads_shifts` row.
 *
 * `releaseToAljex()` opened with `if (!acct.source_shift_id) throw`. Atlanta,
 * Delaware and Building C satisfy that; Houston and Mondelez never can --
 * their loads live in `loads_houston` and `mondelez_loads` and their
 * accounting rows link through `source_houston_id` / `source_mondelez_id`.
 * So every Mondelez release threw, the catch unchecked the box, and the
 * reason went to a status line above a table the operator had scrolled a
 * few hundred rows past. Reported as "I click it but it will not check".
 * 1,394 Mondelez and 185 Houston accounting rows, zero releases between them.
 *
 * A release is `authority: "accounting"` by definition -- under that
 * authority the shift's figures are overwritten by the accounting row's
 * anyway -- so a shift-less load assembles from the accounting row and its
 * `loads_accounting_routes`, and only TONU / called off / shift complete
 * are read off the board row.
 *
 * Run: node --test scripts/release-without-a-board-shift.test.mjs
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { createClient } from '@supabase/supabase-js';
// package.json declares no "type", so a .js file is CommonJS to node and a
// plain relative import of it fails on the named exports. Every test in this
// repo loads a site module the same way.
const {
  buildAccountingOnlyPayload,
  accountingRoutesAsTrips,
  buildRefList,
  isSendable,
  payloadHash,
} = await import(
  `data:text/javascript;base64,${Buffer.from(fs.readFileSync('aljex-payload.js', 'utf8')).toString('base64')}`
);

const MONDELEZ_ACCT = {
  id: 9001,
  source_shift_id: null,
  source_houston_id: null,
  source_mondelez_id: 551,
  location: 'mondelez',
  shift_date: '2026-10-02',
  aljex_load_number: 'MDZ-77421',
  driver_name_text: 'Samuel Godinez',
  mc_dot: 'MC-884120',
  driver_cell: '7705551234',
  carrier_email: 'sam@example.com',
  contract_rate: 1425.5,
  total_carrier_pay: 980,
  fsc_rate_snapshot: 0.31,
  fsc_payment: 62.4,
  total_cost: 1042.4,
  total_revenue: 1425.5,
  total_miles: 212.3,
  total_stops: 6,
  status: 'active',
  sent: false,
};

const MONDELEZ_BOARD = { id: 551, tonu: true, shift_complete: true, driver_name: 'Samuel Godinez' };

/* ------------------------------------------------------------------ */
test('a Mondelez accounting row assembles a sendable release payload', () => {
  const payload = buildAccountingOnlyPayload({
    accounting: MONDELEZ_ACCT,
    board: MONDELEZ_BOARD,
    routes: [],
    boardTable: 'mondelez_loads',
  });

  assert.equal(payload.authority, 'accounting');
  assert.equal(payload.orderNo, 'MDZ-77421');
  assert.equal(payload.location, 'mondelez');
  assert.equal(payload.shiftDate, '2026-10-02');

  // Mondelez carries no route rows at all -- every one of its 1,394
  // accounting records has zero. Empty refs is the honest answer, and
  // the payload is still sendable because it has an order number and
  // real money on it. If isSendable ever starts demanding refs, Mondelez
  // silently stops releasing again.
  assert.deepEqual(payload.refs, []);
  assert.equal(isSendable(payload), true);

  // Accounting IS the authority, so its figures land in the rate slots
  // the shift would otherwise have filled -- the same collapse
  // buildOrderPayload performs for authority "accounting".
  assert.equal(payload.rates.customerRate, 1425.5);
  assert.equal(payload.rates.carrierRate, 980);
  assert.equal(payload.rates.totalRevenue, 1425.5);

  assert.equal(payload.driver.name, 'Samuel Godinez');
  assert.equal(payload.totals.stops, 6);

  // The board row contributes only what is not billed.
  assert.equal(payload.flags.tonu, true);
  assert.equal(payload.flags.shiftComplete, true);
  assert.equal(payload.flags.released, false);

  assert.equal(payload.source.shiftId, null);
  assert.equal(payload.source.boardTable, 'mondelez_loads');
  assert.equal(payload.source.boardId, 551);
});

test('a missing board row degrades the flags, it does not fail the release', () => {
  const payload = buildAccountingOnlyPayload({ accounting: MONDELEZ_ACCT, board: null, routes: [] });
  assert.equal(isSendable(payload), true);
  assert.deepEqual(payload.flags, { tonu: false, calledOff: false, shiftComplete: false, released: false });
  assert.equal(payload.source.boardTable, null);
});

test('no Aljex number is still refused -- nothing can be matched in Aljex', () => {
  const payload = buildAccountingOnlyPayload({
    accounting: { ...MONDELEZ_ACCT, aljex_load_number: '  ' },
    routes: [],
  });
  assert.equal(payload.orderNo, null);
  assert.equal(isSendable(payload), false);
});

test('accounting routes go through the SAME ref list as loads_trips', () => {
  const routes = [
    { route_number: 2, route_id: 'Nestle', trip_id: 'T-2', trailer: '53-889' },
    { route_number: 1, route_id: 'FRGT', trip_id: 'T-1', trailer: '53-104' },
    { route_number: 3, route_id: 'FRGT', trip_id: 'T-3', trailer: '53-222' },
    { route_number: 4, route_id: '', trip_id: 'T-4', trailer: null },
  ];
  const refs = buildRefList(accountingRoutesAsTrips(routes));

  // Sorted by number, de-duplicated by route id, blanks dropped -- one rule,
  // not a second copy that drifts from loads_trips'.
  assert.deepEqual(refs.map((r) => r.value), ['FRGT', 'Nestle']);
  assert.deepEqual(refs.map((r) => r.slot), [1, 2]);
  assert.equal(refs[0].tripNumber, 1);
  assert.equal(refs[0].trailer, '53-104');
});

test('the hash ignores key order, so an unchanged load is not re-sent', () => {
  const a = buildAccountingOnlyPayload({ accounting: MONDELEZ_ACCT, board: MONDELEZ_BOARD, routes: [] });
  const b = buildAccountingOnlyPayload({ accounting: { ...MONDELEZ_ACCT }, board: { ...MONDELEZ_BOARD }, routes: [] });
  assert.equal(payloadHash(a), payloadHash(b));
  const c = buildAccountingOnlyPayload({
    accounting: { ...MONDELEZ_ACCT, total_carrier_pay: 981 }, board: MONDELEZ_BOARD, routes: [],
  });
  assert.notEqual(payloadHash(a), payloadHash(c));
});

/* ------------------------------------------------------------------
   Drive the real releaseToAljex against a fake PostgREST.
   ------------------------------------------------------------------ */

function liftOutbox({ acct, mode = 'dry-run' }) {
  const src = fs.readFileSync('aljex-outbox.js', 'utf8')
    .replace(/^import[\s\S]*?from\s+'[^']+';$/gm, '')
    .replace(/^import\s+'[^']+';$/gm, '')
    .replace(/^export\s+/gm, '');

  const tables = {
    loads_accounting: [{ ...acct }],
    loads_accounting_routes: [],
    mondelez_loads: [{ ...MONDELEZ_BOARD }],
    aljex_outbox: [],
  };
  const inserted = [];
  const saved = [];

  const client = createClient('https://example.supabase.co', 'test-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      fetch: async (url, options = {}) => {
        const u = new URL(url);
        const table = u.pathname.split('/').pop();
        const method = options.method || 'GET';
        const json = (body, status = 200) =>
          new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

        if (method === 'POST') {
          const body = JSON.parse(options.body);
          const rows = Array.isArray(body) ? body : [body];
          rows.forEach((r) => { inserted.push({ table, ...r }); tables[table]?.push({ id: inserted.length, ...r }); });
          return json(rows.map((r, i) => ({ id: inserted.length - rows.length + i + 1, ...r })));
        }
        if (method === 'PATCH') {
          const patch = JSON.parse(options.body);
          (tables[table] || []).forEach((r) => Object.assign(r, patch));
          return json(tables[table] || []);
        }
        // Reads: the fake is deliberately dumb about filters. Every query in
        // this path selects one table by one id, and the rows below are
        // unique per table, so returning the table is the right answer.
        return json(tables[table] || []);
      },
    },
  });

  const context = vm.createContext({
    supabaseClient: client,
    currentUserName: () => 'Test Operator',
    buildOrderPayload: () => { throw new Error('the shift path must not run for a shift-less load'); },
    buildAccountingOnlyPayload,
    payloadHash,
    isSendable,
    describePayload: () => '',
    resolveAljexOrderNo: (row) => String(row?.aljex_load_number ?? '').trim() || null,
    createAljexClient: () => ({ mode, isDryRun: mode === 'dry-run', sendOrderUpdate: async () => ({ ok: true, detail: 'dry run' }) }),
    getAljexMode: () => mode,
    saveAccountingFields: async (_c, id, fields) => { saved.push({ id, fields }); return { id, ...fields }; },
    console,
    Response,
    URL,
    Date,
    Promise,
    Error,
    JSON,
    Set,
    Map,
    Array,
    String,
    Number,
    Object,
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(src, context);
  return { context, inserted, saved, tables };
}

test('releasing a Mondelez load queues, drains and records the release', async () => {
  const { context, inserted, saved } = liftOutbox({ acct: MONDELEZ_ACCT });
  const releaseToAljex = vm.runInContext('releaseToAljex', context);

  const result = await releaseToAljex(9001);

  const queued = inserted.filter((r) => r.table === 'aljex_outbox');
  assert.equal(queued.length, 1, 'exactly one outbox row');
  assert.equal(queued[0].kind, 'release');
  assert.equal(queued[0].source_table, 'loads_accounting');
  assert.equal(queued[0].aljex_order_no, 'MDZ-77421');
  assert.equal(queued[0].accounting_id, 9001);
  // aljex_outbox.shift_id is nullable and MUST stay that way -- a Mondelez
  // load has no shift to point at, and inventing one would make drainOutbox
  // write sync state onto somebody else's shift.
  assert.equal(queued[0].shift_id, null);

  const release = saved.find((s) => s.fields.status === 'released');
  assert.ok(release, 'the accounting row is stamped released');
  assert.equal(release.id, 9001);
  assert.equal(release.fields.sent, true);
  assert.equal(release.fields.aljex_released_by, 'Test Operator');
  assert.ok(release.fields.aljex_released_at);

  assert.equal(result.failed, 0);
  assert.equal(result.payload.orderNo, 'MDZ-77421');
});

test('a shift-less load with no Aljex number refuses before it queues anything', async () => {
  const { context, inserted, saved } = liftOutbox({ acct: { ...MONDELEZ_ACCT, aljex_load_number: null } });
  const releaseToAljex = vm.runInContext('releaseToAljex', context);

  await assert.rejects(releaseToAljex(9001), /Aljex\/PRO number/);
  assert.equal(inserted.filter((r) => r.table === 'aljex_outbox').length, 0);
  assert.equal(saved.length, 0, 'nothing is stamped released');
});

/* ------------------------------------------------------------------ */
test('the guard that caused this is gone, and the two paths are explicit', () => {
  const outbox = fs.readFileSync('aljex-outbox.js', 'utf8');
  assert.equal(
    /if \(!acct\.source_shift_id\) throw/.test(outbox),
    false,
    'a missing source_shift_id must no longer abort the release',
  );
  assert.ok(/acct\.source_shift_id\s*\n?\s*\?\s*await enqueueLoadUpdate/.test(outbox),
    'the shift path is still taken when there IS a shift');
  assert.ok(/enqueueAccountingRelease/.test(outbox));

  // Houston has the identical shape and the identical bug; it is fixed by
  // the same branch, so the link table must stay listed.
  assert.ok(/source_houston_id/.test(outbox));
  assert.ok(/source_mondelez_id/.test(outbox));

  // One write into the outbox, so the supersede rule cannot be true on one
  // path and forgotten on the other.
  assert.equal((outbox.match(/\.from\(OUTBOX_TABLE\)\s*\.insert\(/g) || []).length, 1);
});

test('a refused release says why on the row, not only at the top of the table', () => {
  const acct = fs.readFileSync('accounting.js', 'utf8');
  assert.ok(/accountingReleaseErrors/.test(acct));
  assert.ok(/accountingReleaseErrors\.set\(/.test(acct), 'the catch records the reason');
  assert.ok(/accountingReleaseErrors\.delete\(/.test(acct), 'and a retry clears it');
  assert.ok(/acct-release-error/.test(acct), 'and it renders in the Released cell');
  assert.ok(/\.acct-release-error/.test(fs.readFileSync('loadboard.css', 'utf8')));
});
