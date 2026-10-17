import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import {JSDOM} from 'jsdom';
import {PGlite} from '@electric-sql/pglite';
const source=readFileSync('visitor-access.js','utf8');
function fixture(role='visitor',failRole=false){
 const dom=new JSDOM('<button id="save">Save changes</button><a id="nav" href="accounting.html">Accounting</a>',{url:'https://sandbox.invalid/index.html',runScripts:'outside-only'});
 const calls=[];const ctx=dom.getInternalVMContext();
 const result={data:[{secret:'LIVE SECRET'}],error:null};
 const builder=new Proxy({then:resolve=>resolve(result)},{get(t,k){return t[k]||(()=>builder);}});
 const client=()=>({auth:{getSession:async()=>({data:{session:{user:{id:'visitor'}}}})},from:table=>{calls.push(['table',table]);return builder;},rpc:async name=>{if(name==='current_app_role')return {data:role,error:failRole?new Error('role failed'):null};calls.push(['rpc',name]);return result;},channel:()=>({on(){return this;},subscribe(){calls.push(['realtime']);return this;},send:async()=>calls.push(['send'])}),storage:{from:()=>({upload:async()=>{calls.push(['upload']);return result;}})},functions:{invoke:async()=>{calls.push(['invoke']);return result;}}});
 Object.assign(ctx,{URL,Response,fetch:async()=>{calls.push(['fetch']);return new Response('LIVE SECRET');},supabase:{createClient:client}});
 vm.runInContext(source,ctx);return {dom,calls,ctx,client:ctx.supabase.createClient()};
}
test('visitor reads return no records; writes, RPC, uploads, functions, fetch and realtime are blocked',async()=>{
 const f=fixture();try{
  assert.equal((await f.client.from('loads_shifts').select('*')).data.length,0);
  assert.equal((await f.client.from('loads_accounting').select('*').single()).data,null);
  assert.equal((await f.client.from('user_roles').select('role').single()).data.role,'visitor');
  for(const method of ['insert','update','delete','upsert'])assert.equal((await f.client.from('loads_shifts')[method]({})).error.code,'VISITOR_READ_ONLY');
  assert.ok((await f.client.rpc('push_shift_to_accounting')).error);
  assert.ok((await f.client.storage.from('trip-sheets').upload('x','x')).error);
  assert.ok((await f.client.functions.invoke('send-text')).error);
  assert.equal((await f.ctx.fetch('https://project.supabase.co/functions/v1/image-archive-onedrive')).status,403);
  f.client.channel('loads').on('postgres_changes',{},()=>{}).subscribe();await new Promise(r=>setImmediate(r));
  assert.deepEqual(f.calls,[]);
  let save=false;f.dom.window.document.querySelector('#save').addEventListener('click',()=>save=true);f.dom.window.document.querySelector('#save').click();assert.equal(save,false);
  assert.ok(f.dom.window.document.querySelector('#visitor-banner'));
 }finally{f.dom.window.close();}
});
test('employee requests retain their SDK results and subscriptions',async()=>{
 const f=fixture('dispatcher');try{
  assert.equal((await f.client.from('loads_shifts').select('*')).data[0].secret,'LIVE SECRET');
  await f.client.from('loads_shifts').update({comments:'saved'}).eq('id',1);
  await f.client.rpc('staff_rpc');await f.client.storage.from('trip-sheets').upload('x','x');
  f.client.channel('loads').subscribe();await new Promise(r=>setImmediate(r));
  assert.ok(f.calls.some(x=>x[0]==='realtime'));assert.ok(f.calls.some(x=>x[0]==='upload'));
 }finally{f.dom.window.close();}
});
test('a failed trusted role lookup never executes a business request',async()=>{
 const f=fixture('visitor',true);try{await assert.rejects(async()=>await f.client.from('loads_shifts').select('*'),/role failed/);assert.deepEqual(f.calls,[]);}finally{f.dom.window.close();}
});
test('actual migration blocks visitor REST, owner views, privileged RPCs and anonymous fallback while retaining staff access',async()=>{
 const db=new PGlite();try{
  await db.exec(`create role anon;create role authenticated;create role service_role;create role authenticator;
  create schema auth;create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.user_id',true),'')::uuid $$;
  create table user_roles(user_id uuid primary key,role text);alter table user_roles enable row level security;
  create policy own_role on user_roles for select to authenticated using(user_id=auth.uid());
  grant usage on schema public,auth to authenticated,anon,service_role;grant select on user_roles to authenticated,anon,service_role;
  create function current_app_role() returns text language sql stable as $$select role from user_roles where user_id=auth.uid()$$;
  create table secret_records(id int);insert into secret_records values(1);alter table secret_records enable row level security;
  create policy staff on secret_records to authenticated using(current_app_role()='dispatcher');grant select,insert,update,delete on secret_records to authenticated,anon;
  create view analytics_trips_all as select * from secret_records;create view analytics_accounting_all as select * from secret_records;
  grant select on analytics_trips_all,analytics_accounting_all to authenticated,anon;
  create function push_shift_to_accounting(bigint,text) returns integer language plpgsql security definer as $$begin insert into secret_records values(2);return 1;end;$$;
  create function refresh_accounting_audit_snapshot(bigint) returns void language plpgsql security definer as $$begin update secret_records set id=3;end;$$;
  create function archive_backup_status() returns jsonb language sql security definer as $$select '{"secret":"REAL"}'::jsonb;$$;
  insert into user_roles values('11111111-1111-1111-1111-111111111111','visitor'),('22222222-2222-2222-2222-222222222222','dispatcher');`);
  await db.exec(readFileSync('supabase/migrations/20261016210034_visitor_access_boundary.sql','utf8'));
  await db.exec(readFileSync('supabase/migrations/20261016211001_visitor_guard_anonymous_passthrough.sql','utf8'));
  await db.exec(`set role authenticated;set request.user_id='11111111-1111-1111-1111-111111111111';set request.path='/loads_shifts'`);
  await assert.rejects(db.query('select check_visitor_request()'),/Visitor access/);
  for(const table of ['secret_records','analytics_trips_all','analytics_accounting_all'])assert.equal((await db.query('select * from '+table)).rows.length,0);
  await assert.rejects(db.query("select push_shift_to_accounting(1,'guest')"),/Visitor/);
  await assert.rejects(db.query('select refresh_accounting_audit_snapshot(1)'),/Visitor/);
  assert.deepEqual((await db.query('select archive_backup_status() data')).rows[0].data,{});
  await db.exec("set request.path='/rpc/current_app_role'");await db.query('select check_visitor_request()');
  assert.equal((await db.query('select current_app_role() role')).rows[0].role,'visitor');
  await db.exec("set request.user_id='22222222-2222-2222-2222-222222222222';set request.path='/loads_shifts'");await db.query('select check_visitor_request()');
  assert.equal((await db.query('select * from analytics_accounting_all')).rows.length,1);
  assert.equal((await db.query("select push_shift_to_accounting(1,'staff') n")).rows[0].n,1);
  await db.exec("reset role;set role anon;set request.user_id=''");
  await db.query('select check_visitor_request()');
  assert.equal((await db.query('select * from analytics_accounting_all')).rows.length,0);
  await assert.rejects(db.query('select archive_backup_status()'),/permission denied/);
 }finally{await db.close();}
});

test('archive function authorizes both status and signed-document requests against trusted roles',async()=>{
 const edge=readFileSync('supabase/functions/image-archive-onedrive/index.ts','utf8');
 let fn=edge.slice(edge.indexOf('async function authenticatedUser('),edge.indexOf('\n// Only an admin',edge.indexOf('async function authenticatedUser(')));
 fn=fn.replace('admin: ReturnType<typeof createClient>, req: Request','admin, req');
 const ctx=vm.createContext({bearer:()=> 'token'});vm.runInContext(fn,ctx);
 for(const role of ['visitor','dispatcher','accounting','admin','it',null]){
  const admin={auth:{getUser:async()=>({data:{user:{id:'u'}},error:null})},from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:{role},error:null})})})})};
  assert.equal(!!await ctx.authenticatedUser(admin,{}),['dispatcher','accounting','admin','it'].includes(role));
 }
});
