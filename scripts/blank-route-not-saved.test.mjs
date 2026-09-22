/*
 * Regression test: an empty route slot never becomes a loads_trips row.
 *
 * A route with no Route ID and no Trip ID has no identity. That matters
 * because every guard against writing a route twice matches on Trip ID --
 * findExistingTripRow() in saveTripNow(), and the Trip ID fallback in
 * handleRealtimeTripChange(). A row with neither is invisible to both, so it
 * is the one shape that can be saved twice, and it is what the phantom routes
 * the realtime merge used to invent turned into.
 *
 * Two rules, asked for directly:
 *   - a blank route is never INSERTed;
 *   - minimizing a blank route throws it away, on the board and in the
 *     database, instead of saving it.
 *
 * A dropped route image counts as content even with both ids blank: the image
 * is stored against the route row, so discarding the row loses the upload.
 *
 * Run: node scripts/blank-route-not-saved.test.mjs
 */

import { readFileSync } from 'node:fs';

const BOARD = readFileSync(new URL('../loadboard.js', import.meta.url), 'utf8');

let failures = 0;
function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) { console.log(`       expected: ${JSON.stringify(expected)}\n       actual:   ${JSON.stringify(actual)}`); failures++; }
}

function extractFunction(src, name) {
  let start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`could not find ${name}`);
  if (src.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
  let p = src.indexOf('(', start), parens = 0, j = p;
  for (; j < src.length; j++) {
    if (src[j] === '(') parens++;
    else if (src[j] === ')') { parens--; if (parens === 0) break; }
  }
  let i = src.indexOf('{', j), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

const SOURCES = ['isBlankRoute', 'minimizeTrip', 'discardRoute', 'saveTripNow', 'nextFreeTripNumber', 'findExistingTripRow']
  .map((name) => extractFunction(BOARD, name)).join('\n\n');

// Records what actually reached PostgREST.
function makeClient(log, existingRows = []) {
  return {
    from: () => ({
      select: () => ({
        eq: (_c, v1) => ({
          eq: (_c2, v2) => ({ limit: async () => ({ data: existingRows.filter((r) => r.trip_id === v2).map((r) => ({ id: r.id })), error: null }) }),
          then: undefined,
          // nextFreeTripNumber's shape: .select().eq() awaited directly
          ...{ [Symbol.toPrimitive]: undefined },
        }),
      }),
      insert: (payload) => { log.push(['insert', payload]); return { select: async () => ({ data: [{ id: 99999 }], error: null }) }; },
      update: (payload) => ({ eq: async (_c, id) => { log.push(['update', id, payload]); return { error: null }; } }),
      delete: () => ({ eq: async (_c, id) => { log.push(['delete', id]); return { error: null }; } }),
    }),
  };
}

function build(log, client) {
  let rendered = 0;
  const api = new Function('supabaseClient', 'countRender', 'log', `
    ${SOURCES}
    const TRIPS_TABLE = 'loads_trips';
    const state = { sheets: { atlanta: [] } };
    const tripSaveTimers = new Map();
    const shiftSaveTimers = new Map();
    let ROW = null;
    const findRowAnywhere = (id) => (ROW && ROW.id === id ? { row: ROW } : null);
    const cancelPendingSaves = () => {};
    const forgetDirtyFields = () => {};
    const renderBoardTable = () => countRender();
    const recomputeRowRate = () => {};
    const setDriverSyncStatus = () => {};
    const snapshotDirtyFields = () => new Set();
    const confirmDirtyFieldsSaved = () => {};
    const queueAljexSync = () => {};
    const dirtyTripFields = new Map();
    const saveShiftNow = async (row) => row.dbId;
    const tripToDbRow = (trip, shiftDbId, tripNumber) => ({
      shift_id: shiftDbId, trip_number: tripNumber,
      route_id: trip.routeId || null, trip_id: trip.tripId || null,
      minimized: !!trip.minimized,
    });
    return {
      isBlankRoute, minimizeTrip, saveTripNow,
      setRow: (row) => { ROW = row; state.sheets.atlanta = [row]; },
    };
  `)(client, () => { rendered += 1; }, log);
  return { api, renders: () => rendered };
}

const route = (over = {}) => ({
  id: 'trip-local-1', dbId: null, routeId: '', tripId: '', minimized: false,
  routeImagePath: '', routeImagePaths: [], ...over,
});

// ---------------------------------------------------------------------------
console.log('\n1. what counts as blank');
{
  const { api } = build([], makeClient([]));
  check('no Route ID and no Trip ID', api.isBlankRoute(route()), true);
  check('whitespace is not content', api.isBlankRoute(route({ routeId: '   ', tripId: '\t' })), true);
  check('a Route ID makes it real', api.isBlankRoute(route({ routeId: 'Kelloggs' })), false);
  check('a Trip ID makes it real', api.isBlankRoute(route({ tripId: '1297570' })), false);
  // The dispatcher who drops the route image before typing anything.
  check('a dropped image makes it real', api.isBlankRoute(route({ routeImagePaths: ['40370/x.jpg'] })), false);
  check('the legacy single-image field counts too', api.isBlankRoute(route({ routeImagePath: '40370/x.jpg' })), false);
  check('a missing route is blank', api.isBlankRoute(null), true);
}

// ---------------------------------------------------------------------------
console.log('\n2. a blank route is never inserted');
{
  const log = [];
  const { api } = build(log, makeClient(log));
  const row = { id: 'row-1', dbId: 16141, location: 'atlanta', trips: [] };
  const blank = route();
  row.trips.push(blank);
  api.setRow(row);
  const result = await api.saveTripNow(row, blank, 1);
  check('nothing was written', log.length, 0);
  check('and it reports no id', result, null);
  check('so the route still has none', blank.dbId, null);
}

console.log('\n3. the same route saves the moment it has an identity');
{
  const log = [];
  const { api } = build(log, makeClient(log));
  const row = { id: 'row-1', dbId: 16141, location: 'atlanta', trips: [] };
  const filled = route({ routeId: 'Kelloggs', tripId: '1297570' });
  row.trips.push(filled);
  api.setRow(row);
  await api.saveTripNow(row, filled, 2);
  check('one insert went out', log.filter(([kind]) => kind === 'insert').length, 1);
  check('carrying the route', log[0][1].route_id, 'Kelloggs');
}

// ---------------------------------------------------------------------------
console.log('\n4. minimizing a blank route discards it');
{
  const log = [];
  const { api, renders } = build(log, makeClient(log));
  const blank = route({ id: 'trip-blank', dbId: 40535 }); // a blank that DID reach the table
  const real = route({ id: 'trip-real', dbId: 40534, routeId: 'BA3001', tripId: '1296759' });
  const row = { id: 'row-1', dbId: 16144, location: 'atlanta', trips: [real, blank] };
  api.setRow(row);
  await api.minimizeTrip('row-1', 'trip-blank');
  check('it is gone from the load', row.trips.map((t) => t.id).join(','), 'trip-real');
  check('and deleted from the database', log.filter(([kind]) => kind === 'delete').map(([, id]) => id).join(), '40535');
  check('it was not saved on the way out', log.some(([kind]) => kind === 'insert' || kind === 'update'), false);
  check('the board repainted', renders() > 0, true);
}

console.log('\n5. a blank route that never reached the database just disappears');
{
  const log = [];
  const { api } = build(log, makeClient(log));
  const blank = route({ id: 'trip-blank' });
  const real = route({ id: 'trip-real', dbId: 40534, routeId: 'BA3001', tripId: '1296759' });
  const row = { id: 'row-1', dbId: 16144, location: 'atlanta', trips: [real, blank] };
  api.setRow(row);
  await api.minimizeTrip('row-1', 'trip-blank');
  check('removed from the load', row.trips.length, 1);
  check('and nothing was sent at all', log.length, 0);
}

console.log('\n6. a load is never left with no routes');
{
  const log = [];
  const { api } = build(log, makeClient(log));
  const blank = route({ id: 'trip-blank', dbId: 40535 });
  const row = { id: 'row-1', dbId: 16144, location: 'atlanta', trips: [blank] };
  api.setRow(row);
  await api.minimizeTrip('row-1', 'trip-blank');
  check('the only route stays', row.trips.length, 1);
  check('and nothing was deleted', log.some(([kind]) => kind === 'delete'), false);
}

console.log('\n7. minimizing a real route still just minimizes it');
{
  const log = [];
  const { api } = build(log, makeClient(log));
  const real = route({ id: 'trip-real', dbId: 40550, routeId: 'Kelloggs', tripId: '1297570' });
  const other = route({ id: 'trip-other', dbId: 40522, routeId: 'BA3001', tripId: '1296759' });
  const row = { id: 'row-1', dbId: 16141, location: 'atlanta', trips: [other, real] };
  api.setRow(row);
  await api.minimizeTrip('row-1', 'trip-real');
  check('still on the load', row.trips.length, 2);
  check('marked minimized', real.minimized, true);
  check('saved, not deleted', log.filter(([kind]) => kind === 'update').length, 1);
  check('nothing was deleted', log.some(([kind]) => kind === 'delete'), false);
}

console.log(failures ? `\n  ${failures} check(s) FAILED\n` : '\n  All checks passed.\n');
process.exit(failures ? 1 : 0);
