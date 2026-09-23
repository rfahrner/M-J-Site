import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { createClient } from '@supabase/supabase-js';
const source = fs.readFileSync('accounting-save.js','utf8');
const {saveAccountingFields} = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

function fixture(failure) {
  let row={id:42,sent:false,hidden:false,status:'active'};
  const calls=[];
  const client=createClient('https://example.supabase.co','test-key',{
    auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},
    global:{fetch:async(url,options={})=>{
      const method=options.method || 'GET'; calls.push(method);
      if(method==='PATCH') {
        if(failure==='network') throw new Error('network unavailable');
        if(failure==='denied') return new Response(JSON.stringify({message:'permission denied',code:'42501'}),{status:403});
        if(failure==='missing') return new Response(JSON.stringify({message:'Cannot coerce zero rows to an object',code:'PGRST116'}),{status:406});
        const patch=JSON.parse(options.body);
        if(failure!=='mismatch') Object.assign(row,patch);
        if(row.aljex_released_at) row.aljex_released_at=row.aljex_released_at.replace('Z','+00:00');
      }
      return new Response(JSON.stringify(row),{status:200,headers:{'Content-Type':'application/json'}});
    }}
  });
  return {client,calls};
}

test('real Supabase builder executes Sent and keeps it on a fresh read, including uncheck',async()=>{
  const {client,calls}=fixture();
  assert.equal(typeof client.from('loads_accounting').update({sent:true}).eq('id',42).catch,'undefined');
  for(const sent of [true,false]) {
    await saveAccountingFields(client,42,{sent});
    const {data,error}=await client.from('loads_accounting').select('*').eq('id',42).single();
    assert.equal(error,null);assert.equal(data.sent,sent);
  }
  assert.deepEqual(calls,['PATCH','GET','PATCH','GET']);
});

test('Hidden and Released bookkeeping persists, including timestamp normalization',async()=>{
  const {client}=fixture();
  await saveAccountingFields(client,42,{hidden:true});
  await saveAccountingFields(client,42,{status:'released',sent:true,aljex_released_at:'2026-09-22T19:00:00.000Z',aljex_released_by:'Test'});
  const {data}=await client.from('loads_accounting').select('*').eq('id',42).single();
  assert.equal(data.hidden,true);assert.equal(data.status,'released');
  await saveAccountingFields(client,42,{status:'active'});
});

for(const failure of ['denied','missing','network','mismatch']) test(`save reports ${failure} instead of false success`,async()=>{
  const {client}=fixture(failure);
  await assert.rejects(saveAccountingFields(client,42,{sent:true}));
});

test('checkbox waits for confirmation and survives realtime record replacement',async()=>{
  const accounting=fs.readFileSync('accounting.js','utf8');
  const fn=accounting.match(/async function saveAccountingCheckbox\([\s\S]*?\n\}/)[0];
  let resolveSave;
  const pending=new Set(), statuses=[];
  const original={id:42,sent:false};
  const context=vm.createContext({pendingAccountingChecks:pending,accountingRecords:[original],
    supabaseClient:{},renderAccountingTable:()=>{},setDriverSyncStatus:(...s)=>statuses.push(s),
    saveAccountingFields:()=>new Promise(resolve=>{resolveSave=resolve;}),acctSortCompare:()=>0});
  vm.runInContext('function getAccountingRecordById(id){return accountingRecords.find(r=>r.id===id)}\n'+fn,context);
  const save=vm.runInContext('saveAccountingCheckbox',context);
  const work=save(original,{sent:true},'Sent');
  assert.equal(original.sent,false);assert.ok(pending.has('42'));
  context.accountingRecords=[{id:42,sent:false}];
  resolveSave({id:42,sent:true});await work;
  assert.equal(context.accountingRecords[0].sent,true);assert.equal(pending.size,0);
  assert.deepEqual(statuses.at(-1),['Sent saved.','success']);
  context.saveAccountingFields=async()=>{throw Error('denied')};
  await save(context.accountingRecords[0],{sent:false},'Sent');
  assert.equal(context.accountingRecords[0].sent,true);assert.equal(pending.size,0);
  assert.equal(statuses.at(-1)[1],'error');
});


test('row highlighting persists checked and unchecked on fresh reads',async()=>{
  const {client}=fixture();
  for(const highlighted of [true,false]) {
    await saveAccountingFields(client,42,{highlighted});
    const {data,error}=await client.from('loads_accounting').select('*').eq('id',42).single();
    assert.equal(error,null);assert.equal(data.highlighted,highlighted);
  }
});
