-- One RPC transaction records each recipient load in a grouped alert. The
-- database supplies the signed-in author and timestamp; no send is asserted.
create function public.log_alert_text_click(
  p_source text, p_load_ids bigint[], p_alert_label text, p_message text,
  p_trip_id bigint default null
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  load_id bigint;
  load_label text;
  entry jsonb;
  entries jsonb := '[]'::jsonb;
  actor text := coalesce(nullif(auth.jwt()->>'email',''),auth.uid()::text);
  event_note text := 'Draft message (click only; sending is not confirmed): ' || coalesce(p_message,'');
begin
  if auth.uid() is null or coalesce(public.current_app_role(),'') not in ('dispatcher','accounting','admin','it') then
    raise exception 'An internal signed-in user is required';
  end if;
  if p_source not in ('loads_shifts','loads_houston','mondelez_loads') or p_source is null then raise exception 'Unknown load source'; end if;
  if coalesce(cardinality(p_load_ids),0)=0 or cardinality(p_load_ids)>200 then raise exception 'Select between 1 and 200 loads'; end if;
  if p_trip_id is not null and (p_source <> 'loads_shifts' or cardinality(p_load_ids)<>1) then raise exception 'A route must belong to one standard load'; end if;
  for load_id in select distinct id from unnest(p_load_ids) as ids(id) loop
    if load_id is null or load_id<=0 then raise exception 'Invalid load ID'; end if;
    if p_source='loads_shifts' then
      select coalesce(nullif(s.pro_number,''),s.driver_name_text) into load_label from public.loads_shifts s where s.id=load_id;
      if not found then raise exception 'Load is no longer available'; end if;
      if p_trip_id is not null and not exists(select 1 from public.loads_trips t where t.id=p_trip_id and t.shift_id=load_id) then raise exception 'The route does not belong to this load'; end if;
      insert into public.load_change_history(shift_id,trip_id,load_label,field_name,old_value,new_value,changed_by,note)
        values(load_id,p_trip_id,load_label,'alert_text_clicked',null,coalesce(nullif(p_alert_label,''),'Driver reminder'),actor,event_note)
        returning to_jsonb(load_change_history.*) into entry;
    elsif p_source='loads_houston' then
      perform 1 from public.loads_houston where id=load_id;
      if not found then raise exception 'Houston load is no longer available'; end if;
      insert into public.houston_change_history(houston_load_id,field_name,old_value,new_value,changed_by,note)
        values(load_id,'alert_text_clicked',null,coalesce(nullif(p_alert_label,''),'Driver reminder'),actor,event_note)
        returning to_jsonb(houston_change_history.*) into entry;
    else
      perform 1 from public.mondelez_loads where id=load_id;
      if not found then raise exception 'Mondelez load is no longer available'; end if;
      insert into public.mondelez_change_history(mondelez_load_id,field_name,old_value,new_value,changed_by,note)
        values(load_id,'alert_text_clicked',null,coalesce(nullif(p_alert_label,''),'Driver reminder'),actor,event_note)
        returning to_jsonb(mondelez_change_history.*) into entry;
    end if;
    entries := entries || jsonb_build_array(entry || jsonb_build_object('source',p_source));
  end loop;
  return entries;
end;
$$;
revoke all on function public.log_alert_text_click(text,bigint[],text,text,bigint) from public,anon;
grant execute on function public.log_alert_text_click(text,bigint[],text,text,bigint) to authenticated;
