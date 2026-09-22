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

test('toggling Night Shift never enables a body theme, including with cached CSS', () => {
  const removed = [], pressed = [];
  // The chrome reads state.nightShift, not nightShiftActive(): it draws the
  // header for Houston and Mondelez too, which render their own rows but
  // toggle the same flag, and the button has to look pressed there as well.
  const state = { nightShift: true, activeLocation: 'atlanta', activeDate: '2026-09-22', minDate: '2026-01-01', maxDate: '2027-01-01' };
  const chrome = vm.runInNewContext(`(${board.match(/function renderBoardChrome\(\) \{[\s\S]*?\n  \}/)[0]})`, {
    state, LOCATIONS: [{ key: 'atlanta', title: 'Atlanta' }], nextShiftDate, shortShiftDate,
    keyToDate: value => value, dateKey: value => value, todayDate: () => state.activeDate, humanDate: value => value,
    nightShiftActive: () => state.nightShift,
    document: { body: { classList: { remove: value => removed.push(value), toggle() { throw new Error('Must not enable a theme'); } } } },
    $: () => ({ setAttribute: (name, value) => pressed.push([name, value]) }),
  });
  chrome(); state.nightShift = false; chrome();
  assert.deepEqual(removed, ['night-shift-active', 'night-shift-active']);
  assert.deepEqual(pressed, [['aria-pressed','true'], ['aria-pressed','false']]);
});

/* ---------------------------------------------------------------------------
 * Night Shift is on every board, not just Atlanta.
 *
 * The three standard boards share one renderer, so they share one code path.
 * Houston and Mondelez have their own renderers and their own tables, and they
 * do not agree with the standard boards -- or each other -- about what the
 * start-time field is called: shiftStart, time, startTime. Same 06:00 cutoff
 * everywhere, deliberately: a dispatcher who works two boards should not have
 * to remember two rules.
 * ------------------------------------------------------------------------ */

const houston = readFileSync(new URL('../houston.js', import.meta.url), 'utf8');
const mondelez = readFileSync(new URL('../mondelez.js', import.meta.url), 'utf8');

test('the cutoff is declared once and is 06:00', async () => {
  const { NIGHT_SHIFT_END_MINUTES } = await import(`data:text/javascript;base64,${Buffer.from(helper).toString('base64')}`);
  assert.equal(NIGHT_SHIFT_END_MINUTES, 360);
  // No board re-states the cutoff as a number of minutes of its own.
  for (const [name, src] of [['houston.js', houston], ['mondelez.js', mondelez], ['loadboard.js', board]]) {
    const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
    assert.equal(/(<=|>=|===|<|>)\s*360\b/.test(code), false,
      `${name} should take the cutoff from night-shift.js, not repeat it`);
  }
});

test('each board carries rows over on its own start-time field', () => {
  const day = [{ id: 'd1' }];
  const morning = (field) => ['00:15', '05:59', '06:00', '07:30', ''].map((v, i) => ({ id: `m${i}`, [field]: v }));
  for (const field of ['shiftStart', 'time', 'startTime']) {
    const rows = nightShiftRows(day, morning(field), parseHHMM, field);
    assert.deepEqual(rows.map(r => r.id), ['d1', 'm0', 'm1', 'm2'], `field ${field}`);
  }
  // A board asking with the wrong field name carries nothing over, rather than
  // silently treating every row as a 00:00 start.
  assert.deepEqual(nightShiftRows(day, morning('time'), parseHHMM, 'shiftStart').map(r => r.id), ['d1']);
});

test('the standard renderer is no longer hard-coded to Atlanta', () => {
  const active = board.match(/function nightShiftActive\(\)[\s\S]*?\n  \}/)[0];
  assert.equal(/"atlanta"/.test(active), false, 'nightShiftActive still names Atlanta');
  assert.match(active, /STANDARD_BOARD_LOCATIONS/);
  // The locations come from PAGE_MAP, so adding a board cannot forget this.
  assert.match(board, /STANDARD_BOARD_LOCATIONS = new Set\(\s*\n\s*Object\.values\(PAGE_MAP\)/);
  // The next morning is loaded and read for the board being looked at.
  assert.match(board, /sheetKey\(state\.activeLocation, nextShiftDate\(state\.activeDate\)\)/);
  assert.match(board, /ensureSheetLoaded\(state\.activeLocation, nextShiftDate\(state\.activeDate\)\)/);
  // And the button is wired on every board page, not only Atlanta's.
  assert.equal(/info\.key === "atlanta" && \$\("#btn-night-shift"\)/.test(board), false);
});

test('Houston and Mondelez load and show the next morning too', () => {
  for (const [name, src, loader] of [
    ['houston.js', houston, /await ensureHoustonSheetLoaded\(nextShiftDate\(state\.activeDate\)\)/],
    ['mondelez.js', mondelez, /await ensureMondelezDateLoaded\(nextShiftDate\(state\.activeDate\)\)/],
  ]) {
    assert.match(src, loader, `${name} does not load the next morning`);
    // Reading it without loading it would show an empty night.
    assert.match(src, /nightShiftRows\(/, `${name} does not merge the two days`);
    // A realtime payload for the carried day has to merge, or those rows go
    // stale while they are on screen.
    assert.match(src, /nextShiftDate\(state\.activeDate\)[\s\S]{0,120}return;/, `${name} ignores next-day echoes`);
  }
});

test('every board page has the button', () => {
  for (const page of ['index.html', 'dalaware.html', 'buildingc.html', 'houston.html', 'mondelez.html']) {
    const html = readFileSync(new URL(`../${page}`, import.meta.url), 'utf8');
    const hits = html.match(/id="btn-night-shift"/g) || [];
    assert.equal(hits.length, 1, `${page} should have exactly one Night Shift button`);
    assert.match(html, /aria-pressed="false"/);
  }
});

test('one toggle, shared, so the chrome is right on every board', () => {
  // renderBoardChrome lives in loadboard.js and draws the header for Houston
  // too, so it reads the shared flag rather than the standard-board gate.
  assert.match(board, /\$\("#btn-night-shift"\)\?\.setAttribute\("aria-pressed", String\(!!state\.nightShift\)\)/);
  assert.match(houston, /state\.nightShift = !state\.nightShift/);
  assert.match(mondelez, /state\.nightShift = !state\.nightShift/);
  assert.equal(/houstonState\.nightShift/.test(houston), false, 'Houston should not keep a second flag');
});
