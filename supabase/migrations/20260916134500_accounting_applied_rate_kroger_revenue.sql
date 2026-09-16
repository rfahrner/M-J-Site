-- Accounting v2: the carrier rate comes from the load board; customer revenue
-- is Kroger mileage tier + $50/stop + FSC rate * .133 * route miles.
-- cost_level is retained only as compact storage for the new Applied label:
--   1 = Base rate, 2 = Driver Rate, 3 = Daily Rate.
-- revenue_level = 99 marks rows using the new semantics; it is no longer a
-- selectable pricing mechanic.

-- Exact Kroger Revenue Core / Holiday tables supplied by Accounting.
with desired(table_name, sort_order, min_miles, max_miles, rate) as (
  values
    ('revenue_1',1,0::numeric,0.99::numeric,0::numeric),
    ('revenue_1',2,1,25,281),
    ('revenue_1',3,25.01,60,309),
    ('revenue_1',4,60.01,90,365),
    ('revenue_1',5,90.01,100,365),
    ('revenue_1',6,100.01,110,365),
    ('revenue_1',7,110.01,120,365),
    ('revenue_1',8,120.01,140,365),
    ('revenue_1',9,140.01,152,365),
    ('revenue_1',10,153.01,175,421),
    ('revenue_2',1,0,0.99,0),
    ('revenue_2',2,1,25,294),
    ('revenue_2',3,25.01,60,412),
    ('revenue_2',4,60.01,90,459),
    ('revenue_2',5,90.01,100,459),
    ('revenue_2',6,100.01,110,459),
    ('revenue_2',7,110.01,120,459),
    ('revenue_2',8,120.01,140,459),
    ('revenue_2',9,140.01,163,459)
)
update public.pricing_tiers p
set min_miles=d.min_miles, max_miles=d.max_miles, rate=d.rate
from desired d
where p.table_name=d.table_name and p.sort_order=d.sort_order;

delete from public.pricing_tiers
where (table_name='revenue_1' and sort_order > 10)
   or (table_name='revenue_2' and sort_order > 9);

update public.pricing_settings set value=0.133 where key='fsc_multiplier';
update public.pricing_settings set value=50 where key='stop_charge_revenue_per_stop';
update public.pricing_settings set value=2.40 where key='revenue_1_per_mile';
update public.pricing_settings set value=2.80 where key='revenue_2_per_mile';

create or replace function app_private.kroger_customer_base_rate(
  p_miles numeric,
  p_day_type text
) returns numeric
language plpgsql
stable
set search_path = public, pg_catalog
as $$
declare
  v_table text;
  v_rate numeric;
  v_per_mile numeric;
  v_miles numeric := coalesce(p_miles, 0);
begin
  v_table := case when lower(btrim(coalesce(p_day_type,'')))='holiday'
                  then 'revenue_2' else 'revenue_1' end;

  select pt.rate into v_rate
  from public.pricing_tiers pt
  where pt.table_name=v_table
    and v_miles between pt.min_miles and pt.max_miles
  order by pt.sort_order
  limit 1;

  if v_rate is not null then
    return round(v_rate, 2);
  end if;

  select ps.value into v_per_mile
  from public.pricing_settings ps
  where ps.key=case when v_table='revenue_2' then 'revenue_2_per_mile' else 'revenue_1_per_mile' end
  limit 1;

  return round(v_miles * coalesce(v_per_mile,0), 2);
end;
$$;

create or replace function app_private.accounting_v2_defaults()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_rate numeric;
begin
  if new.source_shift_id is not null and coalesce(new.status,'active') <> 'cancelled' then
    new.cost_level := 1;
    new.revenue_level := 99;
    if new.fsc_rate_snapshot is null then
      select value into new.fsc_rate_snapshot from public.pricing_settings where key='fsc_rate' limit 1;
    end if;
    select carrier_rate into v_rate from public.loads_shifts where id=new.source_shift_id;
    new.total_carrier_pay := v_rate;
    new.total_cost := v_rate;
  elsif new.source_houston_id is not null and coalesce(new.status,'active') <> 'cancelled' then
    select normal_rate into v_rate from public.loads_houston where id=new.source_houston_id;
    new.total_carrier_pay := v_rate;
    new.total_cost := v_rate;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_accounting_v2_defaults on public.loads_accounting;
