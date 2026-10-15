import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import {JSDOM} from 'jsdom';
import {PGlite} from '@electric-sql/pglite';
const sql=fs.readFileSync('supabase/migrations/20261015171322_atlanta_preferred_rating_cleanup.sql','utf8');
const fixture=JSON.parse(fs.readFileSync('sandbox/driver-rating-cleanup-fixture.json','utf8'));
async function database(){
 const db=new PGlite();await db.exec(`create schema private;
 create table public.atlanta_drivers(id bigint primary key,location text,profile_key uuid not null,"Driver Rating" text,"Driver Name" text,"Notes" text,"MC" text,"Driver Cell" text,normal_rate numeric);
 create table private.driver_profile_sync_backups(migration_name text,driver_id bigint,snapshot jsonb,saved_at timestamptz default now(),primary key(migration_name,driver_id));`);
 await db.query(`insert into atlanta_drivers select id,location,profile_key,rating,'Sandbox driver','Keep notes','12345','7705551234',600 from jsonb_to_recordset($1::jsonb) as d(id bigint,location text,profile_key uuid,rating text)`,[JSON.stringify(fixture)]);
 await db.exec(`insert into atlanta_drivers values(700001,'delaware','00000000-0000-0000-0000-000000000001','R','Other list','Keep notes','999','7705550001',700),(700002,'atlanta','00000000-0000-0000-0000-000000000002','A','Active A','Keep notes','888','7705550002',800);`);
 await db.exec(fs.readFileSync('sandbox/driver-rating-cleanup-sync.sql','utf8'));
 await db.exec('create trigger sync_shared_driver_profile after insert or update on atlanta_drivers for each row execute function sync_shared_driver_profile()');
 return db;
}
test('actual migration with actual profile sync: 390 memberships, 281 profiles, only ratings change; backup and rollback are exact',async()=>{
 const db=await database();try{
  const before=(await db.query('select * from atlanta_drivers order by id')).rows;
  await db.exec('begin');await db.exec(sql);
  const after=(await db.query('select * from atlanta_drivers order by id')).rows;
  assert.equal(after.filter((row,i)=>row['Driver Rating']!==before[i]['Driver Rating']).length,390);
  assert.equal(after.filter(r=>r['Driver Rating']==='C').length,309);assert.equal(after.filter(r=>r['Driver Rating']===null).length,81);
  assert.equal((await db.query('select count(*)::int n from private.driver_profile_sync_backups')).rows[0].n,390);
  for(let i=0;i<before.length;i++){const a={...after[i]},b={...before[i]};delete a['Driver Rating'];delete b['Driver Rating'];assert.deepEqual(a,b);}
  assert.equal(after.find(d=>d.id===700001)['Driver Rating'],'R');assert.equal(after.find(d=>d.id===700002)['Driver Rating'],'A');
  assert.equal(new Set(fixture.map(d=>d.profile_key)).size,281);
  await db.exec('rollback');assert.deepEqual((await db.query('select * from atlanta_drivers order by id')).rows,before);
  assert.equal((await db.query('select count(*)::int n from private.driver_profile_sync_backups')).rows[0].n,0);
 }finally{await db.close();}
});
test('stale edits or new off-list shared memberships abort the whole batch before any backup or update',async()=>{
 const db=await database();try{
  const id=fixture[0].id;await db.query('update atlanta_drivers set "Driver Rating"=$1 where id=$2',['D',id]);
  await db.exec('begin');await assert.rejects(db.exec(sql),/changed since review/);await db.exec('rollback');
  assert.equal((await db.query('select count(*)::int n from private.driver_profile_sync_backups')).rows[0].n,0);
  await db.query('update atlanta_drivers set "Driver Rating"=$1 where id=$2',[fixture[0].rating,id]);
  await db.query('insert into atlanta_drivers(id,location,profile_key,"Driver Rating") values(700003,\'houston\',$1,$2)',[fixture[0].profile_key,fixture[0].rating]);
  await db.exec('begin');await assert.rejects(db.exec(sql),/unreviewed membership/);await db.exec('rollback');
  assert.equal((await db.query('select count(*)::int n from private.driver_profile_sync_backups')).rows[0].n,0);
 }finally{await db.close();}
});
test('profile dropdown explicitly labels R Georgia-only; legacy refused load stays D; plain/variant ratings remain supported',()=>{
 const dom=new JSDOM('<input id="ad-rating" value="R">',{runScripts:'outside-only'});
 dom.window.eval(fs.readFileSync('driver-rating-controls.js','utf8')+';installDriverRatingDropdown();');
 const select=dom.window.document.querySelector('select');assert.equal(select.value,'R');assert.equal(select.selectedOptions[0].textContent,'R — Restricted (Georgia only)');
 for(const [raw,wanted] of [['refused load','D'],['Refused','D'],['Restricted','R'],['A1','A'],['B2','B'],['Hard DNU','DNU'],['','']]){select.value=raw;assert.equal(select.value,wanted,raw);}
 dom.window.close();
});
test('A/B grouping includes approved variants; R tooltip explains restriction, without treating old refusal notes as R',()=>{
 const source=fs.readFileSync('loadboard.js','utf8');
 const phrases=source.match(/  const RATING_PHRASE_CLASSES = \{[^]*?\n  \};/)[0];const classify=source.match(/  function driverClassification\([^]*?\n  \}/)[0];
 const api=vm.runInNewContext(phrases+';'+classify+';driverClassification');
 for(const [raw,wanted] of [['A','A'],['A1','A'],['A+','A'],['B2','B'],['core','A'],['core 2','B'],['preferred','B'],['R','R'],['refused load','D']])assert.equal(api({rating:raw}),wanted);
 const variant=vm.runInNewContext('('+source.match(/  function variantTitle\([^]*?\n  \}/)[0]+')');assert.equal(variant([],api,'R'),'Restricted — Georgia routes only');
 assert.ok(source.includes('d.rating === "R" ? "R — Restricted (Georgia only)"'));
});
test('guarded manual rollback restores the saved ratings and refuses later manual changes',async()=>{
 for(const changedLater of [false,true]){
  const db=await database();try{
   const before=(await db.query('select * from atlanta_drivers order by id')).rows;
   await db.exec('begin');await db.exec(sql);await db.exec('commit');
   if(changedLater)await db.query('update atlanta_drivers set "Driver Rating"=$1 where id=$2',['D',fixture[0].id]);
   const rollback=fs.readFileSync('supabase/rollback/atlanta_preferred_rating_cleanup_20261015.sql','utf8');
   if(changedLater){await assert.rejects(db.exec(rollback),/changed after cleanup/);await db.exec('rollback');assert.equal((await db.query('select "Driver Rating" rating from atlanta_drivers where id=$1',[fixture[0].id])).rows[0].rating,'D');}
   else {await db.exec(rollback);assert.deepEqual((await db.query('select * from atlanta_drivers order by id')).rows,before);}
  }finally{await db.close();}
 }
});
