import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
const read=p=>fs.readFileSync(p,'utf8');
const source=read('accounting.js');
const deleteFn=source.match(/async function deleteAccountingRecord\([\s\S]*?\n  \}/)[0];
function controller({confirm=true,fail=false,flushFail=false}={}) {
 const rec={id:9,aljex_load_number:'TEST-9',driver_name_text:'Test Driver',hidden:false,status:'active'};
 const calls=[];const pending=new Set();
 const api=new Function('getAccountingRecordById','pendingAccountingChecks','confirm','getAccountingMoneyQueue','saveAccountingFields','supabaseClient','setDriverSyncStatus','renderAccountingTable',`${deleteFn};return deleteAccountingRecord;`)(
   id=>String(id)==='9'?rec:null,pending,()=>confirm,()=>({flush:async()=>{calls.push('flush');if(flushFail)throw Error('Save failed');}}),
   async(c,id,patch)=>{calls.push({id,patch});if(fail)throw Error('Access denied');return {...patch,id};}, {},
   (message,tone)=>calls.push({message,tone}),()=>calls.push('render'));
 return {api,rec,calls,pending};
}
test('delete saves pending rates first, marks only Accounting removed, and then redraws',async()=>{
 const x=controller();await x.api(9);
 assert.equal(x.calls[0],'flush');assert.equal(x.calls[1].id,9);
 assert.equal(x.calls[1].patch.hidden,true);assert.equal(x.calls[1].patch.status,'deleted');
 assert.ok(Date.parse(x.calls[1].patch.deleted_at));assert.equal(x.rec.hidden,true);
 assert.equal(x.pending.size,0);assert.equal(x.calls.at(-1),'render');
 assert.doesNotMatch(deleteFn,/\.from\(|SHIFTS_TABLE|MONDELEZ_TABLE|loads_houston/);
});
test('cancel, inaccessible rows, failed saves, and failed pending edits never hide a row',async()=>{
 for(const options of [{confirm:false},{fail:true},{flushFail:true}]) {
  const x=controller(options);await x.api(9);assert.equal(x.rec.hidden,false);assert.equal(x.rec.status,'active');assert.equal(x.pending.size,0);
 }
 const x=controller();await x.api(999);assert.deepEqual(x.calls,[]);
});
test('hidden Accounting deletion survives later pushes/cancellations without removing source or route records',async()=>{
 const db=new PGlite();
 try {
  await db.exec(`create role anon;create role authenticated;create schema app_private;
    create table loads_shifts(id bigint primary key,carrier_rate numeric);
    create table loads_houston(id bigint primary key,normal_rate numeric);
    create table mondelez_loads(id bigint primary key,carrier_pay numeric,revenue_total numeric,called_off boolean,load_cancelled boolean,called_off_reason text,load_cancelled_reason text);
    create table loads_accounting(id bigint primary key,source_shift_id bigint references loads_shifts on delete set null,
      source_houston_id bigint references loads_houston,source_mondelez_id bigint references mondelez_loads,
      location text,shift_date date,hidden boolean default false,status text default 'active',deleted_at timestamptz,
      total_carrier_pay numeric,total_cost numeric,total_revenue numeric,carrier_pay_manual boolean,revenue_manual boolean,
      fsc_payment numeric,fsc_rate_snapshot numeric,total_miles numeric,total_stops numeric,cancelled_reason text,
      updated_at timestamptz,pushed_at timestamptz,sent boolean default true);
    create table loads_accounting_routes(id bigint primary key,accounting_id bigint references loads_accounting on delete cascade,route_id text);
    create table analytics_financial_history(original_accounting_id bigint primary key,original_shift_id bigint,
      shift_date date,location text,total_cost numeric,total_revenue numeric);
    alter table analytics_financial_history enable row level security;
    create policy history_read on analytics_financial_history for select to authenticated using(true);
    insert into loads_shifts values(1,600);insert into loads_houston values(2,650);
    insert into mondelez_loads values(3,700,900,false,false,null,null);
    insert into loads_accounting(id,source_shift_id,location,total_carrier_pay,total_cost,total_revenue) values(1,1,'atlanta',600,600,900);
    insert into loads_accounting(id,source_houston_id,location,total_carrier_pay,total_cost,total_revenue) values(2,2,'houston',650,650,950);
    insert into loads_accounting(id,source_mondelez_id,location,total_carrier_pay,total_cost,total_revenue) values(3,3,'mondelez',700,700,1000);
    insert into loads_accounting_routes values(1,1,'KEEP');
  `);
  await db.exec(read('sandbox/accounting-clear-rate-triggers.sql'));
  await db.exec(read('supabase/migrations/20261015185450_accounting_row_removal.sql'));
  await db.exec(`alter table loads_accounting enable row level security;
    create policy read_rows on loads_accounting for select to authenticated using(true);
    create policy edit_rows on loads_accounting for update to authenticated using(current_setting('test.deny',true) is distinct from 'yes') with check(true);
    grant usage on schema public to authenticated;grant select on all tables in schema public to authenticated;grant update on loads_accounting to authenticated;
    set role authenticated;
    update loads_accounting set hidden=true,status='deleted',deleted_at='2026-10-15T19:00:00Z';
  `);
  const before=(await db.query('select * from loads_accounting order by id')).rows;
  assert.equal(before.filter(x=>x.hidden&&x.status==='deleted').length,3);
  assert.equal((await db.query("select count(*) from loads_accounting where status<>'deleted'")).rows[0].count,0);
  // Same retained-link eligibility rule used by the three automatic transfers.
  for(const [table,col] of [['loads_shifts','source_shift_id'],['loads_houston','source_houston_id'],['mondelez_loads','source_mondelez_id']]) {
    assert.equal((await db.query(`select count(*) from ${table} s where not exists(select 1 from loads_accounting a where a.${col}=s.id)`)).rows[0].count,0);
    assert.equal((await db.query(`select count(*) from ${table}`)).rows[0].count,1);
  }
  await db.exec("update loads_accounting set total_carrier_pay=222,total_cost=222,total_revenue=333,status='active',deleted_at=null,pushed_at=now()");
  await db.exec("reset role;update mondelez_loads set load_cancelled=true,load_cancelled_reason='Later cancellation' where id=3;set role authenticated;update loads_accounting set status='cancelled' where id=3");
  const after=(await db.query('select * from loads_accounting order by id')).rows;
  for(let i=0;i<3;i++)for(const key of ['hidden','status','deleted_at','total_carrier_pay','total_cost','total_revenue','sent'])assert.deepEqual(after[i][key],before[i][key],key);
  assert.equal((await db.query('select route_id from loads_accounting_routes')).rows[0].route_id,'KEEP');
  await db.exec("set test.deny='yes'");
  assert.equal((await db.query('update loads_accounting set hidden=false returning id')).rows.length,0);
  // Foreign-key cleanup still works when a source is subsequently deleted.
  await db.exec('reset role;delete from loads_shifts where id=1');
  const a=(await db.query('select * from loads_accounting where id=1')).rows[0];
  assert.equal(a.source_shift_id,null);assert.equal(a.status,'deleted');assert.equal(a.hidden,true);assert.equal(Number(a.total_revenue),900);
  // The real archive writer inserts these exact financial columns before
  // deleting the live Accounting row. Its new trigger retains removal state.
  await db.exec(`insert into analytics_financial_history(original_accounting_id,original_shift_id,shift_date,location,total_cost,total_revenue)
    select id,source_shift_id,shift_date,location,total_cost,total_revenue from loads_accounting where id=1;
    delete from loads_accounting where id=1;
    insert into analytics_financial_history(original_accounting_id,total_cost,total_revenue) values(99,10,20);
    set role authenticated;`);
  assert.equal((await db.query('select status from analytics_accounting_all where id=1')).rows[0].status,'deleted');
  assert.equal((await db.query('select status from analytics_accounting_all where id=99')).rows[0].status,'active');
  assert.equal((await db.query("select sum(total_revenue) total from analytics_accounting_all where status<>'deleted'")).rows[0].total,'20');
  await db.exec('reset role;set role anon');
  await assert.rejects(db.query('select * from analytics_accounting_all'),/permission denied/);
 }finally{await db.close();}
});
