import assert from 'node:assert/strict';
import fs from 'node:fs';
const source = fs.readFileSync('accounting.js', 'utf8');
const start = source.indexOf('  async function loadAccountingRecordsForRange(');
const end = source.indexOf('    // A single .in()', start);
const body = source.slice(start, end) + '\n}';
const rows = Array.from({length:1363}, (_, i) => ({id:i+1,shift_date:i<1000?'2026-09-14':'2026-09-29'}));
function harness(failAt = -1, initial = []) {
  let calls=0;
  const client = {from() {
    let after=0, size;
    return {select(){return this;},gte(){return this;},lte(){return this;},order(){return this;},limit(n){size=n;return this;},gt(k,n){assert.equal(k,'id');after=n;return this;},then(resolve){
      const failed=calls++===failAt;
      resolve(failed?{error:{message:'query failed'}}:{data:rows.filter(r=>r.id>after).slice(0,size)});
    }};
  }};
  return new Function('supabaseClient','initial', `let accountingRecords=initial, accountingLoadError=''; const ACCOUNTING_TABLE='loads_accounting'; const acctSortCompare=(a,b)=>a.id-b.id; const setDriverSyncStatus=()=>{}; const renderAccountingTable=()=>{}; ${body}; return {load:loadAccountingRecordsForRange,records:()=>accountingRecords,error:()=>accountingLoadError};`)(client, initial);
}
const complete=harness();
await complete.load('2026-07-31','2026-09-29',true);
assert.equal(complete.records().length,1363);
assert.equal(complete.records().at(-1).shift_date,'2026-09-29');
await complete.load('2026-07-31','2026-09-29',false);
assert.equal(complete.records().length,1363,'overlapping fetches must not duplicate loads');
const previous=[{id:9000}];
const failed=harness(1,previous);
await failed.load('2026-07-31','2026-09-29',true);
assert.deepEqual(failed.records(),previous,'failed later page preserves the previous complete dataset');
assert.match(failed.error(),/query failed/);
console.log('Accounting pagination, recent dates, deduplication and partial-fetch failure checks passed.');
