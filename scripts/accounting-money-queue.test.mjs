import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
const {createAccountingMoneyQueue}=await import('data:text/javascript;base64,'+Buffer.from(readFileSync('accounting-money-queue.js','utf8')).toString('base64'));
const row={id:1},field={column:'total_carrier_pay'};
test('Refresh flushes the newest manual money edit before its debounce expires',async()=>{
  const writes=[];const queue=createAccountingMoneyQueue(async (...args)=>{writes.push(args);return true;},100000);
  queue.schedule(row,field,500);queue.schedule(row,field,750);await queue.flush();
  assert.equal(writes.length,1);assert.equal(writes[0][2],750);await queue.flush();assert.equal(writes.length,1);
});
test('slow money saves stay ordered and Refresh waits for their acknowledgements',async()=>{
  const values=[],finish=[];const queue=createAccountingMoneyQueue((r,f,value)=>new Promise(resolve=>{values.push(value);finish.push(()=>resolve(true));}),100000);
  queue.schedule(row,field,500);const first=queue.flush();await new Promise(setImmediate);
  queue.schedule(row,field,750);let done=false;const second=queue.flush().then(()=>done=true);
  assert.deepEqual(values,[500]);assert.equal(done,false);finish.shift()();await new Promise(setImmediate);
  assert.deepEqual(values,[500,750]);assert.equal(done,false);finish.shift()();await Promise.all([first,second]);assert.equal(done,true);
});
test('a failed manual save stops Refresh from proceeding to calculated rate updates',async()=>{
  const queue=createAccountingMoneyQueue(async()=>false,100000);queue.schedule(row,field,750);
  await assert.rejects(queue.flush(),/manual Accounting rate could not be saved/);
});
test('typing and clearing carrier pay sets/clears its manual protection flag',async()=>{
  const source=readFileSync('accounting.js','utf8');
  const map=source.match(/const ACCOUNTING_MONEY_FIELDS = \{[\s\S]*?\n\};/)[0];
  const save=source.match(/async function saveAccountingMoneyField\([\s\S]*?\n\}/)[0];
  const patches=[];const current={id:1};
  const api=new Function('saveAccountingFields','supabaseClient','getAccountingRecordById','setDriverSyncStatus',`${map}\n${save}\nreturn {save:saveAccountingMoneyField,field:ACCOUNTING_MONEY_FIELDS['acct-carrier-pay']};`)(async(c,id,p)=>{patches.push(p);return p;},{},()=>current,()=>{});
  assert.equal(await api.save(row,api.field,777),true);assert.deepEqual(patches[0],{total_carrier_pay:777,carrier_pay_manual:true});
  assert.equal(await api.save(row,api.field,null),true);assert.deepEqual(patches[1],{total_carrier_pay:null,carrier_pay_manual:false});
});
