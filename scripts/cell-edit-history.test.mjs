import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const helperSource = readFileSync(new URL('../cell-edit-history.js', import.meta.url), 'utf8');
const { createCellEditHistory } = await import(`data:text/javascript;base64,${Buffer.from(helperSource).toString('base64')}`);
const source = readFileSync(new URL('../loadboard.js', import.meta.url), 'utf8');
function extract(name) {
  let start = source.indexOf(`function ${name}(`);
  if (source.slice(start - 6, start) === 'async ') start -= 6;
  let i = source.indexOf('{', start), depth = 0;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(name);
}
const maps = source.slice(source.indexOf('  const SHIFT_HISTORY_FIELDS ='), source.indexOf('  const cellHistorySaveQueues ='));
const describe = new Function('numOrNull', `${maps}; return describeHistoryCell;`)(
  (v) => !String(v).trim() ? null : Number.isFinite(Number(String(v).replaceAll(',', ''))) ? Number(String(v).replaceAll(',', '')) : undefined,
);
const cell = (field, value = '', trip = null) => ({ dataset: { row: 'row1', field, ...(trip ? { trip } : {}) }, value });
function setup() {
  const entries = [];
  return { entries, history: createCellEditHistory({ describe, commit: (entry) => entries.push(entry) }) };
}
function type(history, el, value) { el.value = value; history.input(el); }

test('partial driver name and dropdown selection stay silent until leaving; one final assignment', () => {
  const { history, entries } = setup();
  const driver = cell('driverName');
  history.focus(driver);
  type(history, driver, 'atiba war');
  assert.equal(entries.length, 0);
  type(history, driver, 'Atiba Ward'); // the real dropdown calls this same hook
  assert.equal(entries.length, 0);
  history.focus(cell('shiftStart'));
  history.blur(driver, cell('shiftStart')); // delayed focusout must not duplicate
  assert.equal(entries.length, 1);
  assert.equal(entries[0].before, '');
  assert.equal(entries[0].value, 'Atiba Ward');
  assert.equal(entries[0].fieldName, 'driver_reassigned');
});

test('PRO fragments are never recorded, even across a redraw restoring focus', () => {
  const { history, entries } = setup();
  const pro = cell('proNumber');
  history.focus(pro);
  type(history, pro, '1997');
  const restored = cell('proNumber', '1997');
  history.focus(restored);
  history.blur(pro, restored);
  assert.equal(entries.length, 0);
  type(history, restored, '1997623');
  history.blur(restored, null);
  assert.equal(entries.length, 1);
  assert.deepEqual([entries[0].before, entries[0].value], ['', '1997623']);
});

test('Tabbing through unchanged cells, editing back, or automatic value replacement produces no event', () => {
  const { history, entries } = setup();
  history.blur({ dataset: {} }, null); // selection/action controls have no tracked field
  history.focus({ dataset: {} });
  const pro = cell('proNumber', '1997623');
  history.focus(pro);
  history.focus(cell('driverName', 'Atiba Ward'));
  history.focus(pro);
  type(history, pro, '1997');
  type(history, pro, '1997623');
  history.blur(pro, null);
  const rate = cell('rate', '420');
  history.focus(rate);
  rate.value = '470'; // a programmatic calculation emits no user input event
  history.blur(rate, null);
  assert.equal(entries.length, 0);
});

test('distinct visits remain separate edits and trip 2 never uses trip 1 baseline', () => {
  const { history, entries } = setup();
  const first = cell('routeId', 'A', 'trip1');
  const second = cell('routeId', 'B', 'trip2');
  history.focus(first); type(history, first, 'A2'); history.focus(second);
  type(history, second, 'B2'); history.focus(first);
  type(history, first, 'A23'); history.blur(first, null);
  assert.deepEqual(entries.map(e => [e.tripId, e.before, e.value]), [['trip1', 'A', 'A2'], ['trip2', 'B', 'B2'], ['trip1', 'A2', 'A23']]);
});

test('manual numeric overrides, clearing, checkboxes and invalid numeric input', () => {
  const { history, entries } = setup();
  const rate = cell('rate', '470');
  history.focus(rate); type(history, rate, '470.00'); history.blur(rate, null);
  history.focus(rate); type(history, rate, '475'); history.blur(rate, null);
  history.focus(rate); type(history, rate, 'bad'); history.blur(rate, null);
  rate.value = '475'; history.focus(rate); type(history, rate, ''); history.blur(rate, null);
  const flag = { ...cell('salvage', '', 'trip1'), type: 'checkbox', checked: false };
  history.focus(flag); flag.checked = true; history.input(flag);
  assert.equal(entries.length, 2);
  history.blur(flag, null);
  assert.deepEqual(entries.map(e => [e.before, e.value]), [['470', '475'], ['475', ''], ['false', 'true']]);
  assert.equal(describe({ ...cell('etaNextDispatch', '12:00', 'trip1'), readOnly: true }), null);
});

