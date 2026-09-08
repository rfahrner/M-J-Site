-- Internal staff actions in the Paperwork Inbox write append-only audit events.

drop policy if exists paperwork_internal_insert_events on public.paperwork_submission_events;
create policy paperwork_internal_insert_events
on public.paperwork_submission_events for insert to authenticated
with check (
  (select public.current_app_role()) = any (array['dispatcher','accounting','admin','it']::text[])
  and created_by = (select auth.uid())
);

grant insert on public.paperwork_submission_events to authenticated;
