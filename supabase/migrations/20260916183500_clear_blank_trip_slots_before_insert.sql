-- Blank/minimized route placeholders must not occupy a real (shift_id, trip_number)
-- slot. The browser creates a fresh editable route when a load has no usable open
-- route. Older blank placeholder rows can otherwise make that fresh route collide
-- with loads_trips_shift_id_trip_number_key.

create or replace function app_private.is_blank_trip_placeholder(p public.loads_trips)
returns boolean
language sql
stable
set search_path = public, pg_catalog
as $$
  select
    nullif(btrim(coalesce(p.route_id,'')), '') is null
    and nullif(btrim(coalesce(p.trip_id,'')), '') is null
    and nullif(btrim(coalesce(p.trailer_out,'')), '') is null
    and p.route_miles is null
    and p.stop_count is null
    and p.dispatch_time is null
    and coalesce(p.salvage,false) = false
    and coalesce(p.backhaul,false) = false
    and p.call_time is null
    and p.last_stop_depart is null
    and p.return_to_dc is null
    and nullif(btrim(coalesce(p.backhaul_location,'')), '') is null
    and nullif(btrim(coalesce(p.salvage_bhaul_refused_by,'')), '') is null
    and nullif(btrim(coalesce(p.backhaul_trailer_number,'')), '') is null
    and p.return_eta_to_dc is null
    and nullif(btrim(coalesce(p.return_drop_location,'')), '') is null
    and lower(btrim(coalesce(p.ppwk_received::text,'false'))) in ('', 'false', '0')
    and p.time_sheet_start is null
    and p.time_sheet_end is null
    and nullif(btrim(coalesce(p.drop_location_text,'')), '') is null
    and nullif(btrim(coalesce(p.return_to_dc_text,'')), '') is null
    and nullif(btrim(coalesce(p.backhaul_type,'')), '') is null
    and p.check_in_45min is null
    and p.text_not_answered_remind is null
    and p.pre_shift_call is null
    and p.route_est_hours is null
    and p.time_to_final_stop is null
    and p.eta_to_final_stop is null
    and p.est_route_complete is null
    and p.driver_id is null
    and coalesce(p.complete,false) = false
    and nullif(btrim(coalesce(p.notes,'')), '') is null
    and nullif(btrim(coalesce(p.current_route_status,'')), '') is null
    and nullif(btrim(coalesce(p.current_backhaul_status,'')), '') is null
    and p.next_call_time is null
    and p.timesheet_start_time is null
    and p.timesheet_end_time is null
    and nullif(btrim(coalesce(p.route_image_path,'')), '') is null
    and coalesce(p.checked_in,false) = false
    and p.completed_at is null
    and p.time_to_dc is null
    and not exists (
      select 1 from public.trip_stops s where s.trip_id = p.id
    );
$$;

create or replace function app_private.clear_blank_trip_slot_before_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_existing public.loads_trips%rowtype;
begin
  select * into v_existing
  from public.loads_trips t
  where t.shift_id = new.shift_id
    and t.trip_number = new.trip_number
  limit 1;

  if found and app_private.is_blank_trip_placeholder(v_existing) then
    delete from public.loads_trips where id = v_existing.id;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_clear_blank_trip_slot_before_insert on public.loads_trips;
create trigger trg_clear_blank_trip_slot_before_insert
before insert on public.loads_trips
for each row
execute function app_private.clear_blank_trip_slot_before_insert();

-- Remove recent persisted placeholders that contain no route/documentation data.
-- This leaves actual routes and any row with stop-time data untouched.
delete from public.loads_trips t
using public.loads_shifts s
where t.shift_id = s.id
  and s.shift_date >= current_date - 30
  and app_private.is_blank_trip_placeholder(t);
