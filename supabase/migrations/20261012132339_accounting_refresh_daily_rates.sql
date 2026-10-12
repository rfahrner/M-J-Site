-- Refresh reconciles existing calculated carrier rates only. No new loads,
-- route sync, customer repricing, or changes to billing workflow flags.
-- Retain a date marker even when its last override is cleared, so Refresh
-- can return that day to the base without repricing unrelated historical days.
create table if not exists public.board_rate_daily_refresh_dates (
  location text not null, rate_date date not null,
  updated_at timestamptz not null default now(), primary key(location,rate_date)
);
alter table public.board_rate_daily_refresh_dates enable row level security;
create policy daily_refresh_dates_internal on public.board_rate_daily_refresh_dates
  for all to authenticated
  using(public.current_app_role() in ('dispatcher','accounting','admin','it'))
  with check(public.current_app_role() in ('dispatcher','accounting','admin','it'));
revoke all on public.board_rate_daily_refresh_dates from anon;
grant select,insert,update on public.board_rate_daily_refresh_dates to authenticated;
insert into public.board_rate_daily_refresh_dates(location,rate_date)
  select distinct location,rate_date from public.board_rate_daily_overrides on conflict do nothing;

create or replace function public.remember_daily_rate_refresh_date()
returns trigger language plpgsql security invoker set search_path = public, pg_catalog as $$
begin
  if tg_op <> 'INSERT' then
    insert into public.board_rate_daily_refresh_dates(location,rate_date) values(old.location,old.rate_date)
      on conflict(location,rate_date) do update set updated_at=now();
  end if;
  if tg_op <> 'DELETE' then
    insert into public.board_rate_daily_refresh_dates(location,rate_date) values(new.location,new.rate_date)
      on conflict(location,rate_date) do update set updated_at=now();
  end if;
  return coalesce(new,old);
end;
$$;
revoke all on function public.remember_daily_rate_refresh_date() from public,anon;
grant execute on function public.remember_daily_rate_refresh_date() to authenticated;
create trigger remember_daily_rate_refresh_date after insert or update or delete
  on public.board_rate_daily_overrides for each row execute function public.remember_daily_rate_refresh_date();

alter table public.loads_accounting
  add column if not exists carrier_pay_manual boolean not null default false;

-- Existing Accounting figures which disagree with the saved board rate may
-- be manual edits. Preserve them conservatively before enabling reconciliation.
update public.loads_accounting a set carrier_pay_manual = true
from public.loads_shifts s
where a.source_shift_id = s.id and a.location in ('atlanta','delaware','buildingc')
  and coalesce(a.status,'active') = 'active'
  and a.total_carrier_pay is not null
  and a.total_carrier_pay is distinct from s.carrier_rate
  and not a.carrier_pay_manual;

-- The existing operational board push deliberately takes ownership of pay.
-- Its UPDATE always includes pushed_at (even if no new alert is needed).
-- Cover both shift-rate and trip-edit pushes without altering their logic.
-- Mark edits server-side too: tabs still running the older frontend do not
-- know about the new flag. Alphabetical trigger order clears it again for
-- an ordinary board push, whose UPDATE also includes pushed_at.
create or replace function public.mark_accounting_manual_carrier_edit()
returns trigger language plpgsql security invoker set search_path = public, pg_catalog as $$
begin
  if new.location in ('atlanta','delaware','buildingc')
     and current_setting('app.accounting_rate_refresh',true) is distinct from 'on' then
    new.carrier_pay_manual := new.total_carrier_pay is not null;
  end if;
  return new;
end;
$$;
revoke all on function public.mark_accounting_manual_carrier_edit() from public,anon;
grant execute on function public.mark_accounting_manual_carrier_edit() to authenticated;
create trigger accounting_manual_carrier_from_edit before update of total_carrier_pay
  on public.loads_accounting for each row execute function public.mark_accounting_manual_carrier_edit();

