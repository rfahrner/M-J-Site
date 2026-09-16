-- Accounting cutoff + manual Accounting rate edits.
--
-- 1) Completed/time-sheet-complete loads may still arrive immediately.
-- 2) Any real unsent load from a prior operating day is swept into Accounting
--    at/after 04:00 America/Chicago by the existing five-minute cron.
-- 3) Customer Rate and Carrier Rate are editable once the row is in Accounting.
--    Board-rate changes still sync forward through the source-table triggers,
--    but Accounting edits are no longer overwritten merely because the
--    Accounting row itself was edited.
-- 4) Day Type is no longer a pricing control. New automatic customer pricing
--    uses Kroger Revenue Core as its default; Accounting can overtype the final
--    Customer Rate when a special rate is needed.

-- These three legacy/enforcement triggers prevented Accounting from editing
-- the dollar fields directly.
drop trigger if exists trg_enforce_board_carrier_rate_v2 on public.loads_accounting;
drop trigger if exists trg_enforce_atlanta_accounting_v2 on public.loads_accounting;
drop trigger if exists trg_sync_delaware_accounting_carrier_rate on public.loads_accounting;

-- Day Type is no longer exposed and should not cause a hidden recalc.
drop trigger if exists trg_refresh_atlanta_routes_for_day_type_v2 on public.loads_accounting;

-- Route changes still need to refresh the initial calculated customer figure.
-- This version no longer relies on the parent Accounting enforcement trigger;
-- it writes the calculated parent totals directly. Manual parent edits remain
-- untouched until route miles/stops themselves change again.
create or replace function app_private.refresh_atlanta_accounting_route_v2()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_location text;
  v_fsc_rate numeric;
  v_base numeric;
  v_stop numeric;
  v_fsc numeric;
  v_parent_revenue numeric;
  v_parent_fsc numeric;
  v_parent_miles numeric;
  v_parent_stops numeric;
begin
  select a.location,
         coalesce(a.fsc_rate_snapshot,
                  (select value from public.pricing_settings where key='fsc_rate' limit 1),
                  0)
    into v_location, v_fsc_rate
  from public.loads_accounting a
  where a.id=new.accounting_id;

  if v_location <> 'atlanta' then return new; end if;

  v_base := app_private.kroger_customer_base_rate(coalesce(new.miles,0), 'weekday');
  v_stop := round(coalesce(new.stops,0) * 50, 2);
  v_fsc := round(v_fsc_rate * 0.133 * coalesce(new.miles,0), 2);

  update public.loads_accounting_routes
     set linehaul_cost=0,
         stop_charge=0,
         total_cost=0,
         revenue=v_base,
         stop_charge_revenue=v_stop,
         total_revenue=round(v_base + v_stop + v_fsc, 2)
   where id=new.id;

  select coalesce(sum(r.total_revenue),0),
         coalesce(sum(v_fsc_rate * 0.133 * coalesce(r.miles,0)),0),
         coalesce(sum(coalesce(r.miles,0)),0),
         coalesce(sum(coalesce(r.stops,0)),0)
    into v_parent_revenue, v_parent_fsc, v_parent_miles, v_parent_stops
  from public.loads_accounting_routes r
  where r.accounting_id=new.accounting_id;

  update public.loads_accounting
     set total_revenue=round(v_parent_revenue,2),
         fsc_payment=round(v_parent_fsc,2),
         total_miles=v_parent_miles,
         total_stops=v_parent_stops
   where id=new.accounting_id;

  return new;
end;
$$;

