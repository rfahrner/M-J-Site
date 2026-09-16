-- The load board is the single source of truth for carrier pay on every
-- Accounting row. This catches later Accounting updates (including the legacy
-- server rollup) so none of them can replace the board-applied dollar rate.

create or replace function app_private.enforce_board_carrier_rate_v2()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_rate numeric;
begin
  if coalesce(new.status,'active')='cancelled' then return new; end if;

  if new.source_shift_id is not null then
    select s.carrier_rate into v_rate
    from public.loads_shifts s
    where s.id=new.source_shift_id;
    new.total_carrier_pay := v_rate;
    new.total_cost := v_rate;
  elsif new.source_houston_id is not null then
    select h.normal_rate into v_rate
    from public.loads_houston h
    where h.id=new.source_houston_id;
    new.total_carrier_pay := v_rate;
    new.total_cost := v_rate;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_enforce_board_carrier_rate_v2 on public.loads_accounting;
create trigger trg_enforce_board_carrier_rate_v2
before update of total_cost, total_carrier_pay on public.loads_accounting
for each row execute function app_private.enforce_board_carrier_rate_v2();

-- Bring currently-active rows in line immediately.
update public.loads_accounting a
set total_carrier_pay=s.carrier_rate,
    total_cost=s.carrier_rate
from public.loads_shifts s
where a.source_shift_id=s.id
  and coalesce(a.status,'active')='active';

update public.loads_accounting a
set total_carrier_pay=h.normal_rate,
    total_cost=h.normal_rate
from public.loads_houston h
where a.source_houston_id=h.id
  and coalesce(a.status,'active')='active';
