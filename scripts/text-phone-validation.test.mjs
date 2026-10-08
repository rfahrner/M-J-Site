import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync('loadboard.js','utf8');
function lift(name){const start=source.search(new RegExp(`^  (?:export )?(?:async )?function ${name}\\(`,'m'));assert.ok(start>=0);const end=source.indexOf('\n  }',start);return source.slice(start,end+4).replace('export ','');}
const context=vm.createContext({});vm.runInContext(lift('formatTextAddress')+';this.format=formatTextAddress;',context);
test('gateway formatter accepts one number and supplies country code',()=>{
 for(const value of ['7208173663','(720) 817-3663','720.817.3663',7208173663,'+1 (720) 817-3663','17208173663'])assert.equal(context.format(value),'17208173663@textbetter.com');
});
test('reported concatenations and separated pairs never become gateway addresses',()=>{
 for(const pair of [['7208173663','7208177007'],['4708196730','4045731858']])for(const separator of ['', '/', '\\', ';', ',', '|', ' ', '\n', ' or '])assert.equal(context.format(pair.join(separator)),null);
});
test('short, long, foreign-prefix, extension and empty entries are rejected',()=>{
 for(const value of [null,undefined,'',0,'123','720817366','27208173663','172081736630','7208173663 ext 12','7208173663 x2','7208173663@textbetter.com'])assert.equal(context.format(value),null);
});
test('actual group batching skips bad phones and deduplicates valid recipients',()=>{
 const elements=new Map();const $=id=>{if(!elements.has(id))elements.set(id,{textContent:'',classList:{add(){},remove(){}}});return elements.get(id);};
 const ctx=vm.createContext({$,filterNeverTextRecipients:members=>({allowed:members.filter(r=>r.rating!=='DNU'),blocked:members.filter(r=>r.rating==='DNU')}),GROUP_BATCH_SIZE:50,renderGroupTextProgress(){}});
 vm.runInContext('let groupTextState;'+lift('formatTextAddress')+lift('formatTextAddresses')+lift('expandTextRecipients')+lift('beginTextBatchFlow')+';this.start=beginTextBatchFlow;this.state=()=>groupTextState;',ctx);
 ctx.start([{name:'bad1',phone:'72081736637208177007'},{name:'bad2',phone:'4708196730 / invalid'},{name:'valid',phone:'(720) 817-3663'},{name:'shared',phone:'17208173663'},{name:'blocked',phone:'4045731858',rating:'DNU'}],'test','sandbox only');
 const state=ctx.state();assert.equal(state.skipped.length,2);assert.equal(state.deduped.length,1);assert.equal(state.blocked.length,1);assert.equal(state.batches[0].length,1);assert.equal(state.batches[0][0].name,'valid');
});

test('explicit number lists become separate country-coded recipients for both send paths',()=>{
 const ctx=vm.createContext({});vm.runInContext(lift('formatTextAddress')+lift('formatTextAddresses')+lift('expandTextRecipients')+';this.expand=expandTextRecipients;',ctx);
 for(const separator of ['/', '\\', ';', ',', '|']) {
  const result=ctx.expand([{name:'Dispatcher',rating:'B',phone:'720-817-3663'+separator+'720-817-7007'}]);
  assert.deepEqual(Array.from(result,r=>r.phone),['17208173663','17208177007']);
  assert.ok(result.every(r=>r.name==='Dispatcher' && r.rating==='B'));
 }
 assert.ok(source.includes('filterNeverTextRecipients(expandTextRecipients(recipients), { allowDnu })'));
 assert.ok(source.includes('filterNeverTextRecipients(expandTextRecipients(members), { allowDnu })'));
});

test('actual automatic payload and Outlook draft retain separate endpoints',async()=>{
 const calls=[];const elements=new Map();const $=id=>{if(!elements.has(id))elements.set(id,{textContent:'',classList:{add(){},remove(){}}});return elements.get(id);};
 const ctx=vm.createContext({$,GROUP_BATCH_SIZE:50,SUPABASE_URL:'https://sandbox.invalid',console,filterNeverTextRecipients:allowed=>({allowed,blocked:[]}),renderGroupTextProgress(){},setGroupFooter(){},openMailDraft:(addresses)=>calls.push(Array.from(addresses)),fetch:async(url,options)=>{calls.push(JSON.parse(options.body).phones);return {ok:true,json:async()=>({})};}});
 vm.runInContext('let groupTextState;'+['formatTextAddress','formatTextAddresses','expandTextRecipients','beginTextBatchFlow','sendCurrentGroupBatchDirect','openCurrentGroupBatch'].map(lift).join('\n')+';this.start=beginTextBatchFlow;this.send=sendCurrentGroupBatchDirect;this.outlook=openCurrentGroupBatch;',ctx);
 const members=[{name:'A',phone:'720-817-3663/720-817-7007'},{name:'B',phone:'470-819-6730 / 404-573-1858'}];
 ctx.start(members,'test','sandbox only');await ctx.send();assert.deepEqual(calls[0],['17208173663','17208177007','14708196730','14045731858']);
 ctx.start(members,'test','sandbox only');ctx.outlook();assert.deepEqual(calls[1],calls[0].map(phone=>phone+'@textbetter.com'));
});