-- Server-owned transfer. The cron already executes this every five minutes;
-- checking the Central local clock inside the function keeps 04:00 correct
-- through CST/CDT instead of hard-coding a UTC cron hour.
create or replace function public.auto_send_shifts_to_accounting()
returns void
language plpgsql
set search_path = public, pg_catalog
as $$
begin
  with eligible_shifts as (
    select s.id as shift_id, s.location, s.shift_date, s.pro_number,
           s.driver_id, s.driver_name_text,
           case when s.location = 'atlanta'
                then coalesce(
                  case when nullif(btrim(s.mc_snapshot), '') is not null
                             and btrim(s.mc_snapshot) <> '0'
                             and btrim(s.mc_snapshot) !~* '^dot([[:space:]#:]|$)'
                        then btrim(s.mc_snapshot) end,
                  nullif(btrim(d."MC"), '')
                )
                else nullif(btrim(s.mc_snapshot), '')
           end as mc_snapshot
    from public.loads_shifts s
    left join public.atlanta_drivers d on d.id = s.driver_id and s.location = 'atlanta'
    where s.shift_date >= (((now() at time zone 'America/Chicago')::date) - 2)
      and coalesce(s.sent_to_accounting::boolean, false) = false
      and (
        coalesce(s.shift_complete::boolean, false) = true
        or (
          coalesce(s.timesheet_received::boolean, false) = true
          and coalesce(s.timesheet_start_time, '') <> ''
          and coalesce(s.timesheet_end_time, '') <> ''
        )
        or (
          s.shift_date < (now() at time zone 'America/Chicago')::date
          and (now() at time zone 'America/Chicago')::time >= time '04:00'
          and (
            nullif(btrim(coalesce(s.pro_number,'')), '') is not null
            or exists (
              select 1 from public.loads_trips t2
              where t2.shift_id=s.id
                and (
                  nullif(btrim(coalesce(t2.route_id,'')), '') is not null
                  or nullif(btrim(coalesce(t2.trip_id,'')), '') is not null
                )
            )
          )
        )
      )
      and not exists (
        select 1 from public.loads_accounting a where a.source_shift_id=s.id
      )
  ),
  new_accounting as (
    insert into public.loads_accounting (
      source_shift_id, location, shift_date, aljex_load_number,
      driver_id, driver_name_text, mc_dot, cost_level, revenue_level, status
    )
    select shift_id, location, shift_date, pro_number,
           driver_id, driver_name_text, mc_snapshot, 1, 99, 'active'
    from eligible_shifts
    returning id, source_shift_id, fsc_rate_snapshot
  ),
  route_calc as (
    select
      na.id as accounting_id,
      t.trip_number,
      t.route_id,
      t.trip_id,
      t.trailer_out,
      coalesce(t.route_miles,0) as miles,
      coalesce(t.stop_count,0) as stops,
      coalesce(
        (select pt.rate from public.pricing_tiers pt
         where pt.table_name='revenue_1'
           and coalesce(t.route_miles,0) between pt.min_miles and pt.max_miles
         order by pt.sort_order
         limit 1),
        coalesce(t.route_miles,0) * coalesce(
          (select ps.value from public.pricing_settings ps where ps.key='revenue_1_per_mile'),
          0
        )
      ) as revenue,
      coalesce(t.stop_count,0) * 50 as stop_charge_revenue,
      coalesce(
        na.fsc_rate_snapshot,
        (select ps.value from public.pricing_settings ps where ps.key='fsc_rate' limit 1),
        0
      ) * 0.133 * coalesce(t.route_miles,0) as fsc_component
    from new_accounting na
    join public.loads_trips t on t.shift_id=na.source_shift_id
    where nullif(btrim(coalesce(t.route_id,'')), '') is not null
       or nullif(btrim(coalesce(t.trip_id,'')), '') is not null
  ),
  route_rows as (
    select
      accounting_id, trip_number, route_id, trip_id, trailer_out, miles, stops,
      0::numeric as linehaul_cost,
      0::numeric as stop_charge,
      0::numeric as total_cost,
      round(revenue::numeric,2) as revenue,
      round(stop_charge_revenue::numeric,2) as stop_charge_revenue,
      round((revenue + stop_charge_revenue + fsc_component)::numeric,2) as total_revenue
    from route_calc
  ),
  inserted_routes as (
    insert into public.loads_accounting_routes (
      accounting_id, route_number, route_id, trip_id, trailer, miles, stops,
      linehaul_cost, stop_charge, total_cost, revenue, stop_charge_revenue, total_revenue
    )
    select accounting_id, trip_number, route_id, trip_id, trailer_out, miles, stops,
           linehaul_cost, stop_charge, total_cost, revenue, stop_charge_revenue, total_revenue
    from route_rows
    returning accounting_id, total_revenue, miles, stops
  ),
  rollup as (
    select na.id as accounting_id,
           coalesce(sum(ir.total_revenue),0) as total_revenue,
           coalesce(sum(ir.miles),0) as total_miles,
           coalesce(sum(ir.stops),0) as total_stops
    from new_accounting na
    left join inserted_routes ir on ir.accounting_id=na.id
    group by na.id
  ),
  updated_accounting as (
    update public.loads_accounting la
       set total_carrier_pay=(select s.carrier_rate from public.loads_shifts s where s.id=la.source_shift_id),
           total_cost=(select s.carrier_rate from public.loads_shifts s where s.id=la.source_shift_id),
           total_revenue=rollup.total_revenue,
           total_miles=rollup.total_miles,
           total_stops=rollup.total_stops,
           fsc_payment=round(
             coalesce(
               la.fsc_rate_snapshot,
               (select ps.value from public.pricing_settings ps where ps.key='fsc_rate' limit 1),
               0
             ) * 0.133 * rollup.total_miles,
             2
           )
    from rollup
    where la.id=rollup.accounting_id
    returning la.source_shift_id
  )
  update public.loads_shifts s
     set sent_to_accounting=true
    from updated_accounting ua
   where s.id=ua.source_shift_id;
end;
$$;