test('history waits for final successful save, skips failed writes, and identifies the actual trip', async () => {
  const entries = [], saves = [], notes = [];
  const row = { id: 'row1', dbId: 81, location: 'atlanta', trips: [{ id: 'trip1', dbId: 91 }, { id: 'trip2', dbId: 92, routeId: 'B' }] };
  let completeSave;
  let succeeds = true;
  const env = {
    findRowAnywhere: () => ({ row }), shiftSaveTimers: new Map(), tripSaveTimers: new Map(),
    cellHistorySaveQueues: new Map(), scheduledCellSaves: new Map(),
    saveShiftNow: async () => { saves.push('shift'); await new Promise(resolve => { completeSave = resolve; }); return succeeds ? row.dbId : null; },
    saveTripNow: async (r, t) => { saves.push(t.id); return t.dbId; },
    logChange: async (...args) => entries.push(args), logBoardNoteToPermanentLog: async (...args) => notes.push(args),
    labelForRow: () => '1997623', resolveDriverByName: () => ({}), warnIfDriverAlreadyScheduled() {}, checkDriverComplianceWarning() {},
  };
  const commit = new Function(...Object.keys(env), `${extract('runScheduledCellSave')};${extract('commitBoardCellEdit')};return commitBoardCellEdit`)(...Object.values(env));
  const edit = { rowId: 'row1', field: 'proNumber', fieldName: 'pro_number', before: '1997', value: '1997623' };
  const pending = commit(edit);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(entries.length, 0);
  completeSave(); await pending;
  assert.deepEqual(entries[0].slice(2), ['pro_number', '1997', '1997623', null]);
  succeeds = false;
  const failed = commit(edit); await new Promise(resolve => setImmediate(resolve)); completeSave(); await failed;
  assert.equal(entries.length, 1);
  await commit({ ...edit, tripId: 'trip2', field: 'routeId', fieldName: 'route_id', before: 'B', value: 'B2' });
  assert.equal(entries[1][5], 92);
  succeeds = true;
  const note = commit({ ...edit, field: 'notes', value: 'Final note' });
  await new Promise(resolve => setImmediate(resolve)); completeSave(); await note;
  assert.equal(entries.length, 2); assert.equal(notes.length, 1);
});

test('a completed edit and the next autosave cannot overtake an in-flight save', async () => {
  const scheduledCellSaves = new Map();
  const queue = new Function('scheduledCellSaves', `${extract('runScheduledCellSave')};return runScheduledCellSave`)(scheduledCellSaves);
  let release;
  const calls = [];
  const first = queue('row1:', async () => { calls.push('partial'); await new Promise(resolve => { release = resolve; }); });
  const second = queue('row1:', async () => { calls.push('committed'); });
  const third = queue('row1:', async () => { calls.push('next cell'); });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['partial']);
  release();
  await Promise.all([first, second, third]);
  assert.deepEqual(calls, ['partial', 'committed', 'next cell']);
  assert.equal(scheduledCellSaves.size, 0);
});

test('production wiring has explicit input/selection hooks and no catch-all SQL history triggers', () => {
  const focusIn = source.slice(source.indexOf('boardTable.addEventListener("focusin", (e)'), source.indexOf('boardTable.addEventListener("focusout", (e)'));
  assert.match(focusIn, /boardCellHistory\.focus\(e\.target\)/);
  assert.match(focusIn, /input\.value = drv\.name;\s*boardCellHistory\.input\(input\)/);
  assert.match(source, /setTimeout\(\(\) => boardCellHistory\.blur\(t, document\.activeElement\), 0\)/);
  const input = source.slice(source.indexOf('boardTable.addEventListener("input"'), source.indexOf('boardTable.addEventListener("change"'));
  assert.match(input, /boardCellHistory\.input\(t\)/);
  assert.doesNotMatch(input, /logChange\(/);
  const sql = readFileSync(new URL('../supabase/migrations/20260929190000_committed_user_change_history.sql', import.meta.url), 'utf8');
  assert.match(sql, /drop trigger if exists loads_shifts_change_log on public\.loads_shifts/);
  assert.match(sql, /drop trigger if exists loads_trips_change_log on public\.loads_trips/);
  assert.match(sql, /security invoker/);
  assert.doesNotMatch(sql, /delete from|update public\.load_change_history|starts_with\(/i);
});
