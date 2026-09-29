-- Board Notes now uses the same cell-edit session as Change History. Only a
-- completed, changed, nonblank note reaches this RPC. Append that final note;
-- do not merge separate completed edits using a typing/prefix time window.
-- Existing tabs may continue to use log_board_note until they reload.
create or replace function public.log_committed_board_note(
  p_shift_id bigint,
  p_note_text text,
  p_created_by text
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_catalog
as $$
declare
  v_entry public.load_notes;
  v_author text;
begin
  if p_shift_id is null or coalesce(btrim(p_note_text), '') = '' then
    return null;
  end if;
  v_author := coalesce(nullif(auth.jwt()->>'email', ''), nullif(p_created_by, ''), auth.uid()::text);
  if v_author is null then
    raise exception 'A signed-in author is required for board notes';
  end if;
  insert into public.load_notes (shift_id, note_text, source, created_by)
  values (p_shift_id, btrim(p_note_text), 'board', v_author)
  returning * into v_entry;
  return to_jsonb(v_entry);
end;
$$;

revoke execute on function public.log_committed_board_note(bigint, text, text) from public, anon;
grant execute on function public.log_committed_board_note(bigint, text, text) to authenticated;
