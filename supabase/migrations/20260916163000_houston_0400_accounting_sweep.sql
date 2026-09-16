-- Houston uses its own load table, so give it the same 04:00 Central
-- Accounting cutoff as the standard load boards.
create or replace function public.auto_send_houston_to_accounting()
returns void
language plpgsql
set search_path = public, pg_catalog
as $$
begin
  if (now() at time zone 'America/Chicago')::time < time '04:00' then
    return;
  end if;

  with eligible as (
    select h.*
    from public.loads_houston h
    where h.shift_date >= (((now() at time zone 'America/Chicago')::date) - 2)
      and h.shift_date < (now() at time zone 'America/Chicago')::date
      and coalesce(h.sent_to_accounting,false)=false
      and (
        nullif(btrim(coalesce(h.aljex_number,'')),'') is not null
        or nullif(btrim(coalesce(h.driver_name,'')),'') is not null
      )
      and not exists (
        select 1 from public.loads_accounting a where a.source_houston_id=h.id
      )
  ),
  inserted as (
    insert into public.loads_accounting (
      source_houston_id, location, shift_date, aljex_load_number,
      driver_id, driver_name_text, mc_dot,
      cost_level, revenue_level,
      total_carrier_pay, total_cost, total_revenue,
      status
    )
    select h.id, 'houston', h.shift_date, h.aljex_number,
           h.driver_id, h.driver_name, h.mc,
           1, 99,
           h.normal_rate, h.normal_rate, 0,
           'active'
    from eligible h
    returning source_houston_id
  )
  update public.loads_houston h
     set sent_to_accounting=true
    from inserted i
   where h.id=i.source_houston_id;

  update public.loads_houston h
     set sent_to_accounting=true
   where coalesce(h.sent_to_accounting,false)=false
     and exists (
       select 1 from public.loads_accounting a where a.source_houston_id=h.id
     );
end;
$$;

-- pg_cron runs in GMT on this project, so keep the five-minute cadence and
-- let the function itself decide when Central 04:00 has arrived (DST-safe).
do $$
begin
  if exists (select 1 from cron.job where jobname='houston_accounting_0400_sweep') then
    perform cron.unschedule('houston_accounting_0400_sweep');
  end if;
  perform cron.schedule(
    'houston_accounting_0400_sweep',
    '*/5 * * * *',
    'select public.auto_send_houston_to_accounting();'
  );
end;
$$;