create or replace function public.clear_accounting_manual_carrier_on_push()
returns trigger language plpgsql security invoker set search_path = public, pg_catalog as $$
begin
  new.carrier_pay_manual := false;
  return new;
end;
$$;
revoke all on function public.clear_accounting_manual_carrier_on_push() from public,anon;
grant execute on function public.clear_accounting_manual_carrier_on_push() to authenticated;
create trigger clear_accounting_manual_carrier_on_push before update of pushed_at
  on public.loads_accounting for each row execute function public.clear_accounting_manual_carrier_on_push();

-- Pure helpers use exactly the board hierarchy: load > daily > base, with
-- negotiated driver tier/setting floors (fewer free stops is more favorable).
create or replace function public.accounting_refresh_rate_setting(
  p_load jsonb, p_daily jsonb, p_base jsonb, p_driver jsonb,
  p_key text, p_fallback numeric
) returns numeric language sql immutable set search_path = public, pg_catalog as $$
  select case when p_key = 'stop_charge_free_stops'
    then least(coalesce((p_driver->'settings'->>p_key)::numeric, v), v)
    else greatest(coalesce((p_driver->'settings'->>p_key)::numeric, v), v) end
  from (select coalesce((p_load->'settings'->>p_key)::numeric,
    (p_daily->'settings'->>p_key)::numeric, (p_base->>p_key)::numeric, p_fallback) v) x;
$$;

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
  -- getEffectiveRateInfo uses a usual flat rate directly when the driver has
  -- no location rate card. Keep this existing rule rather than re-price it.
  if coalesce(normal,0) <> 0 and coalesce(drv->'tiers','{}'::jsonb) = '{}'::jsonb
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

-- An explicit Refresh must not run the ordinary full route/revenue push.
-- Ordinary board edits keep their existing automatic push behavior.
create or replace function app_private.push_accounting_after_shift_rate_change()
returns trigger language plpgsql security definer set search_path = public, pg_catalog as $$
begin
  if current_setting('app.accounting_rate_refresh',true) is distinct from 'on' then
    perform public.push_shift_to_accounting(new.id, null);
  end if;
  return new;
end;
$$;

create or replace function public.refresh_accounting_daily_rates(
  p_location text, p_from date, p_to date
) returns jsonb language plpgsql security invoker set search_path = public, pg_catalog as $$
declare
  s public.loads_shifts%rowtype; a public.loads_accounting%rowtype;
  tiers jsonb; base jsonb; daily jsonb; trips jsonb; driver jsonb;
  next_rate numeric; checked integer := 0; updated integer := 0;
  changed integer; previous_context text := current_setting('app.accounting_rate_refresh',true);
