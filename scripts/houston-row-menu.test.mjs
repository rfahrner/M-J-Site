import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import {JSDOM} from 'jsdom';
import {PGlite} from '@electric-sql/pglite';
const source=fs.readFileSync('houston.js','utf8');
const migration=fs.readFileSync('supabase/migrations/20261016154725_houston_row_cancellations.sql','utf8');
function lift(name){const match=new RegExp('^([ \t]*)(?:export )?(?:async )?function '+name+'\\(','m').exec(source);assert.ok(match,name);const end=source.indexOf('\n'+match[1]+'}',match.index);return source.slice(match.index,end+match[1].length+2).replace('export ','');}
function fixture(){
 const dom=new JSDOM('<div id="houston-table"></div>',{runScripts:'outside-only',url:'https://sandbox.invalid/'});
 const row={id:'hou_1',dbId:41,shiftDate:'2026-10-02',aljexNumber:'<img src=x onerror=alert(1)>',driverName:'Test Driver',normalRate:'600',comments:'Keep my comments',calledOff:false,loadCancelled:false};
 const tomorrow={...row,id:'hou_2',dbId:42,shiftDate:'2026-10-03',aljexNumber:'2012345'};
 const cache={'2026-10-02':[row],'2026-10-03':[tomorrow]}; const writes=[];let fail=false;
 const ctx=dom.getInternalVMContext();
 Object.assign(ctx,{state:{activeDate:'2026-10-02'},houstonState:{sheets:cache},
   HOUSTON_TABLE:'loads_houston',dirtyHoustonFields:new Map(),houstonSaveTimers:{},
   runScheduledCellSave:async(key,fn)=>fn(),uid:()=> 'fresh',renderHoustonBoardTable:()=>{},setDriverSyncStatus:()=>{},confirm:()=>true,
   escapeHtml:s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'),
   $all:(s,p)=>p.querySelectorAll(s),closeContextMenu:()=>dom.window.document.getElementById('row-context-menu')?.remove(),
   markFieldDirty:(map,id,key)=>{if(!map.has(id))map.set(id,new Set());map.get(id).add(key);},
   saveHoustonRowNow:async r=>{writes.push({id:r.dbId,date:r.shiftDate,calledOff:r.calledOff,loadCancelled:r.loadCancelled,reason:r.calledOffReason||r.loadCancelledReason,comments:r.comments,normalRate:r.normalRate});return fail?null:r.dbId;},
   supabaseClient:{from:()=>({delete:()=>({eq:(_,id)=>({select:()=>({single:async()=>{writes.push({delete:id});return {data:fail?null:{id},error:fail?{message:'Sandbox failure'}:null};}})})})})}
 });
 for(const n of ['findHoustonRowAnywhere','getHoustonSheet','houstonRowToDbRow','houstonRowFromDbRow','openHoustonRowContextMenu','saveHoustonCancellation','openHoustonCancellation','deleteHoustonRow'])vm.runInContext(lift(n),ctx);
 ctx.toggleHoustonTonu=id=>{row.tonu=!row.tonu;writes.push({tonu:id});};
 ctx.toggleHoustonShiftComplete=id=>{row.shiftComplete=!row.shiftComplete;writes.push({complete:id});};
 const menu=id=>{ctx.openHoustonRowContextMenu(id,10,10);return [...dom.window.document.querySelectorAll('#row-context-menu button')];};
 return {dom,ctx,row,tomorrow,cache,writes,menu,setFail:v=>fail=v};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
test('actual row menu matches Atlanta order, labels, styles and escaped load number',()=>{
 const f=fixture();try{
  const b=f.menu(f.row.id);assert.deepEqual(b.map(x=>x.textContent),['TONU','Cancellation - driver fall off','Kroger cancelled shift - non-TONU','Shift Complete','Delete entire load <img src=x onerror=alert(1)>']);
  assert.ok(b[3].classList.contains('context-menu-item-success'));assert.ok(b[4].classList.contains('context-menu-item-danger'));assert.equal(f.dom.window.document.querySelector('#row-context-menu img'),null);
  b[0].click();assert.equal(f.row.tonu,true);assert.equal(f.dom.window.document.getElementById('row-context-menu'),null);
  f.menu(f.row.id)[3].click();assert.equal(f.row.shiftComplete,true);
  assert.equal(f.menu(f.row.id)[3].textContent,'Mark Shift Incomplete');
 }finally{f.dom.window.close();}
});
test('reason modal, cancellation and undo target the owning date in night view; comments/rates survive',async()=>{
 const f=fixture();try{
  f.menu(f.tomorrow.id)[2].click();let overlay=f.dom.window.document.getElementById('hou-cancellation-overlay');
  overlay.querySelector('[data-save]').click();assert.equal(f.writes.length,0);assert.match(overlay.textContent,/Enter the cancellation reason/);
  overlay.querySelector('textarea').value='Customer cancelled';overlay.querySelector('[data-save]').click();await settle();
  assert.equal(f.tomorrow.loadCancelled,true);assert.deepEqual(f.writes[0],{id:42,date:'2026-10-03',calledOff:false,loadCancelled:true,reason:'Customer cancelled',comments:'Keep my comments',normalRate:'600'});
  assert.equal(f.dom.window.document.getElementById('hou-cancellation-overlay'),null);assert.equal(f.row.loadCancelled,false);
  f.menu(f.tomorrow.id)[2].click();await settle();assert.equal(f.tomorrow.loadCancelled,false);assert.equal(f.tomorrow.loadCancelledReason,'');
  const payload=f.ctx.houstonRowToDbRow(f.tomorrow,f.tomorrow.shiftDate);assert.equal(payload.load_cancelled,false);assert.equal(payload.shift_date,'2026-10-03');
  const reloaded=f.ctx.houstonRowFromDbRow({...payload,id:42,called_off:true,called_off_reason:'Breakdown'});assert.equal(reloaded.calledOff,true);assert.equal(reloaded.calledOffReason,'Breakdown');
 }finally{f.dom.window.close();}
});
test('failed cancellation and deletion leave the load present and allow retry; confirmed delete removes only owner-day row',async()=>{
 const f=fixture();try{
  f.setFail(true);f.menu(f.tomorrow.id)[1].click();let overlay=f.dom.window.document.getElementById('hou-cancellation-overlay');overlay.querySelector('textarea').value='Breakdown';overlay.querySelector('[data-save]').click();await settle();
  assert.equal(f.tomorrow.calledOff,false);assert.equal(overlay.querySelector('[data-save]').disabled,false);assert.match(overlay.textContent,/not saved/);
  await f.ctx.deleteHoustonRow(f.tomorrow.id);assert.equal(f.cache['2026-10-03'].length,1);
  f.setFail(false);overlay.querySelector('[data-save]').click();await settle();assert.equal(f.tomorrow.calledOff,true);
  f.ctx.confirm=()=>false;await f.ctx.deleteHoustonRow(f.tomorrow.id);assert.equal(f.cache['2026-10-03'].length,1);
  f.ctx.confirm=()=>true;await f.ctx.deleteHoustonRow(f.tomorrow.id);assert.equal(f.cache['2026-10-03'].length,0);assert.equal(f.cache['2026-10-02'].length,1);
 }finally{f.dom.window.close();}
});
async function database(){
 const db=new PGlite();await db.exec(`create role anon;create role authenticated;create schema app_private;create schema auth;
 create function auth.jwt() returns jsonb language sql as $$select '{"email":"sandbox@example.invalid"}'::jsonb$$;
 create table public.loads_houston(id bigint primary key,shift_date date,aljex_number text,driver_id bigint,driver_name text,time text,normal_rate numeric,sent_to_accounting boolean default false);
 create table public.loads_accounting(id bigint generated always as identity primary key,source_houston_id bigint unique references loads_houston(id) on delete set null,location text,shift_date date,aljex_load_number text,driver_id bigint,driver_name_text text,cost_level int,revenue_level int,status text default 'active',cancelled_reason text,total_carrier_pay numeric,total_cost numeric,total_revenue numeric,fsc_payment numeric,total_miles numeric,total_stops numeric,carrier_pay_manual boolean default false,revenue_manual boolean default false,sent boolean default false,deleted_at timestamptz);
 create table public.driver_notes(id bigint generated always as identity primary key,driver_id bigint,note_text text,created_by text,note_type text,source_shift_id bigint,source_shift_date date,source_shift_start text,source_load_label text);
 create table public.houston_change_history(id bigint generated always as identity primary key,houston_load_id bigint,field_name text,old_value text,new_value text,changed_by text,note text);`);
 await db.exec(`alter table loads_houston add updated_at timestamptz,add carrier text,add mc text,add rating text,add driver_phone text,add dispatcher_phone text,add ttc text,add ttt text,add comments text,add time_out_remarks text,add tonu boolean,add highlighted boolean,add shift_complete boolean,add route_image_path text;
 alter table loads_accounting add updated_at timestamptz,add pushed_at timestamptz,add source_shift_id bigint,add source_mondelez_id bigint,add hidden boolean default false,add fsc_rate_snapshot numeric;
 create table mondelez_loads(id bigint primary key,called_off boolean,load_cancelled boolean,called_off_reason text,load_cancelled_reason text);
 create table loads_shifts(id bigint primary key,carrier_rate numeric);
 create table atlanta_drivers(id bigint primary key,"Driver Name" text);
 create table pricing_settings(key text,value numeric);insert into pricing_settings values('fsc_rate',3);
 `);
 await db.exec(fs.readFileSync('sandbox/houston-row-menu-triggers.sql','utf8'));
 await db.exec(migration);return db;
}
test('actual migration: cancel, zero Accounting, one driver note, preserve manual rates, undo exactly, retry and both flags',async()=>{
 const db=await database();try{
  await db.exec(`insert into loads_houston(id,shift_date,aljex_number,driver_id,driver_name,time,normal_rate) values(41,'2026-10-02','2012345',7,'Test Driver','09:00',600);
  insert into loads_accounting(source_houston_id,location,status,total_carrier_pay,total_cost,total_revenue,fsc_payment,total_miles,total_stops,carrier_pay_manual,revenue_manual) values(41,'houston','active',777,789,999,10,200,4,true,true);update loads_accounting set total_carrier_pay=777;update loads_accounting set total_cost=789`);
  const before=(await db.query('select * from loads_accounting')).rows[0];
  await db.exec("update loads_houston set called_off=true,called_off_reason='Breakdown',called_off_at=now() where id=41");
  let a=(await db.query('select * from loads_accounting')).rows[0];assert.equal(a.status,'cancelled');for(const k of ['total_carrier_pay','total_cost','total_revenue','fsc_payment','total_miles','total_stops'])assert.equal(Number(a[k]),0,k);
  const notes=(await db.query('select * from driver_notes')).rows;assert.equal(notes.length,1);assert.equal(notes[0].source_shift_id,null);assert.equal(notes[0].source_shift_date.toISOString().slice(0,10),'2026-10-02');assert.equal(notes[0].source_shift_start,'09:00');assert.equal(notes[0].source_load_label,'2012345');
  assert.equal(Number((await db.query('select normal_rate from loads_houston')).rows[0].normal_rate),600);
  await db.exec("update loads_houston set called_off=true,called_off_reason='Breakdown' where id=41;update loads_accounting set total_revenue=12345,status='active' where source_houston_id=41");
  assert.equal((await db.query('select count(*)::int n from driver_notes')).rows[0].n,1);assert.equal(Number((await db.query('select total_revenue from loads_accounting')).rows[0].total_revenue),0);
  await db.exec("update loads_houston set load_cancelled=true,load_cancelled_reason='Customer cancelled' where id=41;update loads_houston set called_off=false,called_off_reason=null where id=41");
  assert.equal((await db.query('select status from loads_accounting')).rows[0].status,'cancelled');
  await db.exec("update loads_houston set load_cancelled=false,load_cancelled_reason=null where id=41");
  a=(await db.query('select * from loads_accounting')).rows[0];assert.deepEqual({...a,updated_at:null},{...before,updated_at:null});
  assert.equal((await db.query('select count(*)::int n from app_private.houston_cancellation_backup')).rows[0].n,0);
 }finally{await db.close();}
});
test('cancel before overnight push, guard sweep writes, require reason, reject settled records atomically, source namespaces independent',async()=>{
 const db=await database();try{
  await db.exec("insert into loads_houston(id,shift_date,aljex_number,driver_id,called_off,called_off_reason) values(42,'2026-10-03','2016789',8,true,'No show')");
  assert.equal((await db.query('select status from loads_accounting')).rows[0].status,'cancelled');
  await db.exec('delete from loads_accounting;insert into loads_accounting(source_houston_id,status,total_carrier_pay) values(42,\'active\',900)');
  assert.equal((await db.query('select status from loads_accounting')).rows[0].status,'cancelled');assert.equal(Number((await db.query('select total_carrier_pay from loads_accounting')).rows[0].total_carrier_pay),0);
  await db.exec('update loads_houston set sent_to_accounting=true where id=42;update loads_houston set called_off=false,called_off_reason=null where id=42');assert.equal((await db.query('select sent_to_accounting from loads_houston where id=42')).rows[0].sent_to_accounting,false);assert.equal((await db.query('select count(*)::int n from loads_accounting')).rows[0].n,0);
  await assert.rejects(db.exec('update loads_houston set load_cancelled=true where id=42'),/reason is required/);assert.equal((await db.query('select load_cancelled from loads_houston')).rows[0].load_cancelled,false);
  await db.exec("insert into loads_accounting(source_houston_id,location,status,total_carrier_pay) values(42,'houston','released',600);insert into loads_accounting(location,status,total_carrier_pay) values('atlanta','active',450)");
  await assert.rejects(db.exec("update loads_houston set load_cancelled=true,load_cancelled_reason='Cancelled' where id=42"),/released/);
  assert.equal((await db.query('select load_cancelled from loads_houston')).rows[0].load_cancelled,false);assert.equal((await db.query("select total_carrier_pay from loads_accounting where location='atlanta'")).rows[0].total_carrier_pay,'450');
  const security=(await db.query("select has_function_privilege('anon','app_private.record_houston_cancellation()','EXECUTE') callable,has_table_privilege('authenticated','app_private.houston_cancellation_backup','INSERT') writable")).rows[0];assert.equal(security.callable,false);assert.equal(security.writable,false);
 }finally{await db.close();}
});

test('dispatcher updates source through RLS; trigger can write Accounting, while backup and trigger APIs stay private',async()=>{
 const db=await database();try{
  await db.exec(`insert into loads_houston(id,shift_date,aljex_number) values(50,'2026-10-02','2019999');
   alter table loads_houston enable row level security;
   create policy fixture_dispatcher on loads_houston for all to authenticated using(id=50) with check(id=50);
   grant usage on schema public,auth to authenticated;grant select,update on loads_houston to authenticated;grant insert on houston_change_history to authenticated;grant usage on all sequences in schema public to authenticated;
   set role authenticated;
   update loads_houston set load_cancelled=true,load_cancelled_reason='Cancelled' where id=50;reset role;`);
  assert.equal((await db.query('select status from loads_accounting where source_houston_id=50')).rows[0].status,'cancelled');
  await db.exec('set role authenticated');await assert.rejects(db.exec('select * from app_private.houston_cancellation_backup'),/permission denied/);await db.exec('reset role');
 }finally{await db.close();}
});

test('delete keeps Accounting audit record but removes it from active totals, including cancelled loads',async()=>{
 const db=await database();try{
  await db.exec("insert into loads_houston(id,shift_date,aljex_number,load_cancelled,load_cancelled_reason) values(70,'2026-10-02','DELETE',true,'Cancelled');delete from loads_houston where id=70");
  const a=(await db.query('select * from loads_accounting')).rows[0];assert.equal(a.status,'deleted');assert.ok(a.deleted_at);assert.equal(a.source_houston_id,null);
 }finally{await db.close();}
});

test('sent and Accounting-removed loads reject cancellation without changing money or history',async()=>{
 const db=await database();try{
  await db.exec("insert into loads_houston(id,normal_rate) values(80,600),(81,700);insert into loads_accounting(source_houston_id,location,sent,total_revenue) values(80,'houston',true,900);insert into loads_accounting(source_houston_id,location,hidden,total_revenue) values(81,'houston',true,1000)");
  const before=(await db.query('select * from loads_accounting order by id')).rows;
  for(const id of [80,81])await assert.rejects(db.exec(`update loads_houston set called_off=true,called_off_reason='No show' where id=${id}`),/sent, released or deleted/);
  assert.deepEqual((await db.query('select * from loads_accounting order by id')).rows,before);
  assert.equal((await db.query('select count(*)::int n from houston_change_history')).rows[0].n,0);
 }finally{await db.close();}
});

test('deletion waits for an in-flight insert and prevents any queued save from resurrecting it',async()=>{
 const f=fixture();try{
  let finishInsert;const gate=new Promise(resolve=>finishInsert=resolve);
  const lb=fs.readFileSync('loadboard.js','utf8');const start=lb.indexOf('  export async function runScheduledCellSave('),end=lb.indexOf('\n  }',start)+4;
  vm.runInContext('const scheduledCellSaves=new Map();'+lb.slice(start,end).replace('export ',''),f.ctx);
  vm.runInContext(lift('persistHoustonRow'),f.ctx);
  f.tomorrow.dbId=null;
  const insert=f.ctx.runScheduledCellSave('houston:'+f.tomorrow.id,async()=>{await gate;f.tomorrow.dbId=42;});
  const deletion=f.ctx.deleteHoustonRow(f.tomorrow.id);await settle();assert.equal(f.writes.length,0);
  finishInsert();await insert;await deletion;
  assert.deepEqual(f.writes,[{delete:42}]);assert.equal(f.tomorrow.deleted,true);
  assert.equal(await f.ctx.persistHoustonRow(f.tomorrow),null);assert.equal(f.cache['2026-10-03'].length,0);
 }finally{f.dom.window.close();}
});

test('cancelled Houston loads keep their source rate and do not produce pre-shift text alerts',async()=>{
 const rates=fs.readFileSync('daily-rate-hierarchy.js','utf8');const start=rates.indexOf('function recalcHoustonRow('),end=rates.indexOf('\n}',start)+2;
 const ctx=vm.createContext({});vm.runInContext(rates.slice(start,end),ctx);
 for(const field of ['calledOff','loadCancelled']){const row={normalRate:'600',[field]:true};ctx.recalcHoustonRow(row);assert.equal(row.normalRate,'600');}
 const texts=fs.readFileSync('preshift-pro-text.js','utf8');const a=texts.indexOf('async function houstonPreShiftAlerts('),b=texts.indexOf('\n}',a)+2;
 const rows=[{id:1,time:'09:00',driver_phone:'5551234567'},{id:2,time:'09:00',driver_phone:'5551234567',called_off:true},{id:3,time:'09:00',driver_phone:'5551234567',load_cancelled:true}];
 const q={select:()=>q,eq:()=>q,is:async()=>({data:rows,error:null})};
 Object.assign(ctx,{currentLocation:()=> 'houston',supabaseClient:{from:()=>q},todayKey:()=> '2026-10-02',nowMinutes:()=>500,parseHHMM:()=>540,clean:v=>String(v||''),extraAlertHtml:x=>x,clockLabel:x=>x,esc:x=>x});
 vm.runInContext(texts.slice(a,b),ctx);const alerts=await ctx.houstonPreShiftAlerts();assert.equal(alerts.length,1);assert.match(alerts[0].html.buttonAttrs,/id="1"/);
});
