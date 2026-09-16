-- Keep active Accounting route snapshots synchronized with the live loads_trips
-- rows for every standard Kroger board (Atlanta, Building C, Delaware).
-- Accounting may be created at the 04:00 cutoff before all routes are entered;
-- late-added/edited/deleted routes must immediately flow into Accounting.

create or replace function app_private.sync_standard_accounting_routes_for_shift(
  p_shift_id bigint
)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_accounting_id bigint;
  v_location text;
  v_fsc_rate numeric;
  v_total_revenue numeric;
  v_total_miles numeric;
  v_total_stops numeric;
  v_total_fsc numeric;
begin
  select a.id,
         a.location,
         coalesce(
           a.fsc_rate_snapshot,
           (select ps.value from public.pricing_settings ps where ps.key='fsc_rate' limit 1),
           0
         )
    into v_accounting_id, v_location, v_fsc_rate
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
    app_private.kroger_customer_base_rate(coalesce(t.route_miles,0), 'weekday'),
    round(coalesce(t.stop_count,0) * 50, 2),
    round(
      app_private.kroger_customer_base_rate(coalesce(t.route_miles,0), 'weekday')
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
$$;

create or replace function app_private.sync_accounting_after_trip_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  if tg_op = 'DELETE' then
    perform app_private.sync_standard_accounting_routes_for_shift(old.shift_id);
    return old;
  end if;

  if tg_op = 'UPDATE' and old.shift_id is distinct from new.shift_id then
    perform app_private.sync_standard_accounting_routes_for_shift(old.shift_id);
  end if;

  perform app_private.sync_standard_accounting_routes_for_shift(new.shift_id);
  return new;
end;
$$;

-- Recreate the route-change trigger so all standard boards use the generalized
-- sync function.
drop trigger if exists trg_sync_accounting_after_trip_change on public.loads_trips;
create trigger trg_sync_accounting_after_trip_change
after insert or delete or update of shift_id, trip_number, route_id, trip_id, trailer_out, route_miles, stop_count
on public.loads_trips
for each row
execute function app_private.sync_accounting_after_trip_change();

-- Repair recent active records only when their Accounting route snapshot is
-- actually out of sync with the current live load. Released/history rows stay
-- frozen, and correctly synchronized active rows are not repriced needlessly.
do $$
declare
  r record;
begin
  for r in
    select distinct a.source_shift_id
    from public.loads_accounting a
    where a.location in ('atlanta','buildingc','delaware')
      and coalesce(a.status,'active') = 'active'
      and a.source_shift_id is not null
      and a.shift_date >= current_date - 14
      and (
        exists (
          select 1
          from public.loads_trips t
          left join public.loads_accounting_routes ar
            on ar.accounting_id = a.id
           and ar.route_number = t.trip_number
          where t.shift_id = a.source_shift_id
            and (
              nullif(btrim(coalesce(t.route_id,'')), '') is not null
              or nullif(btrim(coalesce(t.trip_id,'')), '') is not null
            )
            and (
              ar.id is null
              or coalesce(ar.route_id,'') is distinct from coalesce(t.route_id,'')
              or coalesce(ar.trip_id,'') is distinct from coalesce(t.trip_id,'')
              or coalesce(ar.trailer,'') is distinct from coalesce(t.trailer_out,'')
              or coalesce(ar.miles,0) is distinct from coalesce(t.route_miles,0)
              or coalesce(ar.stops,0) is distinct from coalesce(t.stop_count,0)
            )
        )
        or exists (
          select 1
          from public.loads_accounting_routes ar
          where ar.accounting_id = a.id
            and not exists (
              select 1
              from public.loads_trips t
              where t.shift_id = a.source_shift_id
                and t.trip_number = ar.route_number
                and (
                  nullif(btrim(coalesce(t.route_id,'')), '') is not null
                  or nullif(btrim(coalesce(t.trip_id,'')), '') is not null
                )
            )
        )
      )
  loop
    perform app_private.sync_standard_accounting_routes_for_shift(r.source_shift_id);
  end loop;
end;
$$;