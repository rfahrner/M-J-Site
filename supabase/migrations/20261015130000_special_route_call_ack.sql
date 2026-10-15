-- Per-dispatch shared PA/FA call acknowledgment, independently of routine text tracking.
alter table public.loads_trips
  add column if not exists dispatch_call_ack_event_id uuid,
  add column if not exists dispatch_call_ack_at timestamptz,
  add column if not exists dispatch_call_ack_name text;

create or replace function public.acknowledge_special_route_call(
  p_trip_id bigint, p_event_id uuid, p_dispatcher_name text
) returns boolean
language plpgsql security invoker set search_path = ''
as $$
declare
  v_trip public.loads_trips%rowtype;
  v_shift public.loads_shifts%rowtype;
  v_name text := btrim(coalesce(p_dispatcher_name, ''));
begin
  if auth.uid() is null or coalesce(public.current_app_role(), '') not in ('dispatcher','admin','it','accounting') then
    raise exception 'A signed-in dispatcher is required';
  end if;
  if length(v_name) < 2 or length(v_name) > 100 then
    raise exception 'Enter the dispatcher name (2 to 100 characters)';
  end if;

  -- Row lock serializes simultaneous dispatchers; only the first acknowledgment wins.
  select * into v_trip from public.loads_trips
    where id = p_trip_id for update;
  if not found then return false; end if;
  if v_trip.dispatch_text_event_id is distinct from p_event_id then return false; end if;
  if upper(left(btrim(coalesce(v_trip.route_id, v_trip.trip_id, '')), 2)) not in ('PA','FA') then return false; end if;
  if v_trip.dispatch_call_ack_event_id = p_event_id then return true; end if;
  select * into v_shift from public.loads_shifts where id = v_trip.shift_id;
  if not found or v_shift.shift_complete or v_shift.tonu or v_shift.called_off or v_shift.load_cancelled
      or v_trip.complete or v_trip.minimized then return false; end if;

  update public.loads_trips set dispatch_call_ack_event_id = p_event_id,
    dispatch_call_ack_at = now(), dispatch_call_ack_name = v_name where id = p_trip_id;
  insert into public.load_change_history(shift_id,trip_id,load_label,field_name,old_value,new_value,changed_by,note)
    values (v_trip.shift_id,p_trip_id,coalesce(nullif(v_shift.pro_number,''),v_shift.driver_name_text),
      'special_route_call_acknowledged',null,v_name,
      coalesce(nullif(auth.jwt()->>'email',''),auth.uid()::text),
      'Driver call confirmed by dispatcher ' || v_name || ' for route ' || coalesce(v_trip.route_id,v_trip.trip_id));
  return true;
end;
$$;
revoke all on function public.acknowledge_special_route_call(bigint,uuid,text) from public,anon;
grant execute on function public.acknowledge_special_route_call(bigint,uuid,text) to authenticated;

-- New dispatch-time event means a new call alert, even if an earlier call was handled.
create or replace function public.reset_special_route_call_ack()
returns trigger language plpgsql security invoker set search_path = ''
as $$
begin
  new.dispatch_call_ack_event_id := null;
  new.dispatch_call_ack_at := null;
  new.dispatch_call_ack_name := null;
  return new;
end;
$$;
revoke all on function public.reset_special_route_call_ack() from public,anon;
create trigger reset_special_route_call_ack
before update of dispatch_time on public.loads_trips
for each row when (old.dispatch_time is distinct from new.dispatch_time)
execute function public.reset_special_route_call_ack();
