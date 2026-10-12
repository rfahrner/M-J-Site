import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { PGlite } from '@electric-sql/pglite';

const migration = fs.readFileSync('supabase/migrations/20261012132339_accounting_refresh_daily_rates.sql','utf8');
const board = fs.readFileSync('boardrates.js','utf8');
const loads = fs.readFileSync('loadboard.js','utf8');
const tiers = [
  {id:1,location:'atlanta',min_miles:0,max_miles:25,rate:325},
  {id:2,location:'atlanta',min_miles:26,max_miles:60,rate:355},
  {id:3,location:'atlanta',min_miles:61,max_miles:140,rate:400},
  {id:4,location:'atlanta',min_miles:141,max_miles:170,rate:425},
  {id:5,location:'atlanta',min_miles:171,max_miles:187,rate:450},
];
const settings = {over_tier_per_mile:2.4,stop_charge_free_stops:2,stop_charge_per_stop:20,tonu_flat:150};
const daily = {tiers:{1:525,2:555,3:600,4:625,5:650},settings:{over_tier_per_mile:2.8}};
const shift = {id:1,location:'atlanta',shift_date:'2026-10-11',carrier_rate:400,rate_manual:false,rate_overrides:{},driver_id:null};
const trip = {id:1,shift_id:1,route_id:'TEST',route_miles:118,stop_count:2};

function shippedRate(s,trips,bands,base,day,driver) {
  const d=driver && {...driver,normalRate:driver.normal_rate==null?'':String(driver.normal_rate),
    atlantaRateOverrides:driver.atlanta_rate_overrides,delawareRateOverrides:driver.delaware_rate_overrides};
  const context=vm.createContext({supabaseClient:null,findDriver:()=>d,state:{activeLocation:s.location}});
  for(const file of ['carrier-mileage-tiers.js','boardrates.js']) {
    const source=fs.readFileSync(file,'utf8').replace(/^import[^;]+;\n/gm,'').replace(/export /g,'');
    vm.runInContext(source,context);
  }
  context.bands=bands.map(t=>({...t,min:t.min_miles,max:t.max_miles}));
  context.base=base;context.day=day;context.loc=s.location;
  vm.runInContext('cachedTiers={[loc]:bands};cachedSettings={[loc]:base};cachedDaily={[loc]:{"2026-10-11":day}};',context);
  const fn=loads.match(/export function getEffectiveRateInfo\(row\) \{[\s\S]*?\n  \}/)[0].replace('export ','');
  vm.runInContext(fn,context);
  const row={location:s.location,shiftDate:s.shift_date,driverId:s.driver_id,rate:s.carrier_rate,
    rateOverrides:s.rate_overrides,tonu:s.tonu,routeType:s.route_type,hostlerHours:s.hostler_hours,
    trips:trips.map(t=>({routeId:t.route_id,tripId:t.trip_id,routeMiles:t.route_miles,stopCount:t.stop_count}))};
  const result=context.getEffectiveRateInfo(row);
  return result.notReady?null:result.total;
}

