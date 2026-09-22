import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

process.env.TZ = 'America/New_York';
const helper = readFileSync(new URL('../night-shift.js', import.meta.url), 'utf8');
const { nextShiftDate, nightShiftRows, shortShiftDate } = await import(`data:text/javascript;base64,${Buffer.from(helper).toString('base64')}`);
const board = readFileSync(new URL('../loadboard.js', import.meta.url), 'utf8');
// Exercise the actual board clock parser and comparator with isolated state.
const parseHHMM = vm.runInNewContext(`(${board.match(/function parseHHMM\(str\) \{[\s\S]*?\n  \}/)[0]})`);
const compare = vm.runInNewContext(`(${board.match(/function compareRowsForSort\(a, b, key, dir\) \{[\s\S]*?\n  \}/)[0]})`, {
  parseHHMM, nightShiftActive: () => true, state: { activeDate: '2026-09-22' },
});

test('includes all selected-day rows and next morning through 06:00 inclusively', () => {
  const day = [{ shiftDate: '2026-09-22', shiftStart: '23:30' }, { shiftStart: '' }];
  const next = ['00:00', '0559', '0600', '06:01', '18:00', '', 'ASAP', '99:00'].map(shiftStart => ({ shiftDate: '2026-09-23', shiftStart }));
  const rows = nightShiftRows(day, next, parseHHMM);
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.map(r => r.shiftStart), ['23:30', '', '00:00', '0559', '0600']);
  assert.equal(rows[2], next[0]);
  rows[2].notes = 'Updated from night view';
  assert.equal(next[0].notes, 'Updated from night view');
  assert.equal(next[0].shiftDate, '2026-09-23');
  assert.equal(day.length, 2);
});

test('shift-start sort respects calendar date in both directions', () => {
  const rows = [{ shiftDate: '2026-09-23', shiftStart: '06:00' }, { shiftDate: '2026-09-22', shiftStart: '23:30' }, { shiftDate: '2026-09-23', shiftStart: '00:00' }];
  assert.deepEqual([...rows].sort((a,b) => compare(a,b,'shiftStart','asc')).map(r=>r.shiftStart), ['23:30','00:00','06:00']);
  assert.deepEqual([...rows].sort((a,b) => compare(a,b,'shiftStart','desc')).map(r=>r.shiftStart), ['06:00','00:00','23:30']);
});

test('next calendar day works across month, year, leap day and DST boundaries', () => {
  for (const [date, expected] of [['2026-09-30','2026-10-01'], ['2026-12-31','2027-01-01'], ['2028-02-28','2028-02-29'], ['2026-03-08','2026-03-09'], ['2026-11-01','2026-11-02']]) assert.equal(nextShiftDate(date), expected);
  assert.equal(shortShiftDate('2026-09-23'), '09/23');
});

test('visible selection includes morning rows, excludes later shifts and never creates an unloaded cache', () => {
  const day = [{ id: 'day', shiftDate: '2026-09-22', shiftStart: '22:00' }];
  const morning = { id: 'morning', shiftDate: '2026-09-23', shiftStart: '05:00' };
  const later = { id: 'later', shiftDate: '2026-09-23', shiftStart: '07:00' };
  const state = { activeLocation: 'atlanta', activeDate: '2026-09-22', nightShift: true, sheets: { atlanta__2026_09_22: [] } };
  state.sheets = { 'atlanta__2026-09-22': day };
  const context = vm.createContext({ state, nextShiftDate, nightShiftRows, parseHHMM,
    sheetKey: (location,date) => `${location}__${date}`, currentlyEditedField: () => null,
    nightShiftActive: () => state.nightShift, document: { getElementById: () => null },
    updateBulkActionButtonsVisibility() {}, updateBoardSelectCount() {},
  });
  for (const name of ['getVisibleBoardRows', 'selectAllRows']) {
    vm.runInContext(board.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`))[0], context);
  }
  assert.equal(vm.runInContext('getVisibleBoardRows().length', context), 1);
  assert.equal(Object.keys(state.sheets).length, 1);
  state.sheets['atlanta__2026-09-23'] = [morning, later];
  vm.runInContext('selectAllRows(true)', context);
  assert.equal(day[0].selected, true);
  assert.equal(morning.selected, true);
  assert.equal(later.selected, undefined);
  state.nightShift = false;
  assert.equal(vm.runInContext('getVisibleBoardRows().length', context), 1);
});

test('saving an overnight row keeps its original calendar date', () => {
  const shiftToDbRow = vm.runInNewContext(`(${board.match(/function shiftToDbRow\(row, locationKey, dKey\) \{[\s\S]*?\n  \}/)[0]})`, {
    withoutUndefined: value => value, numOrNull: value => value || null,
  });
  const row = { shiftDate: '2026-09-23', location: 'atlanta', shiftStart: '05:00', notes: 'Updated overnight', rateOverrides: {} };
  const payload = shiftToDbRow(row, row.location, row.shiftDate);
  assert.equal(payload.shift_date, '2026-09-23');
  assert.equal(payload.notes, 'Updated overnight');
});
