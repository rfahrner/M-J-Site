-- Driver call-offs and explicit load cancellations are both terminal load
-- states. Keep their Accounting record zero-dollar and visibly cancelled.

alter table public.loads_accounting
  drop constraint if exists loads_accounting_status_check;
alter table public.loads_accounting
  add constraint loads_accounting_status_check
  check (status = any (array['active'::text, 'released'::text, 'cancelled'::text]));

create or replace function app_private.record_cancelled_load_to_accounting()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_id bigint;
  v_reason text;
begin
  if coalesce(new.load_cancelled, false) = false
     and coalesce(new.called_off, false) = false then
    delete from loads_accounting
     where source_shift_id = new.id and status = 'cancelled';
    return new;
  end if;

  v_reason := coalesce(nullif(new.load_cancelled_reason, ''), nullif(new.called_off_reason, ''));

  select id into v_id
    from loads_accounting
   where source_shift_id = new.id
   limit 1;

  if v_id is null then
    insert into loads_accounting (
      source_shift_id, location, shift_date, aljex_load_number,
      driver_id, driver_name_text, driver_cell, carrier_email, mc_dot,
      cost_level, revenue_level, total_carrier_pay, fsc_payment,
      total_cost, total_revenue, total_miles, total_stops,
      status, cancelled_reason
    ) values (
      new.id, new.location, new.shift_date, new.pro_number,
      new.driver_id, new.driver_name_text, new.driver_cell_snapshot,
      new.email_snapshot, new.mc_snapshot,
      1, 1, 0, 0, 0, 0, 0, 0,
      'cancelled', v_reason
    );
  else
    update loads_accounting
       set status = 'cancelled',
           cancelled_reason = v_reason,
           total_carrier_pay = 0,
           fsc_payment = 0,
           total_cost = 0,
           total_revenue = 0,
           total_miles = 0,
           total_stops = 0
     where id = v_id;
    delete from loads_accounting_routes where accounting_id = v_id;
  end if;

  update loads_shifts
     set sent_to_accounting = true
   where id = new.id
     and coalesce(sent_to_accounting, false) = false;

  return new;
end;
$$;

drop trigger if exists loads_shifts_cancelled_to_accounting on public.loads_shifts;
create trigger loads_shifts_cancelled_to_accounting
after update of load_cancelled, called_off on public.loads_shifts
for each row
when (old.load_cancelled is distinct from new.load_cancelled
   or old.called_off is distinct from new.called_off)
execute function app_private.record_cancelled_load_to_accounting();

-- Backfill call-offs already recorded before this trigger existed.
insert into public.loads_accounting (
  source_shift_id, location, shift_date, aljex_load_number,
  driver_id, driver_name_text, driver_cell, carrier_email, mc_dot,
  cost_level, revenue_level, total_carrier_pay, fsc_payment,
  total_cost, total_revenue, total_miles, total_stops,
  status, cancelled_reason
)
select s.id, s.location, s.shift_date, s.pro_number,
       s.driver_id, s.driver_name_text, s.driver_cell_snapshot,
       s.email_snapshot, s.mc_snapshot,
       1, 1, 0, 0, 0, 0, 0, 0,
       'cancelled', coalesce(nullif(s.load_cancelled_reason, ''), nullif(s.called_off_reason, ''))
  from public.loads_shifts s
 where s.called_off = true
   and not exists (
     select 1 from public.loads_accounting a
      where a.source_shift_id = s.id
   );

update public.loads_shifts s
   set sent_to_accounting = true
 where s.called_off = true
   and coalesce(s.sent_to_accounting, false) = false
   and exists (
     select 1 from public.loads_accounting a
      where a.source_shift_id = s.id and a.status = 'cancelled'
   );
