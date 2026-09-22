-- The board logs a note and a change-history entry on focusout. That is the
-- right moment in principle, but the board also redraws while someone types
-- (realtime echoes, debounced saves), and a redraw replaces the focused input
-- -- which fires focusout with whatever partial text was on screen. So one
-- sentence became a row per redraw:
--
--   "store"                                          7:48:54 PM
--   "store did not have S"                           7:48:58 PM
--   ...
--   "store did not have Salvage for driver to..."    7:49:10 PM
--
-- Only the last line is the note. Same thing in load_change_history across
-- every text field: 740 of 36,352 entries were keystroke fragments, so the
-- audit trail recorded typing rather than changes.
--
-- Fixing this at the write, rather than at the focusout, means it holds no
-- matter what causes a duplicate: an entry that merely extends (or trims) the
-- previous one from the same person, on the same field, within a short window,
-- replaces it instead of adding to it. starts_with() is used rather than LIKE
-- so that % and _ in a dispatcher's text are literal characters.
--
-- Verified against the live database inside a rolled-back transaction, with a
-- real dispatcher's claims set so the role guard was exercised:
--   three-keystroke note chain      -> 1 row, final text, same id
--   a genuinely different note      -> its own row
--   a second author                 -> their own row
--   three-keystroke field chain     -> 1 row, old_value still 'BEFORE'
--   blank "before" / no-op write    -> no row at all
--   an unrelated new value          -> its own row

-- Board notes. SECURITY DEFINER because load_notes has no UPDATE policy and
-- the alternative -- a blanket UPDATE policy -- would let the API rewrite any
-- note at all. This permits exactly one thing: replacing the text of your own
-- board note from the last few minutes. The role is checked here, server-side,
-- and never taken from anything the browser asserts.
create or replace function public.log_board_note(
  p_shift_id   bigint,
  p_note_text  text,
  p_created_by text
)
returns bigint
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_role text;
  v_id   bigint;
  v_prev text;
begin
  if p_shift_id is null or coalesce(btrim(p_note_text), '') = '' then
    return null;
  end if;

  v_role := public.current_app_role();
  if v_role is null or v_role not in ('dispatcher', 'accounting', 'admin', 'it') then
    raise exception 'log_board_note: not permitted for role %', coalesce(v_role, '(none)');
  end if;

  select id, note_text
    into v_id, v_prev
  from public.load_notes
  where shift_id = p_shift_id
    and source = 'board'
    and coalesce(created_by, '') = coalesce(p_created_by, '')
    and created_at > now() - interval '5 minutes'
  order by created_at desc, id desc
  limit 1
  for update;

  if v_id is not null
     and (starts_with(p_note_text, v_prev) or starts_with(v_prev, p_note_text)) then
    update public.load_notes
       set note_text  = p_note_text,
           created_at = now()
     where id = v_id;
    return v_id;
  end if;

  insert into public.load_notes (shift_id, note_text, source, created_by)
  values (p_shift_id, p_note_text, 'board', p_created_by)
  returning id into v_id;
  return v_id;
end;
$$;

revoke execute on function public.log_board_note(bigint, text, text) from public, anon;
grant  execute on function public.log_board_note(bigint, text, text) to authenticated;

-- Change history. SECURITY INVOKER: load_change_history already has an UPDATE
-- policy for the same roles as its INSERT policy, so the caller's own RLS
-- covers this and the function needs no elevated rights.
--
-- The window is tighter than for notes (2 minutes vs 5): a field value is
-- typed in one go, while a note is a sentence someone may pause mid-way
-- through. old_value is deliberately left alone on a merge -- the true "before"
-- is the value that was there when editing started, not the previous keystroke.
create or replace function public.log_load_change(
  p_shift_id   bigint,
  p_load_label text,
  p_field_name text,
  p_old_value  text,
  p_new_value  text,
  p_changed_by text,
  p_trip_id    bigint default null
)
returns bigint
language plpgsql
security invoker
set search_path = public, pg_catalog
as $$
declare
  v_id   bigint;
  v_prev text;
begin
  if p_shift_id is null or p_field_name is null then
    return null;
  end if;
  -- Entering a value into a previously blank field is not a change, and a
  -- no-op write is not a change. Mirrors the guards in logChange().
  if coalesce(btrim(p_old_value), '') = '' then
    return null;
  end if;
  if coalesce(p_old_value, '') = coalesce(p_new_value, '') then
    return null;
  end if;

  select id, new_value
    into v_id, v_prev
  from public.load_change_history
  where shift_id = p_shift_id
    and field_name = p_field_name
    and coalesce(changed_by, '') = coalesce(p_changed_by, '')
    and coalesce(trip_id, -1) = coalesce(p_trip_id, -1)
    and changed_at > now() - interval '2 minutes'
  order by changed_at desc, id desc
  limit 1
  for update;

  if v_id is not null and v_prev is not null and p_new_value is not null
     and (starts_with(p_new_value, v_prev) or starts_with(v_prev, p_new_value)) then
    update public.load_change_history
       set new_value  = p_new_value,
           changed_at = now()
     where id = v_id;
    return v_id;
  end if;

  insert into public.load_change_history
    (shift_id, trip_id, load_label, field_name, old_value, new_value, changed_by)
  values
    (p_shift_id, p_trip_id, p_load_label, p_field_name, p_old_value, p_new_value, p_changed_by)
  returning id into v_id;
  return v_id;
end;
$$;

revoke execute on function public.log_load_change(bigint, text, text, text, text, text, bigint) from public, anon;
grant  execute on function public.log_load_change(bigint, text, text, text, text, text, bigint) to authenticated;
