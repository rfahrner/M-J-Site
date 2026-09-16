-- Standard-board Accounting rows are now a daily batch rather than an
-- immediate completion event. The existing trigger calls are harmless: this
-- function returns no eligible current-day rows until the next day's 04:00
-- Central cutoff. Cancelled-load handling remains separate.
create or replace function public.auto_send_shifts_to_accounting()
returns void
language plpgsql
set search_path = public, pg_catalog
as $$
begin
  if (now() at time zone 'America/Chicago')::time < time '04:00' then
    return;
  end if;

  with eligible_shifts as (
    select s.id as shift_id, s.location, s.shift_date, s.pro_number,
           s.driver_id, s.driver_name_text,
           case when s.location='atlanta'
                then coalesce(
                  case when nullif(btrim(s.mc_snapshot),'') is not null
                             and btrim(s.mc_snapshot) <> '0'
                             and btrim(s.mc_snapshot) !~* '^dot([[:space:]#:]|$)'
                        then btrim(s.mc_snapshot) end,
                  nullif(btrim(d."MC"),'')
                )
                else nullif(btrim(s.mc_snapshot),'')
           end as mc_snapshot
    from public.loads_shifts s
    left join public.atlanta_drivers d on d.id=s.driver_id and s.location='atlanta'
    where s.shift_date >= (((now() at time zone 'America/Chicago')::date) - 2)
      and s.shift_date < (now() at time zone 'America/Chicago')::date
      and coalesce(s.sent_to_accounting,false)=false
      and (
        nullif(btrim(coalesce(s.pro_number,'')),'') is not null
        or exists (
          select 1 from public.loads_trips t2
          where t2.shift_id=s.id
            and (
              nullif(btrim(coalesce(t2.route_id,'')),'') is not null
              or nullif(btrim(coalesce(t2.trip_id,'')),'') is not null
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
          (select ps.value from public.pricing_settings ps where ps.key='revenue_1_per_mile'),0
        )
      ) as revenue,
      coalesce(t.stop_count,0) * 50 as stop_charge_revenue,
      coalesce(
        na.fsc_rate_snapshot,
        (select ps.value from public.pricing_settings ps where ps.key='fsc_rate' limit 1),0
      ) * 0.133 * coalesce(t.route_miles,0) as fsc_component
    from new_accounting na
    join public.loads_trips t on t.shift_id=na.source_shift_id
    where nullif(btrim(coalesce(t.route_id,'')),'') is not null
       or nullif(btrim(coalesce(t.trip_id,'')),'') is not null
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
               (select ps.value from public.pricing_settings ps where ps.key='fsc_rate' limit 1),0
             ) * 0.133 * rollup.total_miles,2
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