test('daily-rate refresh matches the shipped board calculator and preserves Accounting decisions',async t=>{
  const db=new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated;
      create schema auth; create schema app_private;
      create function auth.uid() returns uuid language sql as $$
        select case when current_setting('test.signed_in',true)='no' then null
          else '00000000-0000-0000-0000-000000000001'::uuid end $$;
      create function public.current_app_role() returns text language sql as $$
        select coalesce(nullif(current_setting('test.app_role',true),''),'accounting') $$;
      create table public.loads_shifts(id bigint primary key,location text,shift_date date,
        carrier_rate numeric,rate_manual boolean default false,rate_overrides jsonb,
        driver_id bigint,load_cancelled boolean default false,called_off boolean default false,
        tonu boolean default false,route_type text,hostler_hours numeric);
      create table public.loads_trips(id bigint primary key,shift_id bigint references loads_shifts,
        route_id text,trip_id text,route_miles numeric,stop_count integer);
      create table public.atlanta_drivers(id bigint primary key,normal_rate numeric,
        atlanta_rate_overrides jsonb,delaware_rate_overrides jsonb);
      create table public.board_rate_tiers(id bigint primary key,location text,min_miles numeric,max_miles numeric,rate numeric);
      create table public.board_rate_settings(location text,key text,value numeric);
      create table public.board_rate_daily_overrides(location text,rate_date date,kind text,rate_key text,value numeric);
      create table public.loads_accounting(id bigint primary key,source_shift_id bigint references loads_shifts,
        location text,shift_date date,status text default 'active',total_carrier_pay numeric,total_cost numeric,
        total_revenue numeric,revenue_manual boolean default false,sent boolean default false,
        push_note text,pushed_at timestamptz,route_snapshot text default 'Original routes',notes text default 'Keep notes');
      create function public.push_shift_to_accounting(p_shift_id bigint,p_pushed_by text)
        returns integer language plpgsql as $$ begin
        update loads_accounting set total_carrier_pay=(select carrier_rate from loads_shifts where id=p_shift_id),
          total_cost=(select carrier_rate from loads_shifts where id=p_shift_id),
          route_snapshot='Full push',total_revenue=9999,pushed_at=now() where source_shift_id=p_shift_id;
        return 1; end $$;
    `);
    for(const x of tiers)await db.query('insert into board_rate_tiers values($1,$2,$3,$4,$5)',[x.id,x.location,x.min_miles,x.max_miles,x.rate]);
    for(const [key,value] of Object.entries(settings))await db.query('insert into board_rate_settings values($1,$2,$3)',['atlanta',key,value]);
    await db.exec("insert into loads_shifts(id,location,shift_date,carrier_rate) values(99,'atlanta','2026-10-11',400);insert into loads_accounting(id,source_shift_id,location,total_carrier_pay,total_cost) values(99,99,'atlanta',777,777)");
    await db.exec(migration);
    const routeFloorMigration=fs.readdirSync('supabase/migrations').find(name=>name.endsWith('_route_total_driver_rate_floor.sql'));
    await db.exec(fs.readFileSync('supabase/migrations/'+routeFloorMigration,'utf8'));
    assert.equal((await db.query('select carrier_pay_manual from loads_accounting where id=99')).rows[0].carrier_pay_manual,true,'legacy different Accounting figure is protected');
    await db.exec(`create trigger rate_push after update of carrier_rate on loads_shifts
      for each row when(old.carrier_rate is distinct from new.carrier_rate)
      execute function app_private.push_accounting_after_shift_rate_change();
      grant usage on schema public,auth to authenticated;
      grant select,update on all tables in schema public to authenticated;
    `);
    for(const table of ['loads_shifts','loads_trips','atlanta_drivers','loads_accounting','board_rate_tiers','board_rate_settings','board_rate_daily_overrides'])await db.exec(`
      alter table ${table} enable row level security;
      create policy internal_access on ${table} to authenticated using(current_app_role() in ('accounting','admin','it')) with check(current_app_role() in ('accounting','admin','it'));
    `);
    await t.test('server and browser agree on tier gaps, overrides, driver floors, stops and flat/hourly rates',async()=>{
      const cases=[];
      for(const loc of ['atlanta','delaware'])for(const miles of [25.9,26,60.9,118,140.9,141,170.9,187.9,200]) {
        cases.push([{...shift,location:loc},[{...trip,route_miles:miles,stop_count:4}],tiers,settings,daily,null]);
      }
      cases.push([shift,[trip],tiers,settings,daily,null]);
      cases.push([{...shift,rate_overrides:{tiers:{3:700}}},[trip],tiers,settings,daily,null]);
      for(const normal of [500,800])for(const card of [{},{tiers:{3:750},settings:{stop_charge_free_stops:1,stop_charge_per_stop:35}}]) {
        cases.push([{...shift,driver_id:7},[{...trip,stop_count:4}],tiers,settings,daily,{id:7,normal_rate:normal,atlanta_rate_overrides:card}]);
      }
      cases.push([{...shift,tonu:true},[],tiers,settings,{settings:{tonu_flat:250}},null]);
      for(const type of ['birm','hostler','na'])cases.push([{...shift,location:'buildingc',route_type:type,hostler_hours:8},[],[],{birm_flat:800,hostler_hourly:100},{settings:{birm_flat:900,hostler_hourly:125}},null]);
      cases.push([{...shift,driver_id:7},[trip],tiers,settings,daily,null]);
      cases.push([shift,[trip],[],settings,daily,null]);
      // Reported load 2010710: Loui's usual $1000 cannot replace the sum of
      // Delaware's four entered routes (a fifth blank editor is ignored).
      const delawareBands=tiers.map((t,i)=>({...t,id:16+i,min_miles:[0,26,76,151,201][i],max_miles:[25,75,150,200,250][i],rate:[600,700,800,900,1000][i]}));
      const reportedTrips=[15,47,48,106].map((m,i)=>({...trip,id:i+1,route_miles:m}));
      reportedTrips.push({id:5,route_id:'',route_miles:999,stop_count:0});
      cases.push([{...shift,location:'delaware',driver_id:6079},reportedTrips,delawareBands,{}, {tiers:{},settings:{}},{id:6079,normal_rate:1000}]);
      assert.equal(shippedRate(...cases.at(-1)),2800,'reported four-route total');
      cases.push([{...shift,location:'delaware',driver_id:6079},reportedTrips,delawareBands,{}, {tiers:{},settings:{}},{id:6079,normal_rate:3500}]);
      assert.equal(shippedRate(...cases.at(-1)),3500,'a higher negotiated minimum still wins');
      for(const args of cases) {
        const result=await db.query('select accounting_refresh_carrier_total($1::jsonb,$2::jsonb,$3::jsonb,$4::jsonb,$5::jsonb,$6::jsonb) value',args.map(x=>x===null?null:JSON.stringify(x)));
        assert.equal(result.rows[0].value===null?null:Number(result.rows[0].value),shippedRate(...args),JSON.stringify(args));
      }
    });
    async function reset() {
      await db.exec('reset role;truncate loads_accounting,loads_trips,loads_shifts,atlanta_drivers,board_rate_daily_overrides,board_rate_daily_refresh_dates cascade');
      await db.exec(`insert into loads_shifts(id,location,shift_date,carrier_rate,rate_overrides) values(1,'atlanta','2026-10-11',400,'{}');
        insert into loads_trips(id,shift_id,route_id,route_miles,stop_count) values(1,1,'TEST',118,2);
        insert into loads_accounting(id,source_shift_id,location,shift_date,total_carrier_pay,total_cost,total_revenue,revenue_manual,sent)
          values(1,1,'atlanta','2026-10-11',400,400,1234.56,true,true);
        insert into board_rate_daily_overrides values('atlanta','2026-10-11','tier','3',600);
        select set_config('test.app_role','accounting',false),set_config('test.signed_in','yes',false);`);
    }
    const refresh=async()=>{await db.exec('set role authenticated');return (await db.query("select refresh_accounting_daily_rates('atlanta','2026-10-11','2026-10-11') value")).rows[0].value;};
    await t.test('a rate corrected after Accounting push updates both places, without re-push, repricing or duplicate loads',async()=>{
      await reset();assert.deepEqual(await refresh(),{checked:1,updated:1});
      const a=(await db.query('select * from loads_accounting')).rows[0];
      assert.equal(Number(a.total_carrier_pay),600);assert.equal(Number(a.total_cost),600);
      assert.equal(Number(a.total_revenue),1234.56);assert.equal(a.revenue_manual,true);assert.equal(a.sent,true);assert.equal(a.status,'active');
      assert.equal(a.route_snapshot,'Original routes');assert.equal(a.notes,'Keep notes');assert.match(a.push_note,/Daily rate checked/);
      assert.equal(Number((await db.query('select carrier_rate from loads_shifts')).rows[0].carrier_rate),600);
      assert.equal((await db.query("select current_setting('app.accounting_rate_refresh',true) value")).rows[0].value,'');
      const before=await db.query('select * from loads_accounting');assert.deepEqual(await refresh(),{checked:1,updated:0});
      assert.deepEqual((await db.query('select * from loads_accounting')).rows,before.rows,'repeat refresh does not churn amounts or notes');
    });
    await t.test('manual Accounting pay survives, while a manual board rate is never recalculated',async()=>{
      await reset();await db.exec('update loads_accounting set total_carrier_pay=777,total_cost=777,carrier_pay_manual=true');
      assert.deepEqual(await refresh(),{checked:1,updated:0});assert.equal(Number((await db.query('select total_carrier_pay from loads_accounting')).rows[0].total_carrier_pay),777);
      await reset();await db.exec('update loads_shifts set rate_manual=true');assert.deepEqual(await refresh(),{checked:0,updated:0});
      assert.equal(Number((await db.query('select carrier_rate from loads_shifts')).rows[0].carrier_rate),400);
    });
    await t.test('older frontend tabs get manual protection even without sending the new flag',async()=>{
      await reset();await db.exec('update loads_accounting set total_carrier_pay=777');
      assert.equal((await db.query('select carrier_pay_manual from loads_accounting')).rows[0].carrier_pay_manual,true);
      assert.deepEqual(await refresh(),{checked:1,updated:0});
      await db.exec('update loads_accounting set total_carrier_pay=null');
      assert.equal((await db.query('select carrier_pay_manual from loads_accounting')).rows[0].carrier_pay_manual,false);
      assert.deepEqual(await refresh(),{checked:1,updated:1});
    });
    await t.test('released, cancelled, deleted and unrelated days/tabs are left alone; no Accounting insert',async()=>{
      for(const status of ['released','cancelled','deleted']) {
        await reset();await db.query('update loads_accounting set status=$1',[status]);assert.deepEqual(await refresh(),{checked:0,updated:0});
        assert.equal(Number((await db.query('select total_carrier_pay from loads_accounting')).rows[0].total_carrier_pay),400);
      }
      await reset();await db.exec('delete from loads_accounting');assert.deepEqual(await refresh(),{checked:0,updated:0});
      assert.equal((await db.query('select * from loads_accounting')).rows.length,0);
      await reset();await db.exec('delete from board_rate_daily_overrides;delete from board_rate_daily_refresh_dates');assert.deepEqual(await refresh(),{checked:0,updated:0});
      await reset();assert.deepEqual((await db.query("select refresh_accounting_daily_rates('delaware','2026-10-11','2026-10-11') value")).rows[0].value,{checked:0,updated:0});
    });
    await t.test('clearing the last daily override returns its loads to base rates',async()=>{
      await reset();assert.deepEqual(await refresh(),{checked:1,updated:1});
      await db.exec('reset role;delete from board_rate_daily_overrides');
      assert.deepEqual(await refresh(),{checked:1,updated:1});
      assert.equal(Number((await db.query('select total_carrier_pay from loads_accounting')).rows[0].total_carrier_pay),400);
    });
    await t.test('permission failures roll back all changes and callers cannot bypass RLS',async()=>{
      await reset();await db.exec('revoke update on loads_accounting from authenticated');
      await assert.rejects(refresh(),/permission denied/);await db.exec('reset role;grant update on loads_accounting to authenticated');
      assert.equal(Number((await db.query('select carrier_rate from loads_shifts')).rows[0].carrier_rate),400);
      await db.exec("select set_config('test.app_role','dispatcher',false)");await assert.rejects(refresh(),/Accounting access required/);
      await db.exec("reset role;select set_config('test.app_role','accounting',false),set_config('test.signed_in','no',false)");await assert.rejects(refresh(),/Accounting access required/);
      await db.exec('reset role');assert.equal((await db.query("select has_function_privilege('anon','public.refresh_accounting_daily_rates(text,date,date)','execute') value")).rows[0].value,false);
    });
    await t.test('ordinary board rate edits still use the existing automatic push',async()=>{
      await reset();await db.exec('update loads_accounting set carrier_pay_manual=true;update loads_shifts set carrier_rate=650');
      const a=(await db.query('select * from loads_accounting')).rows[0];assert.equal(Number(a.total_carrier_pay),650);assert.equal(a.route_snapshot,'Full push');assert.equal(a.carrier_pay_manual,false);
      await db.exec('update loads_accounting set carrier_pay_manual=true;select push_shift_to_accounting(1,null)');
      assert.equal((await db.query('select carrier_pay_manual from loads_accounting')).rows[0].carrier_pay_manual,false,'trip-edit pushes take ownership too');
    });
  }finally{await db.close();}
});
