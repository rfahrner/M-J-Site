alter table public.loads_accounting_routes
  add column if not exists source_trip_id bigint,
  add column if not exists route_image_path text;

create or replace function public.capture_accounting_route_source_media()
returns trigger
language plpgsql
set search_path to 'public', 'pg_catalog'
as $$
declare
  v_shift_id bigint;
  v_trip_id bigint;
  v_route_image_path text;
begin
  if new.accounting_id is null or new.route_number is null then
    return new;
  end if;

  select a.source_shift_id
    into v_shift_id
    from public.loads_accounting a
   where a.id = new.accounting_id;

  if v_shift_id is null then
    return new;
  end if;

  select t.id, t.route_image_path
    into v_trip_id, v_route_image_path
    from public.loads_trips t
   where t.shift_id = v_shift_id
     and t.trip_number = new.route_number
   limit 1;

  if v_trip_id is not null then
    new.source_trip_id := coalesce(new.source_trip_id, v_trip_id);
    if new.route_image_path is null or btrim(new.route_image_path) = '' then
      new.route_image_path := v_route_image_path;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_capture_accounting_route_source_media on public.loads_accounting_routes;
create trigger trg_capture_accounting_route_source_media
before insert or update of accounting_id, route_number
on public.loads_accounting_routes
for each row
execute function public.capture_accounting_route_source_media();

create or replace function public.sync_trip_media_to_accounting()
returns trigger
language plpgsql
set search_path to 'public', 'pg_catalog'
as $$
begin
  update public.loads_accounting_routes ar
     set source_trip_id = new.id,
         route_image_path = new.route_image_path
    from public.loads_accounting a
   where ar.accounting_id = a.id
     and a.source_shift_id = new.shift_id
     and ar.route_number = new.trip_number;
  return new;
end;
$$;

drop trigger if exists trg_sync_trip_media_to_accounting on public.loads_trips;
create trigger trg_sync_trip_media_to_accounting
after insert or update of route_image_path
on public.loads_trips
for each row
execute function public.sync_trip_media_to_accounting();

update public.loads_accounting_routes ar
   set source_trip_id = t.id,
       route_image_path = t.route_image_path
  from public.loads_accounting a,
       public.loads_trips t
 where ar.accounting_id = a.id
   and a.source_shift_id = t.shift_id
   and ar.route_number = t.trip_number
   and (ar.source_trip_id is null
        or ar.route_image_path is distinct from t.route_image_path);
