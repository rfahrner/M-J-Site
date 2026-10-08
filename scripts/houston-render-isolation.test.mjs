import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {execFileSync} from 'node:child_process';
const fixed=fs.readFileSync('loadboard.js','utf8'),houston=fs.readFileSync('houston.js','utf8');
const baseline=execFileSync('git',['show','041d51a:loadboard.js'],{encoding:'utf8',maxBuffer:2000000});
function lift(source,name){const m=new RegExp('^([ \\t]*)(?:export )?(?:async )?function '+name+'\\(','m').exec(source);assert.ok(m,name);return source.slice(m.index,source.indexOf('\n'+m[1]+'}',m.index)+m[1].length+2).replace('export ','');}
function binding(source){const start=source.indexOf('    if ($("#modal-add-time-slots")');return source.slice(start,source.indexOf('\n    }',start)+6);}
async function slots(source){
 const handlers=new Map(),saved=[],flat=[],standard=[];let layout='Houston';
 const slot={querySelector:selector=>({value:selector==='[data-ats-time]'?'2030':'7'})};
 const ctx=vm.createContext({state:{activeLocation:'houston',activeDate:'2026-10-08'},currentFile:()=> 'houston.html',$:()=>({classList:{add(){}},addEventListener(){}}),$all:()=>[slot],on:(id,event,cb)=>handlers.set(id,[...(handlers.get(id)||[]),cb]),
  blankRow:()=>({}),blankHoustonRow:()=>({}),getSheet:()=>standard,getHoustonSheet:()=>flat,
  renderBoardTable:()=>{layout='Kroger';},renderHoustonBoardTable:()=>{layout='Houston';},saveShiftNow:async r=>{saved.push(r);r.dbId=saved.length;},setDriverSyncStatus(){},scrollQuickAddIntoView(){},warnAboutUnsavedRows(){},addTimeSlotRowUI(){},addHoustonTimeSlotRowUI(){},closeAddTimeSlotsModal(){},closeAddHoustonTimeSlotsModal(){}});
 vm.runInContext(lift(source,'submitAddTimeSlots')+lift(houston,'submitAddHoustonTimeSlots')+binding(source)+binding(houston),ctx);
 await Promise.all((handlers.get('ats-submit')||[]).map(fn=>fn()));
 return {count:handlers.get('ats-submit').length,saved,flat,standard,layout};
}
test('baseline reproduces two slot handlers and writes Houston slots into standard shifts',async()=>{
 const result=await slots(baseline);assert.equal(result.count,2);assert.equal(result.saved.length,7);assert.equal(result.standard.length,7);assert.equal(result.flat.length,7);assert.equal(result.layout,'Kroger');
});
test('Houston slots use only Houston handler and never write standard shifts',async()=>{
 const result=await slots(fixed);assert.equal(result.count,1);assert.equal(result.saved.length,0);assert.equal(result.standard.length,0);assert.equal(result.flat.length,7);assert.equal(result.layout,'Houston');
});
test('shared redraw delegates to Houston instead of replacing its columns',()=>{
 let redraws=0;const ctx=vm.createContext({state:{activeLocation:'houston'},renderHoustonBoardTable:()=>redraws++});
 vm.runInContext(lift(fixed,'renderBoardTable')+';renderBoardTable();',ctx);assert.equal(redraws,1);
});
test('generic slot submission defensively refuses a Houston page',async()=>{
 const ctx=vm.createContext({state:{activeLocation:'houston'}});await vm.runInContext(lift(fixed,'submitAddTimeSlots')+';submitAddTimeSlots();',ctx);
});
