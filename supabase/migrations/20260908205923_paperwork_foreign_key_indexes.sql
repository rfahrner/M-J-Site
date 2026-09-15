create index if not exists paperwork_submissions_sender_auth_user_id_idx
  on public.paperwork_submissions (sender_auth_user_id);
create index if not exists paperwork_submissions_matched_shift_id_idx
  on public.paperwork_submissions (matched_shift_id);
create index if not exists paperwork_submissions_deleted_by_idx
  on public.paperwork_submissions (deleted_by);
create index if not exists paperwork_notes_image_id_idx
  on public.paperwork_notes (image_id);
create index if not exists paperwork_notes_created_by_idx
  on public.paperwork_notes (created_by);
create index if not exists paperwork_events_created_by_idx
  on public.paperwork_submission_events (created_by);
