import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const src=readFileSync('loadboard.js','utf8');
function fixture(){
  const elements=new Map();
  const $=id=>{if(!elements.has(id)){const hidden=new Set();elements.set(id,{disabled:false,classList:{add:c=>hidden.add(c),remove:c=>hidden.delete(c),toggle:(c,on)=>on?hidden.add(c):hidden.delete(c),contains:c=>hidden.has(c)}});}return elements.get(id);};
  let calls=0;
  const fresh=()=>({batches:[[{name:'A',phone:'1'}],[{name:'B',phone:'2'}],[{name:'C',phone:'3'}]],batchIndex:0,skipped:[],blocked:[],totalSent:0,message:'test',groupKey:'test'});
  const context=vm.createContext({$,groupTextState:fresh(),autoSendAfterStart:false,
    GROUP_FOOTER_BUTTONS:['tg-send-now','tg-open-web','tg-open-batch','tg-confirm-sent','tg-finish'],
    escapeHtml:String,console:{error(){}},SUPABASE_URL:'test',
    filterNeverTextRecipients:allowed=>({allowed,blocked:[]}),formatTextAddress:String,
    openOutlookWebDraft(){},openMailDraft(){},fetch:async()=>{calls++;throw Error('unavailable');},
    TEXT_FROM_MAILBOX:'memppw@dltransport.com'});
  // renderGroupTextProgress() now draws the "send from memppw@dltransport.com"
  // note once the batch has fallen back to Outlook, so its helper has to exist
  // in here too or that branch throws.
  for(const name of ['sendFromReminderHtml','setGroupFooter','showGroupOutlookFallback','renderGroupTextProgress','sendCurrentGroupBatchDirect','confirmGroupBatchSent','openCurrentGroupBatchInWeb','openCurrentGroupBatch','resetGroupTextState']){
    const match=src.match(new RegExp(`(?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?\\n  \\}|function ${name}\\([^\\n]*\\) \\{[^\\n]*\\}`));
    assert.ok(match,name);vm.runInContext(match[0],context);
  }
  const run=name=>vm.runInContext(`${name}()`,context);
  const visible=()=>context.GROUP_FOOTER_BUTTONS.filter(id=>!$('#'+id).classList.contains('hidden'));
  return {context,run,visible,fresh,calls:()=>calls};
}
test('one failure keeps later batches in Outlook mode; reopening tries direct send again',async()=>{
  const f=fixture();f.run('renderGroupTextProgress');assert.deepEqual(f.visible(),['tg-send-now']);
  await f.run('sendCurrentGroupBatchDirect');assert.equal(f.calls(),1);
  for(const opener of ['openCurrentGroupBatchInWeb','openCurrentGroupBatch']){
    assert.deepEqual(f.visible(),['tg-open-web','tg-open-batch']);
    f.run(opener);f.run('confirmGroupBatchSent');
    assert.deepEqual(f.visible(),['tg-open-web','tg-open-batch']);
    await f.run('sendCurrentGroupBatchDirect');assert.equal(f.calls(),1);
  }
  f.run('resetGroupTextState');f.context.groupTextState=f.fresh();f.run('renderGroupTextProgress');
  assert.deepEqual(f.visible(),['tg-send-now']);await f.run('sendCurrentGroupBatchDirect');assert.equal(f.calls(),2);
});
test('successful automatic sends keep Send Now available for subsequent batches',async()=>{
  const f=fixture();f.context.fetch=async()=>({ok:true,json:async()=>({})});
  await f.run('sendCurrentGroupBatchDirect');assert.equal(f.context.groupTextState.batchIndex,1);
  assert.deepEqual(f.visible(),['tg-send-now']);
});
test('a late failure from a previous modal session cannot switch the new one to Outlook',async()=>{
  const f=fixture();let reject;f.context.fetch=()=>new Promise((_,r)=>{reject=r;});
  const pending=f.run('sendCurrentGroupBatchDirect');f.context.groupTextState=f.fresh();
  f.run('renderGroupTextProgress');reject(Error('late failure'));await pending;
  assert.deepEqual(f.visible(),['tg-send-now']);assert.equal(f.context.groupTextState.outlookOnly,undefined);
});