begin
  if auth.uid() is null or coalesce(public.current_app_role(),'') not in ('accounting','admin','it')
    then raise exception 'Accounting access required'; end if;
  if p_from is null or p_to is null or p_from > p_to then raise exception 'Invalid refresh dates'; end if;
  if p_location is null or p_location not in ('atlanta','delaware','buildingc') then
    return jsonb_build_object('checked',0,'updated',0);
  end if;
  perform 1 from public.board_rate_tiers t where t.location=p_location order by t.id for share;
  perform 1 from public.board_rate_settings b where b.location=p_location order by b.key for share;
  perform 1 from public.board_rate_daily_overrides d where d.location=p_location
    and d.rate_date between p_from and p_to order by d.rate_date,d.kind,d.rate_key for share;
  perform 1 from public.board_rate_daily_refresh_dates d where d.location=p_location
    and d.rate_date between p_from and p_to order by d.rate_date for share;
  select coalesce(jsonb_agg(to_jsonb(t) order by t.min_miles),'[]'::jsonb) into tiers
    from public.board_rate_tiers t where t.location=p_location;
  select coalesce(jsonb_object_agg(b.key,b.value),'{}'::jsonb) into base
    from public.board_rate_settings b where b.location=p_location;
  perform set_config('app.accounting_rate_refresh','on',true);
  -- Only days with a current or deliberately cleared daily card: no changed
  -- permanent base to months of history. Only existing active Accounting rows.
  for s in select sh.* from public.loads_shifts sh
    where sh.location=p_location and sh.shift_date between p_from and p_to
      and not coalesce(sh.rate_manual,false)
      and not coalesce(sh.load_cancelled,false) and not coalesce(sh.called_off,false)
      and exists(select 1 from public.board_rate_daily_refresh_dates d
        where d.location=sh.location and d.rate_date=sh.shift_date)
      and exists(select 1 from public.loads_accounting ac where ac.source_shift_id=sh.id
        and ac.location=p_location and coalesce(ac.status,'active')='active')
    order by sh.id for update of sh loop
    select jsonb_build_object(
      'tiers',coalesce(jsonb_object_agg(d.rate_key,d.value) filter(where d.kind='tier'),'{}'::jsonb),
      'settings',coalesce(jsonb_object_agg(d.rate_key,d.value) filter(where d.kind='setting'),'{}'::jsonb))
      into daily from public.board_rate_daily_overrides d where d.location=s.location and d.rate_date=s.shift_date;
    -- Locks protect against edits to the inputs or manual money cells racing
    -- the refresh. The whole operation commits or rolls back as one RPC.
    perform 1 from public.loads_trips t where t.shift_id=s.id order by t.id for share;
    select coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]'::jsonb) into trips
      from public.loads_trips t where t.shift_id=s.id;
    driver := null;
    select to_jsonb(d) into driver from public.atlanta_drivers d where d.id=s.driver_id for share;
    next_rate := public.accounting_refresh_carrier_total(to_jsonb(s),trips,tiers,base,daily,driver);
    if next_rate is null or next_rate < 0 then continue; end if;
    checked := checked + 1;
    -- Hold Accounting rows before changing the source rate. Manual figures
    -- remain intact even if another user's save landed just before this lock.
    for a in select ac.* from public.loads_accounting ac where ac.source_shift_id=s.id
      and ac.location=p_location and coalesce(ac.status,'active')='active' order by ac.id for update loop
      if not a.carrier_pay_manual and (a.total_carrier_pay is distinct from next_rate or a.total_cost is distinct from next_rate) then
        update public.loads_accounting set total_carrier_pay=next_rate,total_cost=next_rate,
          push_note=format('Daily rate checked on Accounting Refresh: %s replaced %s.',next_rate,coalesce(a.total_carrier_pay::text,'no rate')),
          pushed_at=now() where id=a.id;
        get diagnostics changed = row_count;
        if changed <> 1 then raise exception 'Accounting rate update not permitted'; end if;
        updated := updated + 1;
      end if;
    end loop;
    if s.carrier_rate is distinct from next_rate then
      update public.loads_shifts set carrier_rate=next_rate where id=s.id;
      get diagnostics changed = row_count;
      if changed <> 1 then raise exception 'Board rate update not permitted'; end if;
    end if;
  end loop;
  perform set_config('app.accounting_rate_refresh',coalesce(previous_context,''),true);
  return jsonb_build_object('checked',checked,'updated',updated);
end;
$$;

revoke all on function public.accounting_refresh_rate_setting(jsonb,jsonb,jsonb,jsonb,text,numeric) from public,anon;
revoke all on function public.accounting_refresh_carrier_total(jsonb,jsonb,jsonb,jsonb,jsonb,jsonb) from public,anon;
revoke all on function public.refresh_accounting_daily_rates(text,date,date) from public,anon;
grant execute on function public.accounting_refresh_rate_setting(jsonb,jsonb,jsonb,jsonb,text,numeric) to authenticated;
grant execute on function public.accounting_refresh_carrier_total(jsonb,jsonb,jsonb,jsonb,jsonb,jsonb) to authenticated;
grant execute on function public.refresh_accounting_daily_rates(text,date,date) to authenticated;
