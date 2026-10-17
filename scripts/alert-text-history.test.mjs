import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import {JSDOM} from 'jsdom';
import {PGlite} from '@electric-sql/pglite';
const dataModule=s=>'data:text/javascript;base64,'+Buffer.from(s).toString('base64');
const {writeAlertTextClick,boardAlertTextDetails}=await import(dataModule(fs.readFileSync('alert-text-history.js','utf8')));
const sql=fs.readFileSync('supabase/migrations/20261012232842_alert_text_click_history.sql','utf8');
const tick=()=>new Promise(setImmediate);
test('each click writes one event per target load; recipient mapping never uses untexted group members',async()=>{
 const calls=[];const client={rpc:async(name,args)=>{calls.push({name,args});return {data:args.p_load_ids.map(id=>({id,shift_id:id})),error:null};}};
 const alert={textShiftIds:[10,11],jumpShiftIds:[10,11,12],actionMessage:'Exact draft',message:'ETA reminder'};
 for(let i=0;i<2;i++)await writeAlertTextClick(client,boardAlertTextDetails(alert));
 assert.equal(calls.length,2);assert.deepEqual(calls[0].args.p_load_ids,[10,11]);assert.equal(calls[0].args.p_message,'Exact draft');
 await writeAlertTextClick(client,{source:'loads_houston',loadIds:[10,10],message:'Houston'});assert.deepEqual(calls[2].args.p_load_ids,[10]);assert.equal(calls[2].args.p_source,'loads_houston');
 await assert.rejects(writeAlertTextClick(client,{loadIds:[]}),/linked/);
 await assert.rejects(writeAlertTextClick({rpc:async()=>({data:[],error:null})},{loadIds:[10]}),/not confirmed/);
});
test('actual capture bridge logs before draft, repeated clicks remain separate, no dismissal on opening; failure is retryable',async()=>{
 const dom=new JSDOM('<div id="alert-widget"><button data-alert-action-key="preshift-600-10_11">Text</button></div>',{runScripts:'outside-only'});
 const audit=[],opened=[],status=[];let fail=false;let dismiss=0;
 const alert={key:'preshift-600-10_11',markShiftIdsOnSent:[10,11],recipients:[{name:'A',phone:'7705551234'},{name:'B',phone:'7705559876'}],message:'Pre-shift ETA reminder',actionMessage:'Exact draft'};
 const client={rpc:async(name,args)=>{if(fail)return {error:{message:'Sandbox history failure'}};audit.push(args);return {data:args.p_load_ids.map(id=>({id,shift_id:id})),error:null};}};
 dom.window.__alerts={getBoardAlert:()=>alert,dismissAlert:()=>dismiss++};
 dom.window.__lb={logAlertTextClick:details=>writeAlertTextClick(client,details),openSendTextModal:(...a)=>opened.push(a),setDriverSyncStatus:(...a)=>status.push(a)};
 dom.window.__history={boardAlertTextDetails};
 let source=fs.readFileSync('alert-text-button-fix.js','utf8');
 for(const [path,name] of [['alerts','__alerts'],['loadboard','__lb'],['alert-text-history','__history']])source=source.replaceAll(`import('./${path}.js')`,`Promise.resolve(window.${name})`);
 dom.window.console.error=()=>{};dom.window.eval(source);const button=dom.window.document.querySelector('button');
 button.click();await tick();assert.equal(audit.length,1);assert.equal(opened.length,1);assert.equal(dismiss,0);assert.equal(opened[0][1],'Exact draft');
 button.click();await tick();assert.equal(audit.length,2);assert.equal(opened.length,2);
 fail=true;button.click();await tick();assert.equal(opened.length,2);assert.equal(button.disabled,false);assert.match(status.at(-1)[0],/history/);
 fail=false;button.click();await tick();assert.equal(audit.length,3);assert.equal(opened.length,3);
 opened.at(-1)[3].onSent();assert.equal(dismiss,1);dom.window.close();
});
test('Houston extra-alert Text uses Houston history and click log persists when draft is cancelled',async()=>{
 const dom=new JSDOM('<div id="alert-widget"><button data-houston-preshift-id="10" data-driver-name="Houston Driver" data-driver-phone="7705551234" data-shift-time="09:00">Text</button></div>',{url:'https://sandbox.invalid/houston.html'});
 const audit=[],opened=[];
 const client={rpc:async(name,args)=>{audit.push(args);return {data:[{id:1,houston_load_id:10}],error:null};}};
 const strip=s=>s.replace(/^import[^;]+;\n/gm,'').replace(/export /g,'');
 const src=strip(fs.readFileSync('overnight-times.js','utf8'))+'\n'+strip(fs.readFileSync('dispatch-route-text.js','utf8'))+'\n'+strip(fs.readFileSync('preshift-pro-text.js','utf8'));
 const env={setAlertWidgetSource:()=>{},supabaseClient:client,logAlertTextClick:d=>writeAlertTextClick(client,d),openSendTextModal:(...a)=>opened.push(a),setDriverSyncStatus:()=>{},document:dom.window.document,window:dom.window,location:dom.window.location,MutationObserver:dom.window.MutationObserver,setTimeout:()=>0,clearTimeout:()=>{},setInterval:()=>0};
 new Function(...Object.keys(env),src)(...Object.values(env));dom.window.document.querySelector('button').click();await tick();
 assert.equal(audit.length,1);assert.equal(audit[0].p_source,'loads_houston');assert.deepEqual(audit[0].p_load_ids,[10]);assert.equal(opened.length,1);assert.equal(audit[0].p_message,opened[0][1]);
 dom.window.document.querySelector('button').click();await tick();assert.equal(audit.length,2);dom.window.close();
});
async function dbFixture(){
 const db=new PGlite();await db.exec(`create role anon;create role authenticated;create schema auth;
 create function auth.uid() returns uuid language sql as $$select nullif(current_setting('fixture.uid',true),'')::uuid$$;
 create function auth.jwt() returns jsonb language sql as $$select jsonb_build_object('email',current_setting('fixture.email',true))$$;
 create function public.current_app_role() returns text language sql as $$select current_setting('fixture.role',true)$$;
 select set_config('fixture.uid','00000000-0000-0000-0000-000000000001',false);select set_config('fixture.email','dispatcher@example.invalid',false);select set_config('fixture.role','dispatcher',false);
 create table loads_shifts(id bigint primary key,pro_number text,driver_name_text text);
 create table loads_trips(id bigint primary key,shift_id bigint references loads_shifts(id));
 create table loads_houston(id bigint primary key);create table mondelez_loads(id bigint primary key);
 create table load_change_history(id bigint generated always as identity primary key,shift_id bigint references loads_shifts(id),trip_id bigint references loads_trips(id),load_label text,field_name text,old_value text,new_value text,changed_by text,note text,changed_at timestamptz default now());
 create table houston_change_history(id bigint generated always as identity primary key,houston_load_id bigint references loads_houston(id),field_name text,old_value text,new_value text,changed_by text,note text,changed_at timestamptz default now());
 create table mondelez_change_history(id bigint generated always as identity primary key,mondelez_load_id bigint references mondelez_loads(id),field_name text,old_value text,new_value text,changed_by text,note text,changed_at timestamptz default now());
 insert into loads_shifts values(10,'PRO10','A'),(11,'PRO11','B');insert into loads_trips values(20,10);insert into loads_houston values(10);insert into mondelez_loads values(10);`);
 await db.exec(sql);return db;
}
test('actual RPC: repeated/group clicks stay distinct, authors/times/message are stored, source ID namespaces and route ownership are enforced',async()=>{
 const db=await dbFixture();try{
  for(let i=0;i<2;i++)await db.query("select log_alert_text_click('loads_shifts',array[10,11,10]::bigint[],'ETA reminder','Exact draft')");
  let rows=(await db.query('select * from load_change_history order by id')).rows;assert.equal(rows.length,4);
  for(const row of rows){assert.equal(row.changed_by,'dispatcher@example.invalid');assert.ok(row.changed_at instanceof Date);assert.equal(row.field_name,'alert_text_clicked');assert.match(row.note,/click only; sending is not confirmed/);assert.ok(row.note.endsWith('Exact draft'));}
  await db.exec("select log_alert_text_click('loads_houston',array[10]::bigint[],'ETA reminder','Houston draft');select log_alert_text_click('mondelez_loads',array[10]::bigint[],'Reminder','Mondelez draft');select log_alert_text_click('loads_shifts',array[10]::bigint[],'Dispatch reminder','Route draft',20)");
  assert.equal((await db.query('select count(*)::int n from houston_change_history')).rows[0].n,1);assert.equal((await db.query('select count(*)::int n from mondelez_change_history')).rows[0].n,1);
  await assert.rejects(db.exec("select log_alert_text_click('loads_shifts',array[11]::bigint[],'Reminder','Draft',20)"),/route does not belong/);
  await assert.rejects(db.exec("select log_alert_text_click('loads_shifts',array[10,999]::bigint[],'Reminder','Draft')"),/no longer available/);
  assert.equal((await db.query('select count(*)::int n from load_change_history')).rows[0].n,5,'group failure rolls back every entry');
  await db.exec("select set_config('fixture.role','driver',false)");await assert.rejects(db.exec("select log_alert_text_click('loads_shifts',array[10]::bigint[],'Reminder','Draft')"),/internal signed-in/);
  assert.equal((await db.query("select has_function_privilege('anon','log_alert_text_click(text,bigint[],text,text,bigint)','execute') permitted")).rows[0].permitted,false);
 }finally{await db.close();}
});
test('history renders a click without claiming sent and escapes alert text',()=>{
 const src=fs.readFileSync('loadboard.js','utf8');const match=src.match(/function formatChangeHistoryEntry\([^]*?\n  \}/);assert.ok(match);
 const fn=vm.runInNewContext('('+match[0]+')',{escapeHtml:s=>String(s).replaceAll('<','&lt;').replaceAll('>','&gt;')});
 const text=fn('alert_text_clicked',null,'<img src=x> reminder');assert.match(text,/Alert Text clicked/);assert.ok(!text.includes('<img'));assert.ok(!text.includes('sent'));
});
test('RPC respects source/history RLS and rejects an unsigned session without partial group entries',async()=>{
 const db=await dbFixture();try{
  await db.exec(`alter table loads_shifts enable row level security;create policy visible_loads on loads_shifts for select to authenticated using(id=10);
   alter table load_change_history enable row level security;create policy internal_history on load_change_history for all to authenticated using(public.current_app_role()='dispatcher') with check(public.current_app_role()='dispatcher');
   grant usage on schema public,auth to authenticated;grant select on loads_shifts,loads_trips to authenticated;grant select,insert on load_change_history to authenticated;
   set role authenticated;`);
  await db.exec("select log_alert_text_click('loads_shifts',array[10]::bigint[],'Reminder','Draft')");
  await assert.rejects(db.exec("select log_alert_text_click('loads_shifts',array[10,11]::bigint[],'Reminder','Draft')"),/no longer available/);
  assert.equal((await db.query('select count(*)::int n from load_change_history')).rows[0].n,1);
  await db.exec("select set_config('fixture.uid','',false)");await assert.rejects(db.exec("select log_alert_text_click('loads_shifts',array[10]::bigint[],'Reminder','Draft')"),/internal signed-in/);
 }finally{await db.close();}
});
test('an open History tab updates after auditing without overwriting unsaved history notes',async()=>{
 const dom=new JSDOM('<div id="ld-tab-content"><input data-hist-note-id="1" value="Unsaved note"></div><button id="text">Text</button>');dom.window.document.getElementById('text').focus();
 let renders=0;const state={rowId:'load',activeTab:'history',history:[{id:1,note:'Saved note'}]};
 const src=fs.readFileSync('loadboard.js','utf8').match(/export async function logAlertTextClick\([^]*?\n  \}/)[0].replace('export ','');
 const fn=vm.runInNewContext('('+src+')',{writeAlertTextClick:async()=>[{id:2,source:'loads_shifts',shift_id:10}],supabaseClient:{},loadDetailsState:state,findRowAnywhere:()=>({row:{dbId:10}}),document:dom.window.document,renderLoadDetailsTabContent:()=>renders++});
 await fn({loadIds:[10]});assert.equal(renders,0);assert.equal(state.history.length,2);assert.equal(dom.window.document.querySelector('input').value,'Unsaved note');
 dom.window.document.querySelector('input').value='Saved note';await fn({loadIds:[10]});assert.equal(renders,1);dom.window.close();
});
