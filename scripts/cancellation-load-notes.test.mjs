import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source = readFileSync('loadboard.js', 'utf8');
function loadFn(name, ctx) {
  const fn = source.match(new RegExp(`(?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?\\n  \\}`));
  assert.ok(fn, name);
  vm.runInContext(fn[0], ctx);
  return vm.runInContext(name, ctx);
}
test('Next Call Time prioritizes cancellation and TONU, then restores normal display', () => {
  const ctx = vm.createContext({ atDcSinceMinForRow: row => row.atDc, minsToClock: () => '08:00', computeNextCallTimeForRow: () => '09:00' });
  const display = loadFn('nextCallTimeDisplayForRow', ctx);
  assert.equal(display({ tonu: true, shiftComplete: true }), 'TONU');
  assert.equal(display({ loadCancelled: true, tonu: true }), 'cancelled');
  assert.equal(display({ calledOff: true, atDc: 480 }), 'cancelled');
  assert.equal(display({ shiftComplete: true }), 'Complete');
  assert.equal(display({ atDc: 480 }), 'At DC since: 08:00');
  assert.equal(display({}), '09:00');
});
function fixture(fail = false) {
  const inserts = [], notices = [];
  const ctx = vm.createContext({
    supabaseClient: { from(table) { return { insert(payload) { inserts.push({ table, payload }); return this; }, select() { return this; }, async single() { return fail ? { error: new Error('offline') } : { data: { id: 1, ...inserts.at(-1).payload } }; } }; } },
    LOAD_NOTES_TABLE: 'load_notes', DRIVER_NOTES_TABLE: 'driver_notes',
    findDriver: () => null, currentUserName: () => 'Dispatcher', currentUserLabel: '',
    loadDetailsState: { rowId: 'row1', loadNotes: [] }, renderLoadDetailsTabContent() {},
    setDriverSyncStatus: (...args) => notices.push(args), console: { error() {} },
    resolveDriverByName: () => ({}), state: { drivers: [] }
  });
  const save = loadFn('logCancellationToLoadNotes', ctx);
  const driverSave = loadFn('logDriverCancellationNote', ctx);
  return { ctx, inserts, notices, save, driverSave };
}
test('driver cancellation saves under the exact load even without a linked driver', async () => {
  const f = fixture();
  await f.driverSave({ id: 'row1', dbId: 42, driverNameText: 'Test Driver', proNumber: '123', shiftDate: '2026-09-25', shiftStart: '06:00' }, 'Truck broke down');
  assert.equal(f.inserts.length, 1);
  assert.equal(f.inserts[0].table, 'load_notes');
  assert.equal(f.inserts[0].payload.shift_id, 42);
  assert.equal(f.inserts[0].payload.created_by, 'Dispatcher');
  assert.match(f.inserts[0].payload.note_text, /Driver cancellation.*Test Driver.*2026-09-25 06:00.*Truck broke down/);
  assert.equal(f.ctx.loadDetailsState.loadNotes.length, 1);
});
test('failed note save is visible and does not add an unsaved modal note', async () => {
  const f = fixture(true);
  await f.save({ id: 'row1', dbId: 42, proNumber: '123' }, 'Reason');
  assert.equal(f.ctx.loadDetailsState.loadNotes.length, 0);
  assert.match(f.notices[0][0], /Pro # 123/);
  assert.equal(f.notices[0][1], 'error');
});
