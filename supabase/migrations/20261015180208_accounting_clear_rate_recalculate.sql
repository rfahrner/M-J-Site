-- Explicitly clearing one Accounting money cell restores that cell's formula.
-- Never save an intermediate NULL, re-push the load, or touch unrelated money.
create or replace function public.reset_accounting_rate(p_accounting_id bigint, p_column text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  a public.loads_accounting%rowtype;
  s jsonb; trips jsonb; tiers jsonb; base jsonb; daily jsonb; driver jsonb;
  r record; amount numeric; linehaul numeric; per_mile numeric; stop_rate numeric;
  fsc_rate numeric; fsc_multiplier numeric; fsc_total numeric := 0;
  level integer; divisor numeric; affected integer; expected_routes integer; processed_routes integer := 0;
  previous_context text := current_setting('app.accounting_rate_refresh',true);
begin
  if auth.uid() is null or coalesce(public.current_app_role(),'') not in ('accounting','admin','it')
    then raise exception 'Accounting access required'; end if;
  if p_column is null or p_column not in ('total_carrier_pay','total_revenue')
    then raise exception 'Choose a customer or carrier rate'; end if;
  select * into a from public.loads_accounting where id=p_accounting_id for update;
  if not found then raise exception 'Accounting record not accessible'; end if;
  if a.status='deleted' then raise exception 'Restore this deleted Accounting record before recalculating'; end if;

  if a.status='cancelled' then
    amount := 0;
  elsif p_column='total_carrier_pay' then
    if a.source_shift_id is not null then
      select to_jsonb(sh) into s from public.loads_shifts sh where sh.id=a.source_shift_id;
      if s is null then raise exception 'The source load is unavailable; the saved rate was kept'; end if;
      if coalesce((s->>'called_off')::boolean,false) or coalesce((s->>'load_cancelled')::boolean,false) then
        amount := 0;
      elsif coalesce((s->>'rate_manual')::boolean,false) then
        amount := (s->>'carrier_rate')::numeric;
      else
        select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) into trips
          from public.loads_trips t where t.shift_id=a.source_shift_id;
        select coalesce(jsonb_agg(to_jsonb(t) order by t.min_miles),'[]'::jsonb) into tiers
          from public.board_rate_tiers t where t.location=s->>'location';
        select coalesce(jsonb_object_agg(b.key,b.value),'{}'::jsonb) into base
          from public.board_rate_settings b where b.location=s->>'location';
        select jsonb_build_object(
          'tiers',coalesce(jsonb_object_agg(d.rate_key,d.value) filter(where d.kind='tier'),'{}'::jsonb),
          'settings',coalesce(jsonb_object_agg(d.rate_key,d.value) filter(where d.kind='setting'),'{}'::jsonb))
          into daily from public.board_rate_daily_overrides d
          where d.location=s->>'location' and d.rate_date=(s->>'shift_date')::date;
        select to_jsonb(d) into driver from public.atlanta_drivers d where d.id=(s->>'driver_id')::bigint;
        amount := public.accounting_refresh_carrier_total(s,trips,tiers,base,daily,driver);
      end if;
    elsif a.source_houston_id is not null then
      select h.normal_rate into amount from public.loads_houston h where h.id=a.source_houston_id;
    elsif a.source_mondelez_id is not null then
      select case when m.called_off or m.load_cancelled then 0 else m.carrier_pay end
        into amount from public.mondelez_loads m where m.id=a.source_mondelez_id;
    end if;
  elsif a.location='mondelez' then
    select case when m.called_off or m.load_cancelled then 0 else m.revenue_total end
      into amount from public.mondelez_loads m where m.id=a.source_mondelez_id;
  elsif a.location='houston' then
    select value into amount from public.pricing_settings where key='houston_customer_rate';
  elsif a.location in ('atlanta','delaware','buildingc') then
    -- These are the same customer inputs used by the Revenue Rate selector
    -- and standard-board transfer. Preserve the load's saved FSC snapshot.
    level := case when a.location='atlanta' then coalesce(nullif(a.revenue_level,99),1) else 1 end;
    if level=4 then
      select value into divisor from public.pricing_settings where key='market_revenue_divisor';
      if divisor is null or divisor=0 or a.total_carrier_pay is null then
        raise exception 'Carrier pay and a Market divisor are required to calculate the customer rate';
      end if;
      amount := round(a.total_carrier_pay/divisor,2);
    elsif level in (1,2) then
      select value into per_mile from public.pricing_settings where key='revenue_'||level||'_per_mile';
      select value into stop_rate from public.pricing_settings where key='stop_charge_revenue_per_stop';
      select value into fsc_multiplier from public.pricing_settings where key='fsc_multiplier';
      select coalesce(a.fsc_rate_snapshot,(select value from public.pricing_settings where key='fsc_rate')) into fsc_rate;
      if per_mile is null or stop_rate is null or fsc_multiplier is null or fsc_rate is null then
        raise exception 'Pricing settings unavailable; the saved rate was kept';
      end if;
      select count(*) into expected_routes from public.loads_accounting_routes where accounting_id=a.id;
      if expected_routes=0 then
        raise exception 'No routes available to calculate this load; the saved rate was kept';
      end if;
      amount := 0;
      for r in select * from public.loads_accounting_routes where accounting_id=a.id for update loop
        processed_routes := processed_routes+1;
        select rate into linehaul from public.pricing_tiers
          where table_name='revenue_'||level and coalesce(r.miles,0) between min_miles and max_miles
          order by sort_order limit 1;
        linehaul := round(coalesce(linehaul,coalesce(r.miles,0)*per_mile),2);
        -- A reset updates this load's customer breakdown only. Route cost and
        -- identity are left intact. Any failure rolls the entire reset back.
        update public.loads_accounting_routes set revenue=linehaul,
          stop_charge_revenue=round(coalesce(r.stops,0)*stop_rate,2),
          total_revenue=round(linehaul+coalesce(r.stops,0)*stop_rate+fsc_rate*fsc_multiplier*coalesce(r.miles,0),2)
          where id=r.id;
        get diagnostics affected = row_count;
        if affected<>1 then raise exception 'Route update not permitted'; end if;
        amount := amount+round(linehaul+coalesce(r.stops,0)*stop_rate+fsc_rate*fsc_multiplier*coalesce(r.miles,0),2);
        fsc_total := fsc_total+fsc_rate*fsc_multiplier*coalesce(r.miles,0);
      end loop;
      if processed_routes<>expected_routes then raise exception 'Route update not permitted'; end if;
    end if;
  end if;
  if amount is null then raise exception 'No calculated rate is available; the saved rate was kept'; end if;

  -- Reuse the rate-only context so the existing manual-edit trigger does not
  -- mark this calculated carrier amount as a typed override.
  perform set_config('app.accounting_rate_refresh','on',true);
  if p_column='total_carrier_pay' then
    update public.loads_accounting set total_carrier_pay=round(amount,2),total_cost=round(amount,2),carrier_pay_manual=false
      where id=a.id returning * into a;
  else
    update public.loads_accounting set total_revenue=round(amount,2),revenue_manual=false,
      fsc_payment=case when level in (1,2) then round(fsc_total,2) else fsc_payment end
      where id=a.id returning * into a;
  end if;
  if not found then raise exception 'Accounting update not permitted'; end if;
  perform set_config('app.accounting_rate_refresh',coalesce(previous_context,''),true);
  return to_jsonb(a);
end;
$$;
revoke all on function public.reset_accounting_rate(bigint,text) from public,anon;
grant execute on function public.reset_accounting_rate(bigint,text) to authenticated;
