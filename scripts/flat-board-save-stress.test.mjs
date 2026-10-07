import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import {execFileSync} from 'node:child_process';
const read=p=>process.env.MJ_STRESS_BASELINE?execFileSync('git',['show',`2296822:${p}`],{encoding:'utf8',maxBuffer:2000000}):fs.readFileSync(p,'utf8');
function lift(src,name){const m=new RegExp(`^([ \\t]*)(?:export )?(?:async )?function ${name}\\(`,'m').exec(src);if(!m)throw Error(name);const end=src.indexOf(`\n${m[1]}}`,m.index);return src.slice(m.index,end+m[1].length+2).replace(/export /g,'');}
function harness(board){
 const src=read(board+'.js'),shared=read('loadboard.js'),cap=board==='mondelez'?'Mondelez':'Houston';
 const functions=[`${board}RowToDbRow`,`save${cap}RowNow`];
 if(src.includes(`function persist${cap}Row(`))functions.push(`persist${cap}Row`);
 const guards=[...(shared.includes('function dirtyFieldsToDbPatch(')?['dirtyFieldsToDbPatch']:[]),'markFieldDirty','snapshotDirtyFields','confirmDirtyFieldsSaved','runScheduledCellSave','dbFieldsSafeToApply'];
 const db=[],waiting=[],errors=[];let seq=0;const faults={fail:false};
 const client={from:()=>({insert:payload=>({select:()=>new Promise(resolve=>{waiting.push(()=>{const r={id:++seq,...payload};db.push(r);resolve({data:[r],error:null});});})}),update:payload=>({eq:(_,id)=>new Promise(resolve=>waiting.push(()=>{if(faults.fail){resolve({error:{message:"offline"}});return;}Object.assign(db.find(r=>r.id===id),payload);resolve({error:null});}))})})};
 const ctx=vm.createContext({supabaseClient:client,state:{activeDate:'2026-10-07'},console:{error(){},warn(){}},setDriverSyncStatus:m=>errors.push(m)});
 vm.runInContext(`const MONDELEZ_TABLE='m',HOUSTON_TABLE='h',dirtyMondelezFields=new Map(),dirtyHoustonFields=new Map(),scheduledCellSaves=new Map();${guards.map(n=>lift(shared,n)).join('\n')}\n${functions.map(n=>lift(src,n)).join('\n')}\nthis.save=save${cap}RowNow;this.mark=(row,field)=>markFieldDirty(dirty${cap}Fields,row.id,field);this.merge=(row,fresh)=>Object.assign(row,dbFieldsSafeToApply(fresh,dirty${cap}Fields,row.id,null));`,ctx);
 return {ctx,db,waiting,errors,faults,flush:async()=>{for(let i=0;i<10;i++){await Promise.resolve();if(waiting.length)waiting.shift()();}}};
}
for(const board of ['mondelez','houston'])test(board+' overlapping direct saves insert once and keep newer values',async()=>{
 const h=harness(board),r={id:'local',dbId:null,shiftDate:'2026-10-02',notes:'first',comments:'first'};
 const first=h.ctx.save(r);await Promise.resolve();r.notes=r.comments='second';const second=h.ctx.save(r);
 await h.flush();await Promise.all([first,second]);
 assert.equal(h.db.length,1,'one local row must create only one database row');assert.equal(h.db[0].shift_date,'2026-10-02');assert.equal(h.db[0][board==='mondelez'?'notes':'comments'],'second');
});
test('a rejected queued task does not cancel subsequent saves',async()=>{
 const shared=read('loadboard.js'),ctx=vm.createContext({});vm.runInContext(`const scheduledCellSaves=new Map();${lift(shared,'runScheduledCellSave')}this.run=runScheduledCellSave;`,ctx);
 const first=ctx.run('same',()=>Promise.reject(Error('offline')));const second=ctx.run('same',()=>42);
 await assert.rejects(first);assert.equal(await second,42);
});