create trigger trg_accounting_v2_defaults
before insert on public.loads_accounting
for each row execute function app_private.accounting_v2_defaults();

create or replace function app_private.enforce_atlanta_accounting_v2()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_board_rate numeric;
  v_fsc_rate numeric;
  v_customer numeric;
  v_fsc_payment numeric;
  v_miles numeric;
  v_stops numeric;
begin
  if new.location <> 'atlanta' or new.source_shift_id is null or coalesce(new.status,'active')='cancelled' then
    return new;
  end if;

  if new.fsc_rate_snapshot is null then
    select value into new.fsc_rate_snapshot from public.pricing_settings where key='fsc_rate' limit 1;
  end if;
  v_fsc_rate := coalesce(new.fsc_rate_snapshot,0);

  select s.carrier_rate into v_board_rate
  from public.loads_shifts s
  where s.id=new.source_shift_id;

  select
    coalesce(sum(
      app_private.kroger_customer_base_rate(coalesce(r.miles,0), new.day_type)
      + coalesce(r.stops,0) * 50
      + v_fsc_rate * 0.133 * coalesce(r.miles,0)
    ),0),
    coalesce(sum(v_fsc_rate * 0.133 * coalesce(r.miles,0)),0),
    coalesce(sum(coalesce(r.miles,0)),0),
    coalesce(sum(coalesce(r.stops,0)),0)
  into v_customer, v_fsc_payment, v_miles, v_stops
  from public.loads_accounting_routes r
  where r.accounting_id=new.id;

  new.total_carrier_pay := v_board_rate;
  new.total_cost := v_board_rate;
  new.total_revenue := round(v_customer,2);
  new.fsc_payment := round(v_fsc_payment,2);
  new.total_miles := v_miles;
  new.total_stops := v_stops;
  new.revenue_level := 99;
  return new;
end;
$$;

drop trigger if exists trg_enforce_atlanta_accounting_v2 on public.loads_accounting;
create trigger trg_enforce_atlanta_accounting_v2
before update of total_cost, total_revenue, total_carrier_pay, day_type on public.loads_accounting
for each row execute function app_private.enforce_atlanta_accounting_v2();

create or replace function app_private.refresh_atlanta_accounting_route_v2()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_location text;
  v_day_type text;
  v_fsc_rate numeric;
  v_base numeric;
  v_stop numeric;
  v_fsc numeric;
begin
  select a.location, a.day_type,
         coalesce(a.fsc_rate_snapshot,(select value from public.pricing_settings where key='fsc_rate' limit 1),0)
  into v_location, v_day_type, v_fsc_rate
  from public.loads_accounting a
  where a.id=new.accounting_id;

  if v_location <> 'atlanta' then return new; end if;

  v_base := app_private.kroger_customer_base_rate(coalesce(new.miles,0), v_day_type);
  v_stop := round(coalesce(new.stops,0) * 50,2);
  v_fsc := round(v_fsc_rate * 0.133 * coalesce(new.miles,0),2);

  update public.loads_accounting_routes
  set linehaul_cost=0,
      stop_charge=0,
      total_cost=0,
      revenue=v_base,
      stop_charge_revenue=v_stop,
      total_revenue=round(v_base + v_stop + v_fsc,2)
  where id=new.id;

  -- Recalculate the parent from every route now on file. The parent trigger
  -- enforces both the customer formula and the board-supplied carrier rate.
  update public.loads_accounting
  set total_revenue=total_revenue
  where id=new.accounting_id;

  return new;
end;
$$;

drop trigger if exists trg_refresh_atlanta_accounting_route_v2 on public.loads_accounting_routes;
create trigger trg_refresh_atlanta_accounting_route_v2
after insert or update of miles, stops on public.loads_accounting_routes
for each row execute function app_private.refresh_atlanta_accounting_route_v2();

create or replace function app_private.refresh_atlanta_routes_for_day_type_v2()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_fsc_rate numeric;
begin
  if new.location <> 'atlanta' then return new; end if;
  v_fsc_rate := coalesce(new.fsc_rate_snapshot,(select value from public.pricing_settings where key='fsc_rate' limit 1),0);

  update public.loads_accounting_routes r
  set linehaul_cost=0,
      stop_charge=0,
      total_cost=0,
      revenue=app_private.kroger_customer_base_rate(coalesce(r.miles,0), new.day_type),
      stop_charge_revenue=round(coalesce(r.stops,0)*50,2),
      total_revenue=round(
        app_private.kroger_customer_base_rate(coalesce(r.miles,0), new.day_type)
        + coalesce(r.stops,0)*50
        + v_fsc_rate*0.133*coalesce(r.miles,0),2)
  where r.accounting_id=new.id;

  return new;
