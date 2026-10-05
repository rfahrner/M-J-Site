import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync('driver-profile-sync.js', 'utf8');
const { driverProfilePatch, mergeSavedDriverProfiles } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const board = fs.readFileSync('loadboard.js', 'utf8');

test('only deliberate changes are submitted, while clear values remain changes', () => {
  const original = { id: 1, location: 'preferred', profile_key: 'key', 'Driver Cell': '111', 'Notes': 'Keep', normal_rate: 400, atlanta_rate_overrides: { tiers: { '3': 450 }, settings: { overmi: 3 } } };
  assert.deepEqual(driverProfilePatch(original, { ...original, location: 'atlanta', atlanta_rate_overrides: { settings: { overmi: 3 }, tiers: { '3': 450 } } }), {});
  assert.deepEqual(driverProfilePatch(original, { ...original, 'Driver Cell': '222', 'Notes': null, normal_rate: 0 }), { 'Driver Cell': '222', 'Notes': null, normal_rate: 0 });
  const remoteLatest = { ...original, 'Notes': 'Someone else changed this' };
  const patch = driverProfilePatch(original, { ...original, 'Driver Cell': '333' });
  assert.deepEqual({ ...remoteLatest, ...patch }, { ...remoteLatest, 'Driver Cell': '333' });
});

test('saved linked profiles replace local copies immediately, preserving membership and highlight timers', () => {
  const drivers = [{ id: 1, location: 'preferred', phone: 'old', addedAt: 100 }, { id: '2', location: 'atlanta', phone: 'old', addedAt: 200 }, { id: 3, phone: 'other' }];
  mergeSavedDriverProfiles(drivers, [{ id: 1, location: 'preferred', phone: 'new' }, { id: 2, location: 'atlanta', phone: 'new' }]);
  assert.deepEqual(drivers.map(d => [d.id, d.phone, d.addedAt]), [[1, 'new', 100], [2, 'new', 200], [3, 'other', undefined]]);
  assert.deepEqual(drivers.slice(0, 2).map(d => d.location), ['preferred', 'atlanta']);
});

function formContext(result) {
  const values = { 'ad-name': 'Howard Barnett', 'ad-phone': '111', 'ad-mc': '1618522', 'ad-email': '', 'ad-rate': '400' };
  const original = { id: 1, name: 'Howard Barnett', phone: '111', normalRate: '400', location: 'preferred' };
  const calls = [], elements = new Map();
  const $ = id => {
    if (!elements.has(id)) elements.set(id, { classList: { add() {}, toggle() {} }, closest: () => ({ classList: { add() {}, toggle() {} } }), disabled: false });
    return elements.get(id);
  };
  let closed = false;
  const statuses = [];
  const context = vm.createContext({ $, $all: () => [], getVal: id => values[id] || '',
    state: { editingDriverId: 1, editingDriverLocation: 'preferred', drivers: [original, { id: 2, location: 'atlanta', phone: 'old' }] },
    driverProfileState: { originalRow: { phone: '111', normalRate: '400', name: 'Howard Barnett' } },
    findDriver: () => original, driverToDbRow: d => ({ phone: d.phone, normalRate: d.normalRate, name: d.name }),
    driverFromDbRow: d => d, driverProfilePatch, mergeSavedDriverProfiles,
    readAtlantaRateOverridesFromForm: () => null, readDelawareRateOverridesFromForm: () => null,
    DRIVERS_TABLE: 'atlanta_drivers', DRIVER_RATE_HISTORY_TABLE: 'driver_rate_history', console,
    supabaseClient: { from: () => ({
      update: patch => ({ eq: (_key, id) => ({ select: async () => { calls.push(['update', id, patch]); return result; } }) }),
      select: () => ({ eq: async (key, value) => { calls.push(['refresh', key, value]); return { data: [{ id: 1, profileKey: 'shared', phone: '222', normalRate: '400', location: 'preferred' }, { id: 2, profileKey: 'shared', phone: '222', location: 'atlanta' }] }; } })
    }) },
    setDriverSyncStatus: (...args) => statuses.push(args), closeAddDriverModal: () => { closed = true; },
    renderDriverList() {}, refreshDriverDatalist() {}, highlightDriver() {}
  });
  vm.runInContext(board.match(/  async function submitDriverForm\([^]*?\n  \}/)[0], context);
  return { context, values, calls, statuses, isClosed: () => closed, $ };
}

test('form saves a minimal patch and refreshes both tabs from the database before closing', async () => {
  const form = formContext({ data: [{ id: 1, profileKey: 'shared', phone: '222', normalRate: '400', location: 'preferred' }], error: null });
  form.values['ad-phone'] = '222';
  await vm.runInContext('submitDriverForm()', form.context);
  assert.deepEqual(form.calls, [['update', 1, { phone: '222' }], ['refresh', 'profile_key', 'shared']]);
  assert.equal(form.context.state.drivers[1].phone, '222');
  assert.equal(form.context.state.drivers[1].location, 'atlanta');
  assert.equal(form.isClosed(), true);
});

test('unchanged form sends no database write; failed save keeps the form open and reports failure', async () => {
  const unchanged = formContext({});
  await vm.runInContext('submitDriverForm()', unchanged.context);
  assert.deepEqual(unchanged.calls, []);
  const failed = formContext({ error: { message: 'Write refused' } });
  failed.values['ad-phone'] = '222';
  await vm.runInContext('submitDriverForm()', failed.context);
  assert.equal(failed.isClosed(), false);
  assert.match(failed.statuses[0][0], /Couldn't save/);
  assert.equal(failed.$('#ad-submit').disabled, false);
  assert.equal(failed.context.state.drivers[1].phone, 'old');
});
