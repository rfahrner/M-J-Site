-- Carrier Rate is the cost-side dollar value now that Cost Level is gone.
-- Keep the internal total_cost field aligned when Accounting manually edits
-- total_carrier_pay, without blocking or replacing the user's value.
create or replace function app_private.sync_accounting_total_cost_from_carrier_edit()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
begin
  if new.total_carrier_pay is distinct from old.total_carrier_pay then
    new.total_cost := new.total_carrier_pay;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_sync_accounting_total_cost_from_carrier_edit on public.loads_accounting;
create trigger trg_sync_accounting_total_cost_from_carrier_edit
before update of total_carrier_pay on public.loads_accounting
for each row execute function app_private.sync_accounting_total_cost_from_carrier_edit();