for(const board of ['mondelez','houston'])test(board+' driver picker preserves name and identity against a stale echo',()=>{
 const h=harness(board),src=read(board+'.js'),isM=board==='mondelez';
 const row={id:'local',dbId:1,driverName:'Old Driver',driverId:'1'};h.ctx.fixtureRow=row;
 const block=isM?src.match(/  table.addEventListener\("focusin", \(e\) => \{[^]*?\n  \}\);/)[0]:src.match(/    boardTable.addEventListener\("focusin", \(e\) => \{[^]*?\n    \}\);/)[0];
 vm.runInContext(`const table={addEventListener:(_,cb)=>this.pickDriver=cb},boardTable=table;
 const getMondelezRowsForDate=()=>[fixtureRow],findHoustonRowAnywhere=()=>({row:fixtureRow});
 const acknowledgeDnuAssignment=()=>{},updateMondelezMcCell=()=>{};
 const document={getElementById:()=>null};
 const openDriverAutocomplete=(_,loc,cb)=>cb({id:'2',name:'New Driver'});
 const scheduleMondelezRowSave=()=>{},scheduleHoustonRowSave=()=>{};
 ${block}`,h.ctx);
 h.ctx.pickDriver({target:{dataset:isM?{mdzRow:'local',driverAc:'true'}:{row:'local',driverAc:'true'}}});
 h.ctx.merge(row,{driverName:'Old Driver',driverId:'1'});
 assert.equal(row.driverName,'New Driver');assert.equal(row.driverId,'2');
});
for(const board of ['mondelez','houston'])test(board+' failed update returns no success ID and keeps unsaved work',async()=>{
 const h=harness(board),row={id:'local',dbId:null,shiftDate:'2026-10-02',notes:'first',comments:'first'};
 let request=h.ctx.save(row);await h.flush();await request;
 row.notes=row.comments='unsaved';h.ctx.mark(row,board==='mondelez'?'notes':'comments');h.faults.fail=true;
 request=h.ctx.save(row);await h.flush();assert.equal(await request,null);
 h.ctx.merge(row,{notes:'first',comments:'first'});assert.equal(row[board==='mondelez'?'notes':'comments'],'unsaved');assert.ok(h.errors.length);
});
for(const board of ['mondelez','houston'])test(board+' modal changes survive a stale echo before its queued save',async()=>{
 const h=harness(board),cap=board==='mondelez'?'Mondelez':'Houston',isM=board==='mondelez';
 const row={id:'local',dbId:1,shiftDate:'2026-10-02',location:'addison',notes:'old',comments:'old',driverName:'',driverId:null};h.ctx.fixtureRow=row;h.db.push({id:1});
 vm.runInContext(`let mdzLoadDetailsRowId='local',houstonLdRowId='local';
 const getMondelezRowsForDate=()=>[fixtureRow],findHoustonRowAnywhere=()=>({row:fixtureRow});
 const driversForLocation=()=>[],findDriver=()=>null,acknowledgeDnuAssignment=()=>{};
 const $=id=>id==='${isM?'#mdz-ld-notes':'#hou-ld-comments'}'?{value:'Keep modal notes'}:null;
 const closeMondelezLoadDetailsModal=()=>{},closeHoustonLoadDetailsModal=()=>{};
 const renderMondelezTable=()=>{},renderHoustonBoardTable=()=>{};
 ${lift(read(board+'.js'),'save'+cap+'LoadDetailsModal')}
 this.submit=save${cap}LoadDetailsModal;`,h.ctx);
 h.ctx.submit();h.ctx.merge(row,{notes:'old',comments:'old'});
 assert.equal(row[isM?'notes':'comments'],'Keep modal notes');await h.flush();assert.equal(h.db[0][isM?'notes':'comments'],'Keep modal notes');
});
for(const board of ['mondelez','houston'])test(board+' two dispatchers editing different cells do not overwrite each other',async()=>{
 const h=harness(board),notes=board==='mondelez'?'notes':'comments',time=board==='mondelez'?'startTime':'time',dbTime=board==='mondelez'?'start_time':'time';
 h.db.push({id:1,[notes]:'old notes',[dbTime]:'09:00'});
 const a={id:'tab-a',dbId:1,shiftDate:'2026-10-02',[notes]:'new notes',[time]:'09:00'};
 const b={id:'tab-b',dbId:1,shiftDate:'2026-10-02',[notes]:'old notes',[time]:'10:30'};
 h.ctx.mark(a,notes);h.ctx.mark(b,time);
 const saves=[h.ctx.save(a),h.ctx.save(b)];await h.flush();await Promise.all(saves);
 assert.equal(h.db[0][notes],'new notes');assert.equal(h.db[0][dbTime],'10:30');
});
test('200 queued saves across five rows stay ordered and recover after 12 failures',async()=>{
 const ctx=vm.createContext({});vm.runInContext(`const scheduledCellSaves=new Map();${lift(read('loadboard.js'),'runScheduledCellSave')}this.run=runScheduledCellSave;`,ctx);
 const active=new Map(),finished=new Map();let overlaps=0;
 const jobs=Array.from({length:200},(_,i)=>{const key='row-'+(i%5);return ctx.run(key,async()=>{
  if(active.get(key))overlaps++;active.set(key,true);
  try{await Promise.resolve();if(i%17===0)throw Error('simulated failure');
   const prior=finished.get(key)??-1;assert.ok(i>prior);finished.set(key,i);return i;
  }finally{active.set(key,false);}
 });});
 const results=await Promise.allSettled(jobs);assert.equal(overlaps,0);assert.equal(results.filter(r=>r.status==='fulfilled').length,188);assert.equal(finished.size,5);
});
test('changed-column payloads preserve zero, intentional clears, acronyms and rate aliases',()=>{
 const ctx=vm.createContext({});vm.runInContext(`${lift(read('loadboard.js'),'dirtyFieldsToDbPatch')}this.patch=dirtyFieldsToDbPatch;`,ctx);
 const payload={notes:null,return_to_dc:'12:00',route_miles:0,carrier_rate:325,route_image_path:'image.jpg',dispatch_time:'old'};
 const patch=ctx.patch(payload,[['notes',''],['returnToDC','12:00'],['routeMiles','0'],['rate','325'],['routeImagePaths',['image.jpg']]],{rate:'carrier_rate',routeImagePaths:'route_image_path'});
 assert.deepEqual(JSON.parse(JSON.stringify(patch)),{notes:null,return_to_dc:'12:00',route_miles:0,carrier_rate:325,route_image_path:'image.jpg'});
 assert.deepEqual(JSON.parse(JSON.stringify(ctx.patch({notes:'keep'},[['routeMiles','invalid']]))),{});
});
