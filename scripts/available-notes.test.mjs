import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';

const source = readFileSync(new URL('../loadboard.js', import.meta.url), 'utf8');
function extract(name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n  }', start) + 4);
}
function setup() {
  const updates = [], inserts = [];
  const ctx = {
    Map, Promise, console, uid: () => 'avail-test', AVAILABLE_TABLE: 'board_available_drivers',
    dirtyAvailableFields: new Map(), availableSavesInFlight: new Map(),
    getBoardRateTiers: () => ({ atlanta: [{id:'middle',min:61,max:140,rate:300}] }),
    fmtRateMoney: n => `$${Number(n).toFixed(2)}`,
    setDriverSyncStatus: message => { throw Error(message); },
    supabaseClient: { from: () => ({
      update: payload => ({ eq: async () => { updates.push(payload); return {error:null}; } }),
      insert: payload => ({ select: async () => { inserts.push(payload); return {data:[{id:10}],error:null}; } }),
    }) },
  };
  vm.createContext(ctx);
  const names = ['blankAvailableRow','availableRowToDbRow','availableRowFromDbRow','markFieldDirty',
    'snapshotDirtyFields','confirmDirtyFieldsSaved','dbFieldsSafeToApply','saveAvailableRowNow',
    'persistAvailableRow','atlantaCarrierRateLabel','availableCarrierRateLabel'];
  vm.runInContext(names.map(extract).join('\n'),ctx);
  return {ctx, updates, inserts};
}

test('notes round-trip, including clearing to blank', () => {
  const {ctx} = setup();
  for (const notes of ['Call after noon\nReady tomorrow', '']) {
    const row = {...ctx.blankAvailableRow(),notes};
    assert.equal(ctx.availableRowFromDbRow(ctx.availableRowToDbRow(row,'houston','2026-09-21')).notes,notes);
  }
});

test('note updates do not overwrite the selected driver; a stale echo preserves pending text', async () => {
  const {ctx,updates} = setup();
  const row = {...ctx.blankAvailableRow(),dbId:10,driverId:'7',driverName:'Driver',notes:'New note'};
  ctx.markFieldDirty(ctx.dirtyAvailableFields,row.id,'notes');
  const fresh=ctx.dbFieldsSafeToApply({notes:'Older note',driverName:'Other edit'},ctx.dirtyAvailableFields,row.id,null);
  assert.equal(fresh.notes,undefined);
  await ctx.saveAvailableRowNow(row,'delaware','2026-09-21');
  assert.equal(JSON.stringify(updates),JSON.stringify([{notes:'New note'}]));
  assert.equal(ctx.dirtyAvailableFields.has(row.id),false);
  assert.equal(row.driverId,'7');
});

test('overlapping saves of a notes-only new row insert it once', async () => {
  const {ctx,inserts} = setup();
  const row={...ctx.blankAvailableRow(),notes:'Waiting for driver'};
  ctx.markFieldDirty(ctx.dirtyAvailableFields,row.id,'notes');
  await Promise.all([ctx.saveAvailableRowNow(row,'atlanta','2026-09-21'),ctx.saveAvailableRowNow(row,'atlanta','2026-09-21')]);
  assert.equal(inserts.length,1);
  assert.equal(inserts[0].notes,'Waiting for driver');
  assert.equal(row.dbId,10);
});

test('carrier rates use the board-specific source and preserve zero', () => {
  const {ctx} = setup();
  const driver={normalRate:'250',atlantaRateOverrides:{tiers:{middle:425}}};
  for(const location of ['atlanta','buildingc']) assert.equal(ctx.availableCarrierRateLabel(driver,location),'$425.00');
  for(const location of ['delaware','houston']) assert.equal(ctx.availableCarrierRateLabel(driver,location),'$250.00');
  assert.equal(ctx.availableCarrierRateLabel({normalRate:'0'},'houston'),'$0.00');
  assert.equal(ctx.availableCarrierRateLabel(null,'atlanta'),'');
});
