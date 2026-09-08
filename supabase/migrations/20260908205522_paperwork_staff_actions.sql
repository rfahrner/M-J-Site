-- Transactional internal actions used by the M-J Site Paperwork Inbox.
-- Original sender_phone and original pro_number are never modified here.

create or replace function public.assign_paperwork_submission(
  p_submission_id uuid,
  p_source_table text,
  p_source_id bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_old public.paperwork_submissions%rowtype;
  v_load_number text;
  v_shift_id bigint;
  v_is_archived boolean := false;
  v_shift_date date;
begin
  if v_uid is null then raise exception 'Authentication required'; end if;
  select public.current_app_role() into v_role;
  if v_role is null or not (v_role = any (array['dispatcher','accounting','admin','it']::text[])) then
    raise exception 'Internal role required';
  end if;

  select * into v_old
  from public.paperwork_submissions
  where id = p_submission_id and deleted_at is null
  for update;
  if not found then raise exception 'Paperwork submission not found'; end if;

  if p_source_table = 'loads_shifts' then
    select coalesce(nullif(s.aljex_load_number,''), nullif(s.pro_number,''), s.id::text), s.id, false, s.shift_date
    into v_load_number, v_shift_id, v_is_archived, v_shift_date
    from public.loads_shifts s where s.id = p_source_id;
  elsif p_source_table in ('loads_houston','mondelez_loads') then
    select f.load_number, null::bigint, false, f.shift_date
    into v_load_number, v_shift_id, v_is_archived, v_shift_date
    from public.analytics_load_facts_all f
    where f.source_table = p_source_table and f.original_id = p_source_id and coalesce(f.is_archived,false) = false
    limit 1;
  else
    select f.load_number, null::bigint, true, f.shift_date
    into v_load_number, v_shift_id, v_is_archived, v_shift_date
    from public.analytics_load_facts_all f
    where f.source_table = p_source_table and f.original_id = p_source_id and coalesce(f.is_archived,false) = true
    limit 1;
  end if;

  if v_load_number is null then
    -- A loads_shifts row can also already be archived, so give the historical
    -- compatibility view one final chance regardless of source name.
    select f.load_number, null::bigint, coalesce(f.is_archived,false), f.shift_date
    into v_load_number, v_shift_id, v_is_archived, v_shift_date
    from public.analytics_load_facts_all f
    where f.source_table = p_source_table and f.original_id = p_source_id
    limit 1;
  end if;

  if v_load_number is null then raise exception 'Selected load no longer exists'; end if;

  update public.paperwork_submissions
  set status = case when v_is_archived then 'archived_match' else 'attached' end,
      match_reason = 'manual',
      matched_source_table = p_source_table,
      matched_source_id = p_source_id,
      matched_shift_id = v_shift_id,
      matched_load_number = v_load_number,
      matched_is_archived = v_is_archived
  where id = p_submission_id;

  insert into public.paperwork_submission_events(
    submission_id, event_type,
    from_source_table, from_source_id,
    to_source_table, to_source_id,
    event_note, created_by
  ) values (
    p_submission_id, 'reattached',
    v_old.matched_source_table, v_old.matched_source_id,
    p_source_table, p_source_id,
    format('Manually attached to %s (%s, %s)', v_load_number, coalesce(v_shift_date::text,'date unknown'), p_source_table),
    v_uid
  );

  return jsonb_build_object(
    'submission_id', p_submission_id,
    'source_table', p_source_table,
    'source_id', p_source_id,
    'load_number', v_load_number,
    'shift_id', v_shift_id,
    'is_archived', v_is_archived,
    'shift_date', v_shift_date,
    'status', case when v_is_archived then 'archived_match' else 'attached' end
  );
end;
$$;

revoke all on function public.assign_paperwork_submission(uuid,text,bigint) from public, anon;
grant execute on function public.assign_paperwork_submission(uuid,text,bigint) to authenticated;

create or replace function public.soft_delete_paperwork_submission(p_submission_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_old public.paperwork_submissions%rowtype;
begin
  if v_uid is null then raise exception 'Authentication required'; end if;
  select public.current_app_role() into v_role;
  if v_role is null or not (v_role = any (array['dispatcher','accounting','admin','it']::text[])) then
    raise exception 'Internal role required';
  end if;

  select * into v_old
  from public.paperwork_submissions
  where id = p_submission_id and deleted_at is null
  for update;
  if not found then raise exception 'Paperwork submission not found'; end if;

  update public.paperwork_submissions
  set status = 'deleted', deleted_at = now(), deleted_by = v_uid
  where id = p_submission_id;

  insert into public.paperwork_submission_events(
    submission_id, event_type, from_source_table, from_source_id, event_note, created_by
  ) values (
    p_submission_id, 'deleted', v_old.matched_source_table, v_old.matched_source_id,
    'Removed from Paperwork Inbox. Durable images retained.', v_uid
  );
end;
$$;

revoke all on function public.soft_delete_paperwork_submission(uuid) from public, anon;
grant execute on function public.soft_delete_paperwork_submission(uuid) to authenticated;
