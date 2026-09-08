revoke all privileges on table public.paperwork_submissions from public, anon;
revoke all privileges on table public.paperwork_images from public, anon;
revoke all privileges on table public.paperwork_notes from public, anon;
revoke all privileges on table public.paperwork_submission_events from public, anon;
revoke all privileges on table public.paperwork_intake_rate_limits from public, anon, authenticated;

revoke all privileges on sequence public.paperwork_notes_id_seq from public, anon;
revoke all privileges on sequence public.paperwork_submission_events_id_seq from public, anon;

-- Preserve the explicit internal-site grants used by role-gated RLS.
grant select on public.paperwork_submissions to authenticated;
grant update (status, match_reason, matched_source_table, matched_source_id, matched_shift_id, matched_load_number, matched_is_archived, note, deleted_at, deleted_by)
  on public.paperwork_submissions to authenticated;
grant select on public.paperwork_images to authenticated;
grant update (note) on public.paperwork_images to authenticated;
grant select, insert, update on public.paperwork_notes to authenticated;
grant select, insert on public.paperwork_submission_events to authenticated;
grant usage, select on sequence public.paperwork_notes_id_seq to authenticated;
grant usage, select on sequence public.paperwork_submission_events_id_seq to authenticated;

grant select, insert, update, delete on public.paperwork_intake_rate_limits to service_role;
grant execute on function public.consume_paperwork_rate_limit(text,integer,integer) to service_role;
