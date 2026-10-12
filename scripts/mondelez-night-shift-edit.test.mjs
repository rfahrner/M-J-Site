/*
 * Night Shift puts tomorrow's early-AM loads on today's Mondelez board.
 * Every edit has to reach them.
 *
 * Reported as "the Mondelez page isn't letting us click and drag an image
 * into it" -- but the dropzone was fine. The row lookup was
 * getMondelezRowsForDate(state.activeDate), which cannot see a carried row,
 * and every caller ends in `if (!row) return;`. So with Night Shift on, a
 * carried row silently refused everything and nothing on screen said why.
 *
 * These drive the REAL functions out of mondelez.js.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const src = fs.readFileSync('mondelez.js', 'utf8');
function lift(name) {
  const m = src.match(new RegExp(`^(?:export )?(?:async )?function ${name}\\([^]*?\\n\\}`, 'm'));
  if (!m) throw new Error(`could not lift ${name} from mondelez.js`);
  return m[0].replace(/^export /, '');
}

const TODAY = '2026-10-12';
const TOMORROW = '2026-10-13';

function setup({ nightShift = true } = {}) {
  const dom = new JSDOM('<table id="t"></table>', { runScripts: 'outside-only' });
  const w = dom.window;
  const saved = [];
  const rendered = [];
  const deleted = [];

  const todayRow = { id: 'mdz_today', dbId: 11, shiftDate: TODAY, startTime: '14:00', location: 'morris', aljexNumber: 'A1' };
  const carried = { id: 'mdz_carried', dbId: 22, shiftDate: TOMORROW, startTime: '03:00', location: 'morris', aljexNumber: 'A2' };
  const lateTomorrow = { id: 'mdz_late', dbId: 33, shiftDate: TOMORROW, startTime: '15:00', location: 'morris', aljexNumber: 'A3' };

  Object.assign(w, {
    mondelezState: { rowsByDate: { [TODAY]: [todayRow], [TOMORROW]: [carried, lateTomorrow] }, activeTab: 'combined' },
    state: { activeDate: TODAY, nightShift },
    dirtyMondelezFields: new Map(),
    markFieldDirty: () => {},
    saveMondelezRowNow: (row) => { saved.push(row.id); return Promise.resolve(); },
    renderMondelezTable: () => { rendered.push(1); },
    mondelezNightShiftActive: () => nightShift,
    nightShiftRows: (todayRows, tomorrowRows, parse, field) =>
      todayRows.concat(tomorrowRows.filter((r) => parse(r[field]) !== null && parse(r[field]) < 360)),
    nextShiftDate: () => TOMORROW,
    parseHHMM: (v) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(v || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; },
    confirm: () => true,
    MONDELEZ_TABLE: 'mondelez_loads',
    supabaseClient: { from: () => ({ delete: () => ({ eq: (_c, v) => { deleted.push(v); return Promise.resolve({}); } }) }) },
  });

  w.eval([
    lift('findMondelezRowAnywhere'), lift('mondelezRowById'),
    lift('getMondelezRowsForDate'), lift('getMondelezDisplayRows'),
    lift('toggleMondelezTonu'), lift('toggleMondelezShiftComplete'),
    lift('deleteMondelezRow'),
  ].join('\n') + `
    window.findAnywhere = findMondelezRowAnywhere; window.byId = mondelezRowById;
    window.display = getMondelezDisplayRows; window.tonu = toggleMondelezTonu;
    window.complete = toggleMondelezShiftComplete; window.del = deleteMondelezRow;`);

  return { w, saved, rendered, deleted, todayRow, carried, lateTomorrow };
}

test('the carried row really is on screen -- otherwise the rest proves nothing', () => {
  const { w, carried, lateTomorrow } = setup();
  const ids = w.display(TODAY).map((r) => r.id);
  assert.ok(ids.includes(carried.id), '03:00 tomorrow should carry onto tonight');
  assert.ok(!ids.includes(lateTomorrow.id), '15:00 tomorrow is not part of tonight');
});

test('a row visible under Night Shift can be found -- this is the bug', () => {
  const { w, carried } = setup();
  for (const row of w.display(TODAY)) {
    assert.ok(w.byId(row.id), `row ${row.id} is ON SCREEN but cannot be found, so every edit to it silently does nothing`);
  }
  assert.equal(w.byId(carried.id).id, carried.id);
});

test('the old active-date-only lookup is exactly what could not see it', () => {
  const { w, carried } = setup();
  const activeOnly = w.mondelezState.rowsByDate[w.state.activeDate].find((r) => r.id === carried.id);
  assert.equal(activeOnly, undefined, 'documents the defect: the carried row is not in the active day');
});

test('edits reach a carried row and save under ITS day, not the day on screen', () => {
  const { w, saved, carried } = setup();
  w.tonu(carried.id);
  assert.equal(carried.tonu, true, 'TONU silently did nothing on a carried row');
  w.complete(carried.id);
  assert.equal(carried.shiftComplete, true, 'Shift Complete silently did nothing on a carried row');
  assert.deepEqual(saved, [carried.id, carried.id]);
  assert.equal(carried.shiftDate, TOMORROW, 'a carried row must keep its own date');
});

test('deleting a carried row removes it from ITS day, not from today', async () => {
  const { w, deleted, carried, todayRow } = setup();
  await w.del(carried.id);
  assert.deepEqual(w.mondelezState.rowsByDate[TOMORROW].map((r) => r.id), ['mdz_late'], 'should be spliced out of tomorrow');
  assert.deepEqual(w.mondelezState.rowsByDate[TODAY].map((r) => r.id), [todayRow.id], "today's rows must be untouched");
  assert.deepEqual(deleted, [22], 'and the right database row deleted');
});

test('nothing changes when Night Shift is off', () => {
  const { w, todayRow, carried } = setup({ nightShift: false });
  assert.deepEqual(w.display(TODAY).map((r) => r.id), [todayRow.id]);
  assert.ok(w.byId(todayRow.id));
  assert.ok(w.byId(carried.id), 'a loaded row stays addressable even when not displayed');
});
