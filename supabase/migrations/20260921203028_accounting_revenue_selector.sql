-- Atomic customer-only rate selection. Invoker privileges retain existing RLS.
create or replace function public.set_accounting_revenue_rate(p_accounting_id bigint, p_level integer)
returns jsonb language plpgsql security invoker set search_path = public, pg_catalog
as $$
declare
  a public.loads_accounting%rowtype;
  r record;
  v_base numeric;
  v_per_mile numeric;
  v_stop_rate numeric;
  v_fsc_multiplier numeric;
  v_fsc_rate numeric;
  v_total numeric := 0;
  v_fsc numeric := 0;
  v_count integer;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  if p_level is null or p_level not in (1,2) then raise exception 'Choose Revenue Rate 1 or 2'; end if;
  select * into a from public.loads_accounting where id=p_accounting_id for update;
  if not found then raise exception 'Accounting record not accessible'; end if;
  if a.location <> 'atlanta' or a.status = 'cancelled' then raise exception 'Revenue Rate cannot be changed for this load'; end if;
  select value into v_per_mile from public.pricing_settings where key='revenue_'||p_level||'_per_mile';
  select value into v_stop_rate from public.pricing_settings where key='stop_charge_revenue_per_stop';
  select value into v_fsc_multiplier from public.pricing_settings where key='fsc_multiplier';
  select coalesce(a.fsc_rate_snapshot,value) into v_fsc_rate from public.pricing_settings where key='fsc_rate';
  if v_per_mile is null or v_stop_rate is null or v_fsc_multiplier is null or v_fsc_rate is null then raise exception 'Pricing settings unavailable'; end if;
  if not exists(select 1 from public.loads_accounting_routes where accounting_id=a.id) then raise exception 'No routes available to calculate this load'; end if;
  for r in select * from public.loads_accounting_routes where accounting_id=a.id for update loop
    select rate into v_base from public.pricing_tiers
      where table_name='revenue_'||p_level and coalesce(r.miles,0) between min_miles and max_miles
      order by sort_order limit 1;
    v_base := round(coalesce(v_base,coalesce(r.miles,0)*v_per_mile),2);
    update public.loads_accounting_routes set
      revenue=v_base,
      stop_charge_revenue=round(coalesce(r.stops,0)*v_stop_rate,2),
      total_revenue=round(v_base+coalesce(r.stops,0)*v_stop_rate+v_fsc_rate*v_fsc_multiplier*coalesce(r.miles,0),2)
      where id=r.id;
    get diagnostics v_count = row_count;
    if v_count <> 1 then raise exception 'Route update not permitted'; end if;
    v_total := v_total+round(v_base+coalesce(r.stops,0)*v_stop_rate+v_fsc_rate*v_fsc_multiplier*coalesce(r.miles,0),2);
    v_fsc := v_fsc+v_fsc_rate*v_fsc_multiplier*coalesce(r.miles,0);
  end loop;
  update public.loads_accounting set revenue_level=p_level,total_revenue=round(v_total,2),fsc_payment=round(v_fsc,2)
    where id=a.id returning * into a;
  if not found then raise exception 'Accounting update not permitted'; end if;
  return to_jsonb(a);
end;
$$;
revoke all on function public.set_accounting_revenue_rate(bigint,integer) from public,anon;
grant execute on function public.set_accounting_revenue_rate(bigint,integer) to authenticated;

-- Honor the saved Holiday choice on subsequent live route syncs.
CREATE OR REPLACE FUNCTION app_private.sync_standard_accounting_routes_for_shift(p_shift_id bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v_accounting_id bigint;
  v_location text;
  v_revenue_level integer;
  v_fsc_rate numeric;
  v_total_revenue numeric;
  v_total_miles numeric;
  v_total_stops numeric;
  v_total_fsc numeric;
begin
  select a.id,
         a.location,
         a.revenue_level,
         coalesce(
           a.fsc_rate_snapshot,
           (select ps.value from public.pricing_settings ps where ps.key='fsc_rate' limit 1),
           0
         )
    into v_accounting_id, v_location, v_revenue_level, v_fsc_rate
  from public.loads_accounting a
  where a.source_shift_id = p_shift_id
    and a.location in ('atlanta','buildingc','delaware')
    and coalesce(a.status,'active') = 'active'
  order by a.id desc
  limit 1;

  if v_accounting_id is null then
    return;
  end if;

  -- Remove snapshots for routes that no longer exist on the live load.
  delete from public.loads_accounting_routes ar
  where ar.accounting_id = v_accounting_id
    and not exists (
      select 1
      from public.loads_trips t
      where t.shift_id = p_shift_id
        and t.trip_number = ar.route_number
        and (
          nullif(btrim(coalesce(t.route_id,'')), '') is not null
          or nullif(btrim(coalesce(t.trip_id,'')), '') is not null
        )
    );

  -- Copy every current live route into Accounting. The customer calculation
  -- intentionally matches the server-owned 04:00 transfer calculation so a
  -- late route prices exactly as though it had existed at transfer time.
  insert into public.loads_accounting_routes (
    accounting_id, route_number, route_id, trip_id, trailer, miles, stops,
    linehaul_cost, stop_charge, total_cost,
    revenue, stop_charge_revenue, total_revenue
  )
  select
    v_accounting_id,
    t.trip_number,
    t.route_id,
    t.trip_id,
    t.trailer_out,
    coalesce(t.route_miles,0),
    coalesce(t.stop_count,0),
    0,
    0,
    0,
    app_private.kroger_customer_base_rate(coalesce(t.route_miles,0), case when v_location = 'atlanta' and v_revenue_level = 2 then 'holiday' else 'weekday' end),
    round(coalesce(t.stop_count,0) * 50, 2),
    round(
      app_private.kroger_customer_base_rate(coalesce(t.route_miles,0), case when v_location = 'atlanta' and v_revenue_level = 2 then 'holiday' else 'weekday' end)
      + (coalesce(t.stop_count,0) * 50)
      + (v_fsc_rate * 0.133 * coalesce(t.route_miles,0)),
      2
    )
  from public.loads_trips t
  where t.shift_id = p_shift_id
    and t.trip_number is not null
    and (
      nullif(btrim(coalesce(t.route_id,'')), '') is not null
      or nullif(btrim(coalesce(t.trip_id,'')), '') is not null
    )
  on conflict (accounting_id, route_number) do update
    set route_id = excluded.route_id,
        trip_id = excluded.trip_id,
        trailer = excluded.trailer,
        miles = excluded.miles,
        stops = excluded.stops,
        linehaul_cost = excluded.linehaul_cost,
        stop_charge = excluded.stop_charge,
        total_cost = excluded.total_cost,
        revenue = excluded.revenue,
        stop_charge_revenue = excluded.stop_charge_revenue,
        total_revenue = excluded.total_revenue;

  select coalesce(sum(ar.total_revenue),0),
         coalesce(sum(ar.miles),0),
         coalesce(sum(ar.stops),0),
         coalesce(sum(v_fsc_rate * 0.133 * coalesce(ar.miles,0)),0)
    into v_total_revenue, v_total_miles, v_total_stops, v_total_fsc
  from public.loads_accounting_routes ar
  where ar.accounting_id = v_accounting_id;

  update public.loads_accounting a
     set total_revenue = round(v_total_revenue,2),
         total_miles = v_total_miles,
         total_stops = v_total_stops,
         fsc_payment = round(v_total_fsc,2)
   where a.id = v_accounting_id;
end;
$function$
;