end;
$$;

drop trigger if exists trg_refresh_atlanta_routes_for_day_type_v2 on public.loads_accounting;
create trigger trg_refresh_atlanta_routes_for_day_type_v2
after update of day_type on public.loads_accounting
for each row execute function app_private.refresh_atlanta_routes_for_day_type_v2();

create or replace function app_private.sync_accounting_carrier_from_shift_v2()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  update public.loads_accounting
  set total_carrier_pay=new.carrier_rate,
      total_cost=new.carrier_rate
  where source_shift_id=new.id
    and coalesce(status,'active') <> 'cancelled';
  return new;
end;
$$;

drop trigger if exists trg_sync_accounting_carrier_from_shift_v2 on public.loads_shifts;
create trigger trg_sync_accounting_carrier_from_shift_v2
after update of carrier_rate on public.loads_shifts
for each row
when (old.carrier_rate is distinct from new.carrier_rate)
execute function app_private.sync_accounting_carrier_from_shift_v2();

create or replace function app_private.sync_accounting_carrier_from_houston_v2()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  update public.loads_accounting
  set total_carrier_pay=new.normal_rate,
      total_cost=new.normal_rate
  where source_houston_id=new.id
    and coalesce(status,'active') <> 'cancelled';
  return new;
end;
$$;

drop trigger if exists trg_sync_accounting_carrier_from_houston_v2 on public.loads_houston;
create trigger trg_sync_accounting_carrier_from_houston_v2
after update of normal_rate on public.loads_houston
for each row
when (old.normal_rate is distinct from new.normal_rate)
execute function app_private.sync_accounting_carrier_from_houston_v2();

-- The legacy Delaware trigger used to substitute its own calculated carrier
-- rate. Keep the trigger in place for compatibility, but make its function
-- obey the same rule as every board: Accounting receives the board rate.
create or replace function public.sync_delaware_accounting_carrier_rate()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
declare
  v_rate numeric;
begin
  if new.location='delaware' and new.source_shift_id is not null then
    select s.carrier_rate into v_rate from public.loads_shifts s where s.id=new.source_shift_id;
    new.total_carrier_pay := v_rate;
    new.total_cost := v_rate;
  end if;
  return new;
end;
$$;

-- Backfill active linked accounting rows. Historical/released rows stay frozen.
update public.loads_accounting a
set fsc_rate_snapshot=coalesce(a.fsc_rate_snapshot,(select value from public.pricing_settings where key='fsc_rate' limit 1)),
    cost_level=case when a.cost_level between 1 and 3 then a.cost_level else 1 end,
    revenue_level=99
where a.location='atlanta'
  and a.source_shift_id is not null
  and coalesce(a.status,'active')='active';

update public.loads_accounting_routes r
set linehaul_cost=0,
    stop_charge=0,
    total_cost=0,
    revenue=app_private.kroger_customer_base_rate(coalesce(r.miles,0),a.day_type),
    stop_charge_revenue=round(coalesce(r.stops,0)*50,2),
    total_revenue=round(
      app_private.kroger_customer_base_rate(coalesce(r.miles,0),a.day_type)
      + coalesce(r.stops,0)*50
      + coalesce(a.fsc_rate_snapshot,(select value from public.pricing_settings where key='fsc_rate' limit 1),0)*0.133*coalesce(r.miles,0),2)
from public.loads_accounting a
where r.accounting_id=a.id
  and a.location='atlanta'
  and a.source_shift_id is not null
  and coalesce(a.status,'active')='active';

update public.loads_accounting a
set total_carrier_pay=s.carrier_rate,
    total_cost=s.carrier_rate,
    total_revenue=a.total_revenue
from public.loads_shifts s
where a.source_shift_id=s.id
  and coalesce(a.status,'active')='active';

update public.loads_accounting a
set total_carrier_pay=h.normal_rate,
    total_cost=h.normal_rate
from public.loads_houston h
where a.source_houston_id=h.id
  and coalesce(a.status,'active')='active';
