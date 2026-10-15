import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
const read=p=>fs.readFileSync(p,'utf8');
const migration=read('supabase/migrations/20261015180208_accounting_clear_rate_recalculate.sql');

test('cleared Accounting rates recalculate atomically under real money triggers and RLS',async t=>{
 const db=new PGlite();
 try {
  // Reuse the existing daily-rate sandbox schema so both paths run the same
  // current carrier calculator. All records below are synthetic.
  const setup=read('scripts/accounting-refresh-daily-rates.test.mjs').match(/await db.exec\(`([\s\S]*?)`\);/)[1];
  await db.exec(setup);
  await db.exec(read('supabase/migrations/20261012132339_accounting_refresh_daily_rates.sql'));
  await db.exec(read('supabase/migrations/20261012145030_route_total_driver_rate_floor.sql'));
  await db.exec(`
    alter table loads_accounting add source_houston_id bigint, add source_mondelez_id bigint,
      add revenue_level integer default 1, add fsc_rate_snapshot numeric default 3,
      add fsc_payment numeric default 9, add updated_at timestamptz,
      add cancelled_reason text, add total_miles numeric, add total_stops numeric;
    create table loads_houston(id bigint primary key,normal_rate numeric);
    create table mondelez_loads(id bigint primary key,carrier_pay numeric,revenue_total numeric,
      called_off boolean default false,load_cancelled boolean default false,called_off_reason text,load_cancelled_reason text);
    create table pricing_settings(key text primary key,value numeric);
    create table pricing_tiers(table_name text,sort_order integer,min_miles numeric,max_miles numeric,rate numeric);
    create table loads_accounting_routes(id bigint primary key,accounting_id bigint references loads_accounting,
      miles numeric,stops integer,revenue numeric,stop_charge_revenue numeric,total_revenue numeric,
      route_id text default 'Keep route',total_cost numeric default 432);
    insert into pricing_settings values('revenue_1_per_mile',2.4),('revenue_2_per_mile',2.8),
      ('stop_charge_revenue_per_stop',50),('fsc_multiplier',0.133),('fsc_rate',99),
      ('market_revenue_divisor',0.85),('houston_customer_rate',900);
    insert into pricing_tiers values('revenue_1',1,1,140,365),('revenue_2',1,1,140,459);
    insert into board_rate_tiers values(1,'atlanta',0,140,400),(2,'delaware',0,140,700);
    insert into board_rate_daily_overrides values('atlanta','2026-10-14','tier','1',600);
    insert into loads_shifts(id,location,shift_date,carrier_rate) values(1,'atlanta','2026-10-14',400),(2,'delaware','2026-10-14',700),(3,'buildingc','2026-10-14',800);
    update loads_shifts set route_type='hostler',hostler_hours=8 where id=3;
    insert into loads_trips(id,shift_id,route_id,route_miles,stop_count) values(1,1,'A',100,2),(2,2,'B',100,2);
    insert into loads_houston values(4,650);
    insert into mondelez_loads(id,carrier_pay,revenue_total) values(5,750,975);
    insert into loads_accounting(id,source_shift_id,location,shift_date,total_carrier_pay,total_cost,total_revenue,revenue_manual,sent,status)
      values(1,1,'atlanta','2026-10-14',777,777,1234,true,true,'released'),
      (2,2,'delaware','2026-10-14',777,777,1234,true,true,'active'),
      (3,3,'buildingc','2026-10-14',777,777,1234,true,true,'active');
    insert into loads_accounting(id,source_houston_id,location,total_carrier_pay,total_cost,total_revenue,revenue_manual) values(4,4,'houston',777,777,1234,true);
    insert into loads_accounting(id,source_mondelez_id,location,total_carrier_pay,total_cost,total_revenue,revenue_manual) values(5,5,'mondelez',777,777,1234,true);
    insert into loads_accounting_routes(id,accounting_id,miles,stops) values(1,1,100,2),(2,2,100,2),(3,3,100,2);
  `);
  await db.exec(read('sandbox/accounting-clear-rate-triggers.sql'));
  await db.exec(migration);
  await db.exec(`grant usage on schema public,auth to authenticated;
    grant select,update on all tables in schema public to authenticated;
    alter table loads_accounting enable row level security;
    create policy acct on loads_accounting to authenticated using(current_app_role() in ('accounting','admin','it')) with check(current_app_role() in ('accounting','admin','it'));
    alter table loads_accounting_routes enable row level security;
    create policy routes_read on loads_accounting_routes for select to authenticated using(true);
    create policy routes_write on loads_accounting_routes for update to authenticated
      using(current_setting('test.block_routes',true) is distinct from 'yes') with check(true);
    set role authenticated;`);
  const row=async id=>(await db.query('select * from loads_accounting where id=$1',[id])).rows[0];
  const reset=async(id,column)=>(await db.query('select reset_accounting_rate($1,$2) value',[id,column])).rows[0].value;
  await t.test('carrier clear uses current daily card and preserves customer override, status, Sent and source',async()=>{
    const before=await row(1);const a=await reset(1,'total_carrier_pay');
    assert.equal(Number(a.total_carrier_pay),600);assert.equal(Number(a.total_cost),600);assert.equal(a.carrier_pay_manual,false);
    for(const key of ['total_revenue','revenue_manual','status','sent','notes','route_snapshot','pushed_at','push_note'])assert.equal(String(a[key]),String(before[key]),key);
    assert.equal(Number((await db.query('select carrier_rate from loads_shifts where id=1')).rows[0].carrier_rate),400);
  });
  await t.test('customer clear keeps carrier and uses saved FSC and selected Core/Holiday/Market',async()=>{
    let a=await reset(1,'total_revenue');
    assert.equal(Number(a.total_revenue),504.9);assert.equal(a.revenue_manual,false);assert.equal(Number(a.total_carrier_pay),600);
    assert.equal(Number(a.fsc_payment),39.9);assert.equal(Number(a.fsc_rate_snapshot),3);
    await db.exec('update loads_accounting set revenue_level=2,total_revenue=1234,revenue_manual=true where id=1');
    a=await reset(1,'total_revenue');assert.equal(Number(a.total_revenue),598.9);
    const r=(await db.query('select * from loads_accounting_routes where id=1')).rows[0];
    assert.equal(r.route_id,'Keep route');assert.equal(Number(r.total_cost),432);
    await db.exec('update loads_accounting set revenue_level=4 where id=1');
    a=await reset(1,'total_revenue');assert.equal(Number(a.total_revenue),705.88);assert.equal(a.revenue_manual,false);
  });
  await t.test('all other Accounting tabs use their established sources',async()=>{
    for(const [id,carrier,customer] of [[2,700,504.9],[3,800,504.9],[4,650,900],[5,750,975]]) {
      assert.equal(Number((await reset(id,'total_carrier_pay')).total_carrier_pay),carrier);
      assert.equal(Number((await reset(id,'total_revenue')).total_revenue),customer);
    }
  });
  await t.test('explicit zero remains a protected override through daily Refresh',async()=>{
    await db.exec("update loads_accounting set status='active',total_carrier_pay=0,carrier_pay_manual=true,total_revenue=0,revenue_manual=true where id=1");
    await db.query("select refresh_accounting_daily_rates('atlanta','2026-10-14','2026-10-14')");
    const a=await row(1);assert.equal(Number(a.total_carrier_pay),0);assert.equal(Number(a.total_revenue),0);assert.equal(a.carrier_pay_manual,true);assert.equal(a.revenue_manual,true);
    await db.exec('update loads_shifts set rate_manual=true,carrier_rate=0 where id=1');
    assert.equal(Number((await reset(1,'total_carrier_pay')).total_carrier_pay),0,'board manual zero is also valid');
  });
  await t.test('missing inputs and forbidden route writes keep all prior money',async()=>{
    await db.exec('update loads_accounting set source_shift_id=null,total_carrier_pay=777,total_revenue=1234,revenue_level=1 where id=1');
    const before=await row(1);
    await assert.rejects(reset(1,'total_carrier_pay'),/No calculated rate/);
    assert.deepEqual(await row(1),before);
    await db.exec("set test.block_routes='yes'");
    await assert.rejects(reset(1,'total_revenue'),/Route update not permitted/);
    assert.deepEqual(await row(1),before);
    await db.exec("set test.block_routes='no';delete from loads_accounting_routes where id=1").catch(async()=>{
      await db.exec('reset role;delete from loads_accounting_routes where id=1;set role authenticated');
    });
    await assert.rejects(reset(1,'total_revenue'),/No routes available/);
    assert.deepEqual(await row(1),before);
  });
  await t.test('cancelled amounts stay zero; deleted and unauthorized requests are rejected',async()=>{
    await db.exec("update loads_accounting set status='cancelled' where id=2");
    assert.equal(Number((await reset(2,'total_carrier_pay')).total_carrier_pay),0);
    assert.equal(Number((await reset(2,'total_revenue')).total_revenue),0);
    await db.exec("update loads_accounting set status='deleted' where id=2");
    await assert.rejects(reset(2,'total_revenue'),/Restore this deleted/);
    await assert.rejects(reset(3,'status'),/Choose a customer or carrier/);
    await db.exec("set test.app_role='dispatcher'");
    await assert.rejects(reset(3,'total_revenue'),/Accounting access required/);
    await db.exec("set test.app_role='accounting';set test.signed_in='no'");
    await assert.rejects(reset(3,'total_revenue'),/Accounting access required/);
    await db.exec("reset role;set role anon");
    await assert.rejects(reset(3,'total_revenue'),/permission denied/);
  });
 } finally {await db.close();}
});
