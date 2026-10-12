-- Match the board/modal route-sum fix in Accounting Refresh.
-- No stored rates are changed by installing this function.
create or replace function public.accounting_refresh_carrier_total(
  p_shift jsonb, p_trips jsonb, p_tiers jsonb, p_base jsonb,
  p_daily jsonb, p_driver jsonb
) returns numeric language plpgsql immutable set search_path = public, pg_catalog as $$
declare
  loc text := p_shift->>'location';
  ov jsonb := coalesce(p_shift->'rate_overrides','{}'::jsonb);
  drv jsonb := case loc when 'atlanta' then p_driver->'atlanta_rate_overrides'
    when 'delaware' then p_driver->'delaware_rate_overrides' else null end;
  normal numeric := (p_driver->>'normal_rate')::numeric;
  total numeric := 0; miles numeric; rate numeric; stops integer;
  free_stops numeric; per_stop numeric; hours numeric;
  trip jsonb; tier jsonb; driver_rate numeric;
begin
  if coalesce((p_shift->>'load_cancelled')::boolean,false)
     or coalesce((p_shift->>'called_off')::boolean,false) then return null; end if;
  if p_shift->>'driver_id' is not null and p_driver is null then return null; end if;
  -- Mileage boards sum real routes first, then apply the usual rate as a
  -- minimum. Preserve the direct flat-rate rule for other board types.
  if loc not in ('atlanta','delaware') and coalesce(normal,0) <> 0 and coalesce(drv->'tiers','{}'::jsonb) = '{}'::jsonb
      and coalesce(drv->'settings','{}'::jsonb) = '{}'::jsonb then return normal; end if;
  if loc in ('atlanta','delaware') and jsonb_array_length(coalesce(p_tiers,'[]')) = 0
    then return null; end if;
  if loc = 'atlanta' and coalesce((p_shift->>'tonu')::boolean,false) then
    total := public.accounting_refresh_rate_setting(ov,p_daily,p_base,drv,'tonu_flat',150);
  elsif loc in ('atlanta','delaware') then
    for trip in select value from jsonb_array_elements(coalesce(p_trips,'[]')) loop
      if btrim(coalesce(trip->>'route_id','')) = '' and btrim(coalesce(trip->>'trip_id','')) = '' then continue; end if;
      miles := coalesce((trip->>'route_miles')::numeric,0);
      if miles <= 0 then continue; end if;
      select value into tier from jsonb_array_elements(p_tiers)
        where floor(miles) between (value->>'min_miles')::numeric and (value->>'max_miles')::numeric
        order by (value->>'min_miles')::numeric limit 1;
      if tier is not null then
        rate := coalesce((ov->'tiers'->>(tier->>'id'))::numeric,
          (p_daily->'tiers'->>(tier->>'id'))::numeric, (tier->>'rate')::numeric);
        driver_rate := (drv->'tiers'->>(tier->>'id'))::numeric;
        rate := greatest(rate,coalesce(driver_rate,rate));
      else
        rate := miles * public.accounting_refresh_rate_setting(ov,p_daily,p_base,drv,
          'over_tier_per_mile',case loc when 'delaware' then 4 else 2.4 end);
      end if;
      if loc = 'atlanta' then
        stops := coalesce((trip->>'stop_count')::integer,0);
        free_stops := public.accounting_refresh_rate_setting(ov,p_daily,p_base,drv,'stop_charge_free_stops',2);
        per_stop := public.accounting_refresh_rate_setting(ov,p_daily,p_base,drv,'stop_charge_per_stop',20);
        rate := rate + greatest(stops-free_stops,0) * per_stop;
      end if;
      total := total + rate;
    end loop;
  elsif loc = 'buildingc' then
    if coalesce(p_shift->>'route_type','birm') = 'birm' then
      total := public.accounting_refresh_rate_setting(ov,p_daily,p_base,null,'birm_flat',800);
    elsif p_shift->>'route_type' = 'hostler' then
      hours := coalesce((p_shift->>'hostler_hours')::numeric,0);
      total := greatest(hours,0) * public.accounting_refresh_rate_setting(ov,p_daily,p_base,null,'hostler_hourly',100);
    end if;
  else return null;
  end if;
  return greatest(round(total,2),coalesce(normal,0));
end;
$$;
