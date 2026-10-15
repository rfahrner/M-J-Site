import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import {PGlite} from '@electric-sql/pglite';
const board=fs.readFileSync('loadboard.js','utf8');
const migration=fs.readFileSync('supabase/migrations/20261015174640_preferred_zero_activity_memberships.sql','utf8');
const rollback=fs.readFileSync('supabase/rollback/preferred_zero_activity_memberships_20261015.sql','utf8');
const fixture=JSON.parse(fs.readFileSync('sandbox/preferred-membership-fixture.json','utf8'));
const targetIds=fixture.filter(d=>d.location==='preferred').map(d=>d.id);
function lift(source,name){
 const m=source.match(new RegExp(`^([ \t]*)(?:export )?function ${name}\\(`,'m'));assert.ok(m,name);
 const end=source.indexOf('\n'+m[1]+'}',m.index);assert.ok(end>m.index,name);return source.slice(m.index,end+m[1].length+2).replace('export ','');
}
function pools(rows){const ctx={state:{drivers:[]}};vm.createContext(ctx);vm.runInContext([lift(board,'driverFromDbRow'),lift(board,'locationGroupFor'),lift(board,'driversForLocation')].join('\n'),ctx);ctx.state.drivers=rows.map(ctx.driverFromDbRow);return ctx;}
async function database(){
 const db=new PGlite();await db.exec(`create schema private;
 create table atlanta_drivers(id bigint primary key,location text,profile_key uuid not null,"Driver Name" text,"Driver Rating" text,"Notes" text,"MC" text,"Carrier" text,"Driver Cell" text,normal_rate numeric,do_not_text boolean default false,do_not_text_dispatch boolean default true,runs_out_of text[]);
 create table private.driver_profile_sync_backups(migration_name text,driver_id bigint,snapshot jsonb,saved_at timestamptz default now(),primary key(migration_name,driver_id));`);
 await db.query(`insert into atlanta_drivers select id,location,profile_key,'Driver '||profile_key::text,'C','Keep notes',profile_key::text,'Sandbox Carrier','7705551234',600,false,true,array['atlanta','buildingc']::text[] from jsonb_to_recordset($1::jsonb) as d(id bigint,location text,profile_key uuid)`,[JSON.stringify(fixture)]);
 await db.exec(`insert into atlanta_drivers(id,location,profile_key,"Driver Name","Driver Rating") values(900001,'preferred','00000000-0000-4000-9000-999999999991','Active driver','A'),(900002,'preferred','00000000-0000-4000-9000-999999999992','Unknown activity','B'),(900003,'houston','00000000-0000-4000-9000-999999999993','Other board','D');`);
 for(const table of ['loads_shifts','loads_trips','loads_houston','loads_accounting','mondelez_loads','driver_notes','driver_rate_history']){
  await db.exec(`create table ${table}(id bigint primary key,driver_id bigint references atlanta_drivers(id) on delete ${table==='driver_rate_history'?'cascade':'set null'},memo text);`);
  await db.query(`insert into ${table} select id,id,'Historical record' from atlanta_drivers where location='preferred'`);
 }
 await db.exec(fs.readFileSync('sandbox/preferred-membership-profile-triggers.sql','utf8'));
 await db.exec('create trigger prepare_shared_driver_profile before insert or update on atlanta_drivers for each row execute function prepare_shared_driver_profile();create trigger sync_shared_driver_profile after insert or update on atlanta_drivers for each row execute function sync_shared_driver_profile()');
 return db;
}
async function apply(db){await db.exec('begin');await db.exec(migration);await db.exec('commit');}
test('exact batch removes 373 Preferred memberships, moves only 9 to Atlanta, and keeps all IDs, fields and history links',async()=>{
 const db=await database();try{
  const before=(await db.query('select * from atlanta_drivers order by id')).rows;
  const histories={};for(const table of ['loads_shifts','loads_trips','loads_houston','loads_accounting','mondelez_loads','driver_notes','driver_rate_history'])histories[table]=(await db.query(`select * from ${table} order by id`)).rows;
  await apply(db);const after=(await db.query('select * from atlanta_drivers order by id')).rows;assert.equal(after.length,before.length);
  assert.equal(after.filter((d,i)=>d.location!==before[i].location).length,9);assert.equal(after.filter(d=>d.preferred_list_active===false).length,373);
  for(let i=0;i<before.length;i++){const a={...after[i]},b={...before[i]};delete a.location;delete b.location;delete a.preferred_list_active;assert.deepEqual(a,b);}
  const {driversForLocation}=pools(after);assert.equal(driversForLocation('preferred').length,2);
  const atlanta=driversForLocation('atlanta');assert.deepEqual(driversForLocation('buildingc').map(d=>d.id),atlanta.map(d=>d.id));
  for(const id of targetIds){const retired=after.find(d=>d.id===id);assert.ok(atlanta.some(a=>a.profileKey===retired.profile_key),String(id));}
  for(const [table,rows] of Object.entries(histories))assert.deepEqual((await db.query(`select * from ${table} order by id`)).rows,rows,table);
  assert.equal((await db.query("select count(*)::int n from private.driver_profile_sync_backups where migration_name='preferred_zero_activity_memberships_20261015'")).rows[0].n,373);
 }finally{await db.close();}
});
test('shared contact edits and new shared memberships never reactivate the retired Preferred row',async()=>{
 const db=await database();try{
  await apply(db);const retired=(await db.query("select * from atlanta_drivers where location='preferred' and not preferred_list_active limit 1")).rows[0];
  await db.query('update atlanta_drivers set "Notes"=$1 where id=$2',['New contact note',retired.id]);
  const peers=(await db.query('select * from atlanta_drivers where profile_key=$1',[retired.profile_key])).rows;
  assert.ok(peers.some(p=>p.location==='atlanta'&&p.preferred_list_active===true));assert.equal(peers.find(p=>p.id===retired.id).preferred_list_active,false);
  await db.query('insert into atlanta_drivers(id,location,"Driver Name","MC",profile_key) values(900004,\'preferred\',$1,$2,$3)',[retired['Driver Name'],retired['MC'],'00000000-0000-4000-9000-999999999994']);
  assert.equal((await db.query('select preferred_list_active from atlanta_drivers where id=$1',[retired.id])).rows[0].preferred_list_active,false);
  assert.equal((await db.query('select preferred_list_active from atlanta_drivers where id=900004')).rows[0].preferred_list_active,true);
 }finally{await db.close();}
});
test('manual rollback restores list memberships while preserving newer contact edits',async()=>{
 const db=await database();try{
  const original=(await db.query('select id,location from atlanta_drivers order by id')).rows;await apply(db);
  await db.query('update atlanta_drivers set "Notes"=$1 where id=$2',['Keep my newer note',targetIds[0]]);
  await db.exec(rollback);assert.deepEqual((await db.query('select id,location from atlanta_drivers order by id')).rows,original);
  assert.equal((await db.query('select "Notes" note from atlanta_drivers where id=$1',[targetIds[0]])).rows[0].note,'Keep my newer note');
  assert.equal((await db.query('select count(*)::int n from atlanta_drivers where not preferred_list_active')).rows[0].n,0);
 }finally{await db.close();}
});
test('missing reviewed Atlanta peer aborts atomically; rollback rejects later membership changes',async()=>{
 const db=await database();try{
  const peer=(await db.query("select a.id from atlanta_drivers a where a.location='atlanta' and exists(select 1 from atlanta_drivers p where p.location='preferred' and p.profile_key=a.profile_key) limit 1")).rows[0].id;
  await db.query("update atlanta_drivers set location='houston' where id=$1",[peer]);
  await db.exec('begin');await assert.rejects(db.exec(migration),/Atlanta membership is missing/);await db.exec('rollback');
  assert.equal((await db.query('select count(*)::int n from private.driver_profile_sync_backups')).rows[0].n,0);
  await db.query("update atlanta_drivers set location='atlanta' where id=$1",[peer]);await apply(db);
  await db.query('update atlanta_drivers set preferred_list_active=true where id=$1',[targetIds[0]]);
  await assert.rejects(db.exec(rollback),/membership changed/);await db.exec('rollback');
 }finally{await db.close();}
});
test('legacy clients default to active membership; local membership metadata cannot leak through profile form patches',async()=>{
 const api=await import('data:text/javascript;base64,'+Buffer.from(fs.readFileSync('driver-profile-sync.js','utf8')).toString('base64'));
 const patch=api.driverProfilePatch({preferred_list_active:false},{preferred_list_active:true,'Notes':'New note'});assert.deepEqual(patch,{'Notes':'New note'});
 const ctx=pools([{id:1,location:'preferred'},{id:2,location:'preferred',preferred_list_active:false},{id:3,location:'atlanta',preferred_list_active:false}]);assert.deepEqual(Array.from(ctx.driversForLocation('preferred'),d=>d.id),[1]);assert.deepEqual(Array.from(ctx.driversForLocation('buildingc'),d=>d.id),[3]);
});
test('selection uses the displayed zero grade, including inherited carrier activity, while keeping positive and unknown activity',()=>{
 const source=fs.readFileSync('driver-activity-core.js','utf8');
 const names=['normalizeCarrier','normalizeDriverName','profileRunScopes','isAtlantaCarrierSource','chooseCarrier','resolveCarrierForActivity','activityScopeForDriver','activityForDriver'];
 const drivers=[{id:10,location:'atlanta',name:'Inherited',mc:'123',carrier:'Inactive'},
  {id:1,location:'preferred',name:'Inherited',mc:'123',carrier:''},
  {id:2,location:'preferred',name:'Active',carrier:'Active'},
  {id:3,location:'preferred',name:'Unknown',carrier:''},
  {id:4,location:'preferred',name:'Zero',carrier:'Inactive'}];
 const ctx={state:{drivers},activityLoaded:true,activityRows:new Map([['atlanta|active',{active_days:1,operating_days:60,activity_percent:1.7,grade:'F'}]]),operatingDaysByScope:new Map([['atlanta',60]]),cancellationCounts:new Map(),VALID_SCOPES:new Set(['atlanta','buildingc','delaware','houston','mondelez'])};
 vm.createContext(ctx);vm.runInContext(names.map(n=>lift(source,n)).join('\n'),ctx);
 const selected=drivers.filter(d=>d.location==='preferred'&&ctx.activityForDriver(d,'preferred').grade==='0').map(d=>d.id);assert.deepEqual(selected,[1,4]);assert.equal(ctx.activityForDriver(drivers[3],'preferred').grade,'—');
});
