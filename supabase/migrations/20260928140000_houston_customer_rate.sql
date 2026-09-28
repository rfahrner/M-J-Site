-- Houston bills the customer a flat rate per load, and nothing was carrying it.
--
-- auto_send_houston_to_accounting() hard-coded total_revenue to 0, so all 161
-- Houston accounting records since 2026-06-19 read $0.00 in the Customer Rate
-- column and contributed nothing to any revenue figure. None had been sent or
-- released, so nothing already invoiced is affected by fixing it.
--
-- The rate lives in pricing_settings rather than in the function or the page,
-- for the same reason every other figure on that page does: it will change, and
-- when it does it should change in one place. The accountant can still type
-- over an individual load -- this is the starting figure, not a lock.

insert into public.pricing_settings (key, value)
values ('houston_customer_rate', 995)
on conflict (key) do update set value = excluded.value;

create or replace function public.auto_send_houston_to_accounting()
returns void
language plpgsql
set search_path = public, pg_catalog
as $$
declare
  v_customer_rate numeric;
begin
  if (now() at time zone 'America/Chicago')::time < time '04:00' then
    return;
  end if;

  -- Read once per sweep. Falling back to 0 keeps the old behaviour if the
  -- setting is ever deleted: a blank figure an accountant will notice, rather
  -- than a made-up one they will not.
  select coalesce((select ps.value from public.pricing_settings ps
                    where ps.key = 'houston_customer_rate'), 0)
    into v_customer_rate;

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
           h.normal_rate, h.normal_rate, v_customer_rate,
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

-- Backfill the records that were created with 0.
--
-- Guarded on all three conditions rather than trusting the count: a record that
-- has been sent, released, or that somebody has already typed a figure into is
-- left exactly as it is. As of this migration that excludes none of them, but
-- the guard is what makes the statement safe to re-run.
update public.loads_accounting a
   set total_revenue = (select ps.value from public.pricing_settings ps
                         where ps.key = 'houston_customer_rate')
 where a.location = 'houston'
   and coalesce(a.total_revenue, 0) = 0
   and coalesce(a.sent, false) = false
   and coalesce(a.status, '') <> 'released';
