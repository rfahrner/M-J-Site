create or replace function public.accounting_use_profile_driver_name()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
declare
  v_name text;
begin
  if new.driver_id is not null then
    select nullif(btrim(d."Driver Name"), '') into v_name
    from public.atlanta_drivers d
    where d.id = new.driver_id;
    if v_name is not null then
      new.driver_name_text := v_name;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_accounting_use_profile_driver_name on public.loads_accounting;
create trigger trg_accounting_use_profile_driver_name
before insert or update of driver_id, driver_name_text on public.loads_accounting
for each row execute function public.accounting_use_profile_driver_name();

create or replace function public.sync_driver_profile_name_to_accounting()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
begin
  if new."Driver Name" is distinct from old."Driver Name" then
    update public.loads_accounting
       set driver_name_text = new."Driver Name"
     where driver_id = new.id
       and driver_name_text is distinct from new."Driver Name";
  end if;
  return new;
end;
$$;

drop trigger if exists trg_driver_profile_name_to_accounting on public.atlanta_drivers;
create trigger trg_driver_profile_name_to_accounting
after update of "Driver Name" on public.atlanta_drivers
for each row execute function public.sync_driver_profile_name_to_accounting();

update public.loads_accounting a
set driver_name_text = d."Driver Name"
from public.atlanta_drivers d
where d.id = a.driver_id
  and nullif(btrim(coalesce(d."Driver Name",'')), '') is not null
  and a.driver_name_text is distinct from d."Driver Name";
