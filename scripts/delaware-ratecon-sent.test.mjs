import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { createClient } from '@supabase/supabase-js';
const source = fs.readFileSync('accounting-save.js', 'utf8');
const { markAccountingSentForShift } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('ratecon marker updates only Sent on its source shift, and verifies the response', async () => {
  const requests = [];
  let result = { id: 42, source_shift_id: 'shift-7', sent: true };
  const client = createClient('https://example.supabase.co', 'test-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (url, options) => {
      requests.push({ url: new URL(url), options });
      return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } }
  });
  await markAccountingSentForShift(client, 'shift-7');
  assert.equal(requests[0].options.method, 'PATCH');
  assert.equal(requests[0].url.searchParams.get('source_shift_id'), 'eq.shift-7');
  assert.deepEqual(JSON.parse(requests[0].options.body), { sent: true });
  for (const bad of [null, { ...result, sent: false }, { ...result, source_shift_id: 'other' }]) {
    result = bad;
    await assert.rejects(markAccountingSentForShift(client, 'shift-7'));
  }
  await assert.rejects(markAccountingSentForShift(client, null));
});

const board = fs.readFileSync('loadboard.js', 'utf8');
const fn = board.match(/  async function finalizeShiftCompletion\(row\) \{[\s\S]*?\n  \}\n/)[0];
function fixture({ saved = true, syncError = false } = {}) {
  const calls = [];
  const context = vm.createContext({
    Date, state: { activeLocation: 'delaware' }, supabaseClient: {},
    saveShiftNow: async () => { calls.push('save'); return saved; },
    logChange: () => {}, labelForRow: () => '',
    discardBlankTrips: async () => {}, minimizeAllTrips: async () => {}, recomputeRowRate: () => {},
    maybeSendToAccounting: async () => { calls.push('accounting'); },
    markAccountingSentForShift: async (_client, id) => { calls.push(['sent', id]); if (syncError) throw Error('denied'); },
    console: { error: () => {} }, setDriverSyncStatus: () => {}, alert: () => { calls.push('alert'); }
  });
  vm.runInContext(fn, context);
  return { complete: vm.runInContext('finalizeShiftCompletion', context), calls };
}

test('Delaware completion saves and creates accounting before checking Sent; other locations do not', async () => {
  for (const location of ['delaware', 'atlanta', 'mondelez']) {
    const { complete, calls } = fixture();
    await complete({ dbId: 'shift-7', location, shiftComplete: false });
    assert.deepEqual(calls, location === 'delaware' ? ['save', 'accounting', ['sent', 'shift-7']] : ['save', 'accounting']);
  }
});

test('failed board save does not check Sent; failed accounting save is visible', async () => {
  const failed = fixture({ saved: false });
  const row = { dbId: 'shift-7', location: 'delaware', shiftComplete: false, shiftCompleteAt: null };
  await failed.complete(row);
  assert.equal(row.shiftComplete, false);
  assert.equal(row.shiftCompleteAt, null);
  assert.deepEqual(failed.calls, ['save']);
  const denied = fixture({ syncError: true });
  await denied.complete(row);
  assert.equal(denied.calls.at(-1), 'alert');
});
