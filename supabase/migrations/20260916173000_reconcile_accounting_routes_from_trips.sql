-- Keep active Atlanta Accounting route rows synchronized with the live load's
-- loads_trips rows. Accounting can be created at the 04:00 cutoff before a
-- dispatcher finishes entering every route; late routes must not be omitted
-- from Customer Rate / miles / stops.

-- The board now supports more than five routes on a load. Accounting's old
-- 1..5 check made route 6+ impossible to copy over.
alter table public.loads_accounting_routes
  drop constraint if exists loads_accounting_routes_route_number_check;
alter table public.loads_accounting_routes
  add constraint loads_accounting_routes_route_number_check check (route_number >= 1);

create or replace function app_private.sync_atlanta_accounting_routes_for_shift(
  p_shift_id bigint,
  p_force_reprice boolean default false
)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_accounting_id bigint;
  v_fsc_rate numeric;
  v_total_revenue numeric;
  v_total_miles numeric;
  v_total_stops numeric;
  v_total_fsc numeric;
begin
  select a.id,
         coalesce(
           a.fsc_rate_snapshot,
           (select ps.value from public.pricing_settings ps where ps.key='fsc_rate' limit 1),
           0
         )
    into v_accounting_id, v_fsc_rate
  from public.loads_accounting a
  where a.source_shift_id = p_shift_id
    and a.location = 'atlanta'
    and a.status = 'active'
  order by a.id desc
  limit 1;

  if v_accounting_id is null then
    return;
  end if;

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
    perform app_private.sync_atlanta_accounting_routes_for_shift(old.shift_id, false);
    return old;
  end if;

  if tg_op = 'UPDATE' and old.shift_id is distinct from new.shift_id then
    perform app_private.sync_atlanta_accounting_routes_for_shift(old.shift_id, false);
  end if;

  perform app_private.sync_atlanta_accounting_routes_for_shift(new.shift_id, false);
  return new;
end;
$$;

drop trigger if exists trg_sync_accounting_after_trip_change on public.loads_trips;
create trigger trg_sync_accounting_after_trip_change
after insert or delete or update of shift_id, trip_number, route_id, trip_id, trailer_out, route_miles, stop_count
on public.loads_trips
for each row
execute function app_private.sync_accounting_after_trip_change();

-- Repair only recent active Accounting rows whose route snapshot is actually
-- out of sync with the source load. This avoids rewriting old historical rows
-- or already-released Accounting records.
do $$
declare
  r record;
begin
  for r in
    select distinct a.source_shift_id
    from public.loads_accounting a
    where a.location = 'atlanta'
      and a.status = 'active'
      and a.source_shift_id is not null
      and a.shift_date >= current_date - 7
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
    perform app_private.sync_atlanta_accounting_routes_for_shift(r.source_shift_id, true);
  end loop;
end;
$$;