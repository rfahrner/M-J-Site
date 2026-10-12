import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import {JSDOM} from 'jsdom';
import {PGlite} from '@electric-sql/pglite';
const source=fs.readFileSync('mondelez.js','utf8');
const migration=fs.readFileSync('supabase/migrations/20261012223012_mondelez_row_cancellations.sql','utf8');
function lift(name){const start=source.search(new RegExp(`(?:async )?function ${name}\\(`));const end=source.indexOf('\n}',start);assert.ok(start>=0&&end>start,name);return source.slice(start,end+2);}
function fixture(){
 const dom=new JSDOM('<div id="mondelez-table"></div>',{runScripts:'outside-only',url:'https://sandbox.invalid/'});
 const row={id:'mdz_1',dbId:41,shiftDate:'2026-10-02',location:'morris',aljexNumber:'<img src=x onerror=alert(1)>',driverName:'Test Driver',carrierPay:'600',revenueTotal:'950',notes:'Keep my notes',calledOff:false,loadCancelled:false};
 const tomorrow={...row,id:'mdz_2',dbId:42,shiftDate:'2026-10-03',aljexNumber:'2012345'};
 const cache={'2026-10-02':[row],'2026-10-03':[tomorrow]}; const writes=[];let fail=false;
 const ctx=dom.getInternalVMContext();
 Object.assign(ctx,{state:{activeDate:'2026-10-02'},mondelezState:{rowsByDate:cache,activeTab:'combined'},
   MONDELEZ_TABLE:'mondelez_loads',dirtyMondelezFields:new Map(),mondelezSaveTimers:new Map(),
   uid:()=> 'fresh',renderMondelezTable:()=>{},setDriverSyncStatus:()=>{},confirm:()=>true,
   escapeHtml:s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'),
   $all:(s,p)=>p.querySelectorAll(s),closeContextMenu:()=>dom.window.document.getElementById('row-context-menu')?.remove(),
   markFieldDirty:(map,id,key)=>{if(!map.has(id))map.set(id,new Set());map.get(id).add(key);},
   saveMondelezRowNow:async r=>{writes.push({id:r.dbId,date:r.shiftDate,calledOff:r.calledOff,loadCancelled:r.loadCancelled,reason:r.calledOffReason||r.loadCancelledReason,notes:r.notes,carrierPay:r.carrierPay});return fail?null:r.dbId;},
   supabaseClient:{from:()=>({delete:()=>({eq:async(_,id)=>{writes.push({delete:id});return {error:fail?{message:'Sandbox failure'}:null};}})})}
 });
 for(const n of ['findMondelezRowAnywhere','mondelezRowById','mondelezRowToDbRow','parseMondelezImagePaths','mondelezRowFromDbRow','openMondelezRowContextMenu','saveMondelezCancellation','openMondelezCancellation','deleteMondelezRow'])vm.runInContext(lift(n),ctx);
 ctx.toggleMondelezTonu=id=>{row.tonu=!row.tonu;writes.push({tonu:id});};
 ctx.toggleMondelezShiftComplete=id=>{row.shiftComplete=!row.shiftComplete;writes.push({complete:id});};
 const menu=id=>{ctx.openMondelezRowContextMenu(id,10,10);return [...dom.window.document.querySelectorAll('#row-context-menu button')];};
 return {dom,ctx,row,tomorrow,cache,writes,menu,setFail:v=>fail=v};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
test('actual row menu matches Atlanta order, labels, styles and escaped load number',()=>{
 const f=fixture();try{
  const b=f.menu(f.row.id);assert.deepEqual(b.map(x=>x.textContent),['TONU','Cancellation - driver fall off','Mondelez cancellation - non-TONU','Shift Complete','Delete entire load <img src=x onerror=alert(1)>']);
  assert.ok(b[3].classList.contains('context-menu-item-success'));assert.ok(b[4].classList.contains('context-menu-item-danger'));assert.equal(f.dom.window.document.querySelector('#row-context-menu img'),null);
  b[0].click();assert.equal(f.row.tonu,true);assert.equal(f.dom.window.document.getElementById('row-context-menu'),null);
  f.menu(f.row.id)[3].click();assert.equal(f.row.shiftComplete,true);
  assert.equal(f.menu(f.row.id)[3].textContent,'Mark Shift Incomplete');
 }finally{f.dom.window.close();}
});
test('reason modal, cancellation and undo target the owning date in combined/night view; notes/rates survive',async()=>{
 const f=fixture();try{
  f.menu(f.tomorrow.id)[2].click();let overlay=f.dom.window.document.getElementById('mdz-cancellation-overlay');
  overlay.querySelector('[data-save]').click();assert.equal(f.writes.length,0);assert.match(overlay.textContent,/Enter the cancellation reason/);
  overlay.querySelector('textarea').value='Customer cancelled';overlay.querySelector('[data-save]').click();await settle();
  assert.equal(f.tomorrow.loadCancelled,true);assert.deepEqual(f.writes[0],{id:42,date:'2026-10-03',calledOff:false,loadCancelled:true,reason:'Customer cancelled',notes:'Keep my notes',carrierPay:'600'});
  assert.equal(f.dom.window.document.getElementById('mdz-cancellation-overlay'),null);assert.equal(f.row.loadCancelled,false);
  f.menu(f.tomorrow.id)[2].click();await settle();assert.equal(f.tomorrow.loadCancelled,false);assert.equal(f.tomorrow.loadCancelledReason,'');
  const payload=f.ctx.mondelezRowToDbRow(f.tomorrow,f.tomorrow.shiftDate);assert.equal(payload.load_cancelled,false);assert.equal(payload.shift_date,'2026-10-03');
  const reloaded=f.ctx.mondelezRowFromDbRow({...payload,id:42,called_off:true,called_off_reason:'Breakdown'});assert.equal(reloaded.calledOff,true);assert.equal(reloaded.calledOffReason,'Breakdown');
 }finally{f.dom.window.close();}
});
test('failed cancellation and deletion leave the load present and allow retry; confirmed delete removes only owner-day row',async()=>{
 const f=fixture();try{
  f.setFail(true);f.menu(f.tomorrow.id)[1].click();let overlay=f.dom.window.document.getElementById('mdz-cancellation-overlay');overlay.querySelector('textarea').value='Breakdown';overlay.querySelector('[data-save]').click();await settle();
  assert.equal(f.tomorrow.calledOff,false);assert.equal(overlay.querySelector('[data-save]').disabled,false);assert.match(overlay.textContent,/not saved/);
  await f.ctx.deleteMondelezRow(f.tomorrow.id);assert.equal(f.cache['2026-10-03'].length,1);
  f.setFail(false);overlay.querySelector('[data-save]').click();await settle();assert.equal(f.tomorrow.calledOff,true);
  f.ctx.confirm=()=>false;await f.ctx.deleteMondelezRow(f.tomorrow.id);assert.equal(f.cache['2026-10-03'].length,1);
  f.ctx.confirm=()=>true;await f.ctx.deleteMondelezRow(f.tomorrow.id);assert.equal(f.cache['2026-10-03'].length,0);assert.equal(f.cache['2026-10-02'].length,1);
 }finally{f.dom.window.close();}
});
async function database(){
 const db=new PGlite();await db.exec(`create role anon;create role authenticated;create schema app_private;create schema auth;
 create function auth.jwt() returns jsonb language sql as $$select '{"email":"sandbox@example.invalid"}'::jsonb$$;
 create table public.mondelez_loads(id bigint primary key,location text,shift_date date,aljex_number text,driver_id bigint,driver_name text,start_time text,carrier_pay numeric,revenue_total numeric);
 create table public.loads_accounting(id bigint generated always as identity primary key,source_mondelez_id bigint unique,location text,shift_date date,aljex_load_number text,driver_id bigint,driver_name_text text,cost_level int,revenue_level int,status text default 'active',cancelled_reason text,total_carrier_pay numeric,total_cost numeric,total_revenue numeric,fsc_payment numeric,total_miles numeric,total_stops numeric,carrier_pay_manual boolean default false,revenue_manual boolean default false,sent boolean default false,deleted_at timestamptz);
 create table public.driver_notes(id bigint generated always as identity primary key,driver_id bigint,note_text text,created_by text,note_type text,source_shift_id bigint,source_shift_date date,source_shift_start text,source_load_label text);
 create table public.mondelez_change_history(id bigint generated always as identity primary key,mondelez_load_id bigint,field_name text,old_value text,new_value text,changed_by text,note text);`);
 await db.exec(`create function app_private.sync_accounting_total_cost_from_carrier_edit() returns trigger language plpgsql as $$begin if new.total_carrier_pay is distinct from old.total_carrier_pay then new.total_cost := new.total_carrier_pay; end if; return new; end;$$;
 create trigger trg_sync_accounting_total_cost_from_carrier_edit before update of total_carrier_pay on public.loads_accounting for each row execute function app_private.sync_accounting_total_cost_from_carrier_edit();`);
 await db.exec(migration);return db;
}
test('actual migration: cancel, zero Accounting, one driver note, preserve manual rates, undo exactly, retry and both flags',async()=>{
 const db=await database();try{
  await db.exec(`insert into mondelez_loads values(41,'morris','2026-10-02','2012345',7,'Test Driver','09:00',600,950,false,null,null,false,null,null);
  insert into loads_accounting(source_mondelez_id,location,status,total_carrier_pay,total_cost,total_revenue,fsc_payment,total_miles,total_stops,carrier_pay_manual,revenue_manual) values(41,'mondelez','active',777,789,999,10,200,4,true,true)`);
  const before=(await db.query('select * from loads_accounting')).rows[0];
  await db.exec("update mondelez_loads set called_off=true,called_off_reason='Breakdown',called_off_at=now() where id=41");
  let a=(await db.query('select * from loads_accounting')).rows[0];assert.equal(a.status,'cancelled');for(const k of ['total_carrier_pay','total_cost','total_revenue','fsc_payment','total_miles','total_stops'])assert.equal(Number(a[k]),0,k);
  const notes=(await db.query('select * from driver_notes')).rows;assert.equal(notes.length,1);assert.equal(notes[0].source_shift_id,null);assert.equal(notes[0].source_shift_date.toISOString().slice(0,10),'2026-10-02');assert.equal(notes[0].source_shift_start,'09:00');assert.equal(notes[0].source_load_label,'2012345');
  assert.equal(Number((await db.query('select carrier_pay from mondelez_loads')).rows[0].carrier_pay),600);
  await db.exec("update mondelez_loads set called_off=true,called_off_reason='Breakdown' where id=41;update loads_accounting set total_revenue=12345,status='active' where source_mondelez_id=41");
  assert.equal((await db.query('select count(*)::int n from driver_notes')).rows[0].n,1);assert.equal(Number((await db.query('select total_revenue from loads_accounting')).rows[0].total_revenue),0);
  await db.exec("update mondelez_loads set load_cancelled=true,load_cancelled_reason='Customer cancelled' where id=41;update mondelez_loads set called_off=false,called_off_reason=null where id=41");
  assert.equal((await db.query('select status from loads_accounting')).rows[0].status,'cancelled');
  await db.exec("update mondelez_loads set load_cancelled=false,load_cancelled_reason=null where id=41");
  a=(await db.query('select * from loads_accounting')).rows[0];assert.deepEqual(a,before);
  assert.equal((await db.query('select count(*)::int n from app_private.mondelez_cancellation_backup')).rows[0].n,0);
 }finally{await db.close();}
});
test('cancel before overnight push, guard sweep writes, require reason, reject settled records atomically, source namespaces independent',async()=>{
 const db=await database();try{
  await db.exec("insert into mondelez_loads(id,location,shift_date,aljex_number,driver_id,called_off,called_off_reason) values(42,'addison','2026-10-03','2016789',8,true,'No show')");
  assert.equal((await db.query('select status from loads_accounting')).rows[0].status,'cancelled');
  await db.exec('delete from loads_accounting;insert into loads_accounting(source_mondelez_id,status,total_carrier_pay) values(42,\'active\',900)');
  assert.equal((await db.query('select status from loads_accounting')).rows[0].status,'cancelled');assert.equal(Number((await db.query('select total_carrier_pay from loads_accounting')).rows[0].total_carrier_pay),0);
  await db.exec('update mondelez_loads set called_off=false,called_off_reason=null where id=42');assert.equal((await db.query('select count(*)::int n from loads_accounting')).rows[0].n,0);
  await assert.rejects(db.exec('update mondelez_loads set load_cancelled=true where id=42'),/reason is required/);assert.equal((await db.query('select load_cancelled from mondelez_loads')).rows[0].load_cancelled,false);
  await db.exec("insert into loads_accounting(source_mondelez_id,location,status,total_carrier_pay) values(42,'mondelez','released',600);insert into loads_accounting(location,status,total_carrier_pay) values('atlanta','active',450)");
  await assert.rejects(db.exec("update mondelez_loads set load_cancelled=true,load_cancelled_reason='Cancelled' where id=42"),/released/);
  assert.equal((await db.query('select load_cancelled from mondelez_loads')).rows[0].load_cancelled,false);assert.equal((await db.query("select total_carrier_pay from loads_accounting where location='atlanta'")).rows[0].total_carrier_pay,'450');
  const security=(await db.query("select has_function_privilege('anon','app_private.record_mondelez_cancellation()','EXECUTE') callable,has_table_privilege('authenticated','app_private.mondelez_cancellation_backup','INSERT') writable")).rows[0];assert.equal(security.callable,false);assert.equal(security.writable,false);
 }finally{await db.close();}
});

test('dispatcher updates source through RLS; trigger can write Accounting, while backup and trigger APIs stay private',async()=>{
 const db=await database();try{
  await db.exec(`insert into mondelez_loads(id,location,shift_date,aljex_number) values(50,'morris','2026-10-02','2019999');
   alter table mondelez_loads enable row level security;
   create policy fixture_dispatcher on mondelez_loads for all to authenticated using(id=50) with check(id=50);
   grant usage on schema public,auth to authenticated;grant select,update on mondelez_loads to authenticated;
   set role authenticated;
   update mondelez_loads set load_cancelled=true,load_cancelled_reason='Cancelled' where id=50;reset role;`);
  assert.equal((await db.query('select status from loads_accounting where source_mondelez_id=50')).rows[0].status,'cancelled');
  await db.exec('set role authenticated');await assert.rejects(db.exec('select * from app_private.mondelez_cancellation_backup'),/permission denied/);await db.exec('reset role');
 }finally{await db.close();}
});
