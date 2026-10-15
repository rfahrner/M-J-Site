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
test('zero is saved as an override, while blank invokes the atomic recalculation',async()=>{
  const source=readFileSync('accounting.js','utf8');
  const map=source.match(/const ACCOUNTING_MONEY_FIELDS = \{[\s\S]*?\n\};/)[0];
  const save=source.match(/async function saveAccountingMoneyField\([\s\S]*?\n\}/)[0];
  const patches=[],calls=[];const current={id:1};
  const client={rpc:async(name,args)=>{calls.push({name,args});return {data:{id:1,[args.p_column]:600,carrier_pay_manual:false,revenue_manual:false},error:null};}};
  const api=new Function('saveAccountingFields','supabaseClient','getAccountingRecordById','setDriverSyncStatus','document','renderDriverStatsTable',`${map}\n${save}\nreturn {save:saveAccountingMoneyField,fields:Object.values(ACCOUNTING_MONEY_FIELDS)};`)(async(c,id,p)=>{patches.push(p);return p;},client,()=>current,()=>{},{querySelector:()=>null},()=>{});
  for(const field of api.fields) {
    for(const value of [777,0]) {
      assert.equal(await api.save(row,field,value),true);
      assert.deepEqual(patches.at(-1),{[field.column]:value,[field.freezes]:true});
      assert.equal(current[field.column],value);
    }
    const count=patches.length;
    assert.equal(await api.save(row,field,null),true);
    assert.equal(patches.length,count,'never save an intermediate blank');
    assert.deepEqual(calls.at(-1),{name:'reset_accounting_rate',args:{p_accounting_id:1,p_column:field.column}});
    assert.equal(current[field.column],600);assert.equal(current[field.freezes],false);
  }
});
test('a slow blank calculation cannot overwrite a newer zero; realtime keeps queued input',async()=>{
  const writes=[],finish=[];const currentChecks=[];
  const queue=createAccountingMoneyQueue((r,f,value,isCurrent)=>new Promise(resolve=>{
    writes.push(value);finish.push(()=>{currentChecks.push(isCurrent());resolve(true);});
  }),100000);
  queue.schedule(row,field,null);const first=queue.flush();await new Promise(setImmediate);
  queue.schedule(row,field,0);
  assert.equal(queue.overlay({id:1,total_carrier_pay:600}).total_carrier_pay,0);
  const second=queue.flush();finish.shift()();await new Promise(setImmediate);
  assert.deepEqual(writes,[null,0]);finish.shift()();await Promise.all([first,second]);
  assert.deepEqual(currentChecks,[false,true]);
  assert.equal(queue.overlay({id:1,total_carrier_pay:0}).total_carrier_pay,0);
});
test('carrier and customer resets for the same load save in order',async()=>{
  const calls=[],finish=[];
  const queue=createAccountingMoneyQueue((r,f)=>new Promise(resolve=>{calls.push(f.column);finish.push(()=>resolve(true));}),100000);
  queue.schedule(row,field,null);queue.schedule(row,{column:'total_revenue'},null);
  const done=queue.flush();await new Promise(setImmediate);
  assert.deepEqual(calls,['total_carrier_pay']);finish.shift()();await new Promise(setImmediate);
  assert.deepEqual(calls,['total_carrier_pay','total_revenue']);finish.shift()();await done;
});

test('Refresh orders debounced replacements by the most recent edit',async()=>{
  const calls=[];const queue=createAccountingMoneyQueue(async(r,f)=>{calls.push(f.column);return true;},100000);
  const customer={column:'total_revenue'};
  queue.schedule(row,customer,123);queue.schedule(row,field,null);queue.schedule(row,customer,null);
  await queue.flush();assert.deepEqual(calls,['total_carrier_pay','total_revenue']);
});
