import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../accounting-audit-snapshots.js', import.meta.url), 'utf8').replace(/^import .*;\n/, '');
let renderCount = 0;
let click;
const context = vm.createContext({
  location: { pathname: '/accounting.html' },
  document: { readyState: 'complete', addEventListener: (_, fn) => { click = fn; }, getElementById: () => null },
  loadDetailsState: { accountingId: '2', loadNotes: [], history: [] },
  renderLoadDetailsTabs: () => { renderCount++; },
  supabaseClient: null,
  setTimeout: fn => fn(), console,
});
vm.runInContext(source, context);
vm.runInContext("activeAccountingId = '1'; snapshotNotes = [{id: 11, note_text: 'Load one'}]; applySnapshotsToOpenLoad();", context);
assert.equal(context.loadDetailsState.loadNotes.length, 0, 'previous load snapshot cannot appear on another load');
assert.equal(renderCount, 0);
vm.runInContext("activeAccountingId = '2'; snapshotNotes = [{id: 22, note_text: 'Load two'}]; applySnapshotsToOpenLoad();", context);
assert.equal(context.loadDetailsState.loadNotes[0].id, 22, 'matching load receives its own snapshot');
assert.equal(renderCount, 1);
vm.runInContext("loadAccountingAuditSnapshot = id => { globalThis.requestedId = id; };", context);
click({ target: { closest: () => ({ dataset: { acctLoadNotes: '3' } }) } });
assert.equal(context.requestedId, '3', 'notes icon fetches the selected accounting snapshot');
console.log('Accounting notes isolation passed');
