-- Standard boards (Atlanta, Delaware and Building C): history is pushed by
-- explicit user edits/actions. Autosaves, profile linking and calculations
-- must not manufacture history. Keep existing history and accounting snapshot
-- triggers intact. The old logging functions remain for rollback only.
drop trigger if exists loads_shifts_change_log on public.loads_shifts;
drop trigger if exists loads_trips_change_log on public.loads_trips;

-- A separate RPC keeps older open tabs compatible with log_load_change.
-- One call represents one completed user edit, including an initial entry.
-- Never coalesce two distinct committed edits just because they are close in
-- time or one value happens to be a prefix of the next.
create or replace function public.log_committed_load_change(
  p_shift_id bigint,
  p_load_label text,
  p_field_name text,
  p_old_value text,
  p_new_value text,
  p_changed_by text,
  p_trip_id bigint default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_catalog
as $$
declare
  v_entry public.load_change_history;
  v_author text;
begin
  if p_shift_id is null or coalesce(btrim(p_field_name), '') = ''
     or coalesce(btrim(p_old_value), '') = coalesce(btrim(p_new_value), '') then
    return null;
  end if;
  -- The signed-in identity takes precedence over a client-provided label.
  v_author := coalesce(nullif(auth.jwt()->>'email', ''), nullif(p_changed_by, ''), auth.uid()::text);
  if v_author is null then
    raise exception 'A signed-in author is required for change history';
  end if;
  if p_trip_id is not null and not exists (
    select 1 from public.loads_trips where id = p_trip_id and shift_id = p_shift_id
  ) then
    raise exception 'The route does not belong to this load';
  end if;
  insert into public.load_change_history
    (shift_id, trip_id, load_label, field_name, old_value, new_value, changed_by)
  values
    (p_shift_id, p_trip_id, p_load_label, p_field_name,
     nullif(btrim(p_old_value), ''), nullif(btrim(p_new_value), ''), v_author)
  returning * into v_entry;
  return to_jsonb(v_entry);
end;
$$;

revoke execute on function public.log_committed_load_change(bigint, text, text, text, text, text, bigint) from public, anon;
grant execute on function public.log_committed_load_change(bigint, text, text, text, text, text, bigint) to authenticated;
