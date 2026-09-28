-- Mondelez has never reached Accounting.
--
-- Atlanta, Building C and Delaware arrive through auto_send_shifts_to_accounting()
-- and Houston through auto_send_houston_to_accounting(), but mondelez_loads had
-- no route in at all: loads_accounting carried source_shift_id and
-- source_houston_id and nothing else. So 1,381 loads back to 2024-10-09 --
-- $687k of revenue -- existed only on their own board, absent from the
-- Accounting page, from the by-driver totals and from Location Analytics.
--
-- This adds the link column, the sweep that mirrors Houston's, and a one-time
-- backfill of everything already on the board.

alter table public.loads_accounting
  add column if not exists source_mondelez_id bigint;

-- Partial, because every non-Mondelez record leaves this null and they must not
-- collide with each other. This is also what makes both the sweep and the
-- backfill safe to re-run: a second pass finds the row already linked.
create unique index if not exists loads_accounting_source_mondelez_id_key
  on public.loads_accounting (source_mondelez_id)
  where source_mondelez_id is not null;

create index if not exists loads_accounting_location_shift_date_idx
  on public.loads_accounting (location, shift_date);

-- The sweep. Same shape and the same 04:00 Central cutoff as the other two, so
-- a load settles on the board for a day before Accounting takes a copy.
--
-- Every figure is copied from the board rather than recomputed here. The
-- Mondelez rate is daily rate + stops + over-mileage + FSC, and that sum
-- already lives in mondelez_loads.revenue_total; a second implementation in SQL
-- would be a second answer, and the two would drift.
create or replace function public.auto_send_mondelez_to_accounting()
returns void
language plpgsql
set search_path = public, pg_catalog
as $$
begin
  if (now() at time zone 'America/Chicago')::time < time '04:00' then
    return;
  end if;

  insert into public.loads_accounting (
    source_mondelez_id, location, shift_date, aljex_load_number,
    driver_id, driver_name_text, mc_dot,
    cost_level, revenue_level,
    total_carrier_pay, total_cost, total_revenue,
    total_miles, total_stops, fsc_payment,
    status
  )
  select m.id, 'mondelez', m.shift_date, m.aljex_number,
         m.driver_id, m.driver_name,
         -- mondelez_loads has no MC of its own; the driver profile does.
         nullif(btrim(coalesce(d."MC", '')), ''),
         -- Level 1, not the 99 the Houston sweep stamps. Mondelez does not
         -- price by level -- the figure comes off the board -- and 99 matches
         -- no pricing table, so anything that ever did look it up would bill
         -- zero. 1 is inert here and harmless if it is ever read.
         1, 1,
         m.carrier_pay, m.carrier_pay, m.revenue_total,
         m.miles, m.stop_count, m.fsc,
         'active'
  from public.mondelez_loads m
  left join public.atlanta_drivers d on d.id = m.driver_id
  where m.shift_date >= (((now() at time zone 'America/Chicago')::date) - 2)
    and m.shift_date < (now() at time zone 'America/Chicago')::date
    and (
      nullif(btrim(coalesce(m.aljex_number,'')),'') is not null
      or nullif(btrim(coalesce(m.driver_name,'')),'') is not null
    )
    and not exists (
      select 1 from public.loads_accounting a where a.source_mondelez_id = m.id
    );
end;
$$;

-- Same five-minute cadence as the others; the function decides when Central
-- 04:00 has arrived, which keeps it right across DST.
do $$
begin
  if not exists (select 1 from cron.job where command like '%auto_send_mondelez_to_accounting%') then
    perform cron.schedule('mondelez-to-accounting', '*/5 * * * *',
                          'select public.auto_send_mondelez_to_accounting();');
  end if;
end;
$$;

-- One-time backfill of everything already on the board, with no date window.
--
-- Figures are carried across exactly as they stand, including the 121 loads
-- whose carrier_pay is negative. Those are wrong -- all 121 were last touched
-- on 2026-09-02, all fall between 2025-05-24 and 2025-07-24, and 67 of them
-- hold exactly -5600 against revenue of a few hundred dollars, which is a
-- constant written into the wrong column by a historical import rather than
-- anything computed. They are brought in as they are so they can be seen and
-- corrected on the page, rather than quietly dropped or invented.
insert into public.loads_accounting (
  source_mondelez_id, location, shift_date, aljex_load_number,
  driver_id, driver_name_text, mc_dot,
  cost_level, revenue_level,
  total_carrier_pay, total_cost, total_revenue,
  total_miles, total_stops, fsc_payment,
  status
)
select m.id, 'mondelez', m.shift_date, m.aljex_number,
       m.driver_id, m.driver_name,
       nullif(btrim(coalesce(d."MC", '')), ''),
       1, 1,
       m.carrier_pay, m.carrier_pay, m.revenue_total,
       m.miles, m.stop_count, m.fsc,
       'active'
from public.mondelez_loads m
left join public.atlanta_drivers d on d.id = m.driver_id
where (
    nullif(btrim(coalesce(m.aljex_number,'')),'') is not null
    or nullif(btrim(coalesce(m.driver_name,'')),'') is not null
  )
  and not exists (
    select 1 from public.loads_accounting a where a.source_mondelez_id = m.id
  );
