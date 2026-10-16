-- The PA/FA call alert is a REEFER TEMP check, and the audit trail should say so.
--
-- acknowledge_special_route_call() has always written "Driver call confirmed
-- by dispatcher X" into load_change_history. The modal now tells the
-- dispatcher what they are actually confirming -- that they spoke to the
-- driver and the driver has confirmed the temperature on the reefer -- so the
-- permanent record has to carry that same claim. A note that says only "call
-- confirmed" under-records the attestation, and this row is the evidence if a
-- load is ever questioned on temperature.
--
-- Nothing else moves: same signature, same guards, same row lock, same
-- PA/FA-only rule, same columns written. Only the sentence changes, so this is
-- safe to apply while the page is open.
--
-- ORDERING: apply this AFTER the UI that says the same thing is deployed.
-- Applied the other way round, a dispatcher who merely called would get a
-- record claiming they verified a temperature they were never asked about --
-- a false record, which is worse than an incomplete one. Older rows keep
-- their original wording; they recorded what was asked at the time.
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
  if upper(left(btrim(coalesce(nullif(v_trip.route_id,''), v_trip.trip_id, '')), 2)) not in ('PA','FA') then return false; end if;
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
      'Reefer temp confirmed with the driver by dispatcher ' || v_name || ' for route ' || coalesce(v_trip.route_id,v_trip.trip_id));
  return true;
end;
$$;
revoke all on function public.acknowledge_special_route_call(bigint,uuid,text) from public,anon;
grant execute on function public.acknowledge_special_route_call(bigint,uuid,text) to authenticated;
