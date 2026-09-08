-- Durable mobile paperwork intake for M-J-App.
-- This migration is intentionally additive. It does not alter existing load,
-- accounting, attachment, or archive tables.

create table if not exists public.paperwork_submissions (
  id uuid primary key default gen_random_uuid(),
  sender_auth_user_id uuid references auth.users(id) on delete set null,
  sender_phone text not null,
  pro_number text not null,
  note text,
  status text not null default 'needs_review',
  match_reason text not null default 'pending',
  matched_source_table text,
  matched_source_id bigint,
  matched_shift_id bigint references public.loads_shifts(id) on delete set null,
  matched_load_number text,
  matched_is_archived boolean not null default false,
  submitted_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references auth.users(id) on delete set null,
  constraint paperwork_submissions_sender_phone_check check (char_length(btrim(sender_phone)) between 8 and 32),
  constraint paperwork_submissions_pro_number_check check (char_length(btrim(pro_number)) between 1 and 64),
  constraint paperwork_submissions_note_check check (note is null or char_length(note) <= 500),
  constraint paperwork_submissions_status_check check (status in ('attached','needs_review','archived_match','deleted')),
  constraint paperwork_submissions_match_reason_check check (match_reason in ('pending','exact_unique','no_match','ambiguous','manual','archived_unique'))
);

create table if not exists public.paperwork_images (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.paperwork_submissions(id) on delete cascade,
  storage_bucket text not null default 'paperwork-submissions',
  storage_path text not null unique,
  original_file_name text not null,
  mime_type text not null,
  byte_size bigint,
  sort_order smallint not null default 0,
  note text,
  uploaded_at timestamptz not null default now(),
  constraint paperwork_images_bucket_check check (storage_bucket = 'paperwork-submissions'),
  constraint paperwork_images_size_check check (byte_size is null or (byte_size >= 0 and byte_size <= 15728640)),
  constraint paperwork_images_note_check check (note is null or char_length(note) <= 1000)
);

create table if not exists public.paperwork_notes (
  id bigint generated always as identity primary key,
  submission_id uuid not null references public.paperwork_submissions(id) on delete cascade,
  image_id uuid references public.paperwork_images(id) on delete cascade,
  note_text text not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint paperwork_notes_text_check check (char_length(btrim(note_text)) between 1 and 2000)
);

create table if not exists public.paperwork_submission_events (
  id bigint generated always as identity primary key,
  submission_id uuid not null references public.paperwork_submissions(id) on delete cascade,
  event_type text not null,
  from_source_table text,
  from_source_id bigint,
  to_source_table text,
  to_source_id bigint,
  event_note text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint paperwork_submission_events_type_check check (event_type in ('submitted','auto_attached','needs_review','reattached','note_added','deleted','restored')),
  constraint paperwork_submission_events_note_check check (event_note is null or char_length(event_note) <= 2000)
);

create index if not exists paperwork_submissions_submitted_at_idx
  on public.paperwork_submissions (submitted_at desc);
create index if not exists paperwork_submissions_status_idx
  on public.paperwork_submissions (status, submitted_at desc);
create index if not exists paperwork_submissions_sender_phone_idx
  on public.paperwork_submissions (sender_phone, submitted_at desc);
create index if not exists paperwork_submissions_pro_number_idx
  on public.paperwork_submissions (pro_number);
create index if not exists paperwork_submissions_matched_target_idx
  on public.paperwork_submissions (matched_source_table, matched_source_id);
create index if not exists paperwork_images_submission_idx
  on public.paperwork_images (submission_id, sort_order);
create index if not exists paperwork_notes_submission_idx
  on public.paperwork_notes (submission_id, created_at);
create index if not exists paperwork_events_submission_idx
  on public.paperwork_submission_events (submission_id, created_at);

create or replace function public.paperwork_touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists paperwork_submissions_touch_updated_at on public.paperwork_submissions;
create trigger paperwork_submissions_touch_updated_at
before update on public.paperwork_submissions
for each row execute function public.paperwork_touch_updated_at();

alter table public.paperwork_submissions enable row level security;
alter table public.paperwork_images enable row level security;
alter table public.paperwork_notes enable row level security;
alter table public.paperwork_submission_events enable row level security;

-- Mobile users deliberately receive no table INSERT/SELECT policies. The
-- authenticated Edge Function performs intake with a server-side secret key.
-- Internal M-J roles can read/manage the inbox through the normal website.
drop policy if exists paperwork_internal_select_submissions on public.paperwork_submissions;
create policy paperwork_internal_select_submissions
on public.paperwork_submissions for select to authenticated
using ((select public.current_app_role()) = any (array['dispatcher','accounting','admin','it']::text[]));

drop policy if exists paperwork_internal_update_submissions on public.paperwork_submissions;
create policy paperwork_internal_update_submissions
on public.paperwork_submissions for update to authenticated
using ((select public.current_app_role()) = any (array['dispatcher','accounting','admin','it']::text[]))
with check ((select public.current_app_role()) = any (array['dispatcher','accounting','admin','it']::text[]));

drop policy if exists paperwork_internal_select_images on public.paperwork_images;
create policy paperwork_internal_select_images
on public.paperwork_images for select to authenticated
using ((select public.current_app_role()) = any (array['dispatcher','accounting','admin','it']::text[]));

drop policy if exists paperwork_internal_update_images on public.paperwork_images;
create policy paperwork_internal_update_images
on public.paperwork_images for update to authenticated
using ((select public.current_app_role()) = any (array['dispatcher','accounting','admin','it']::text[]))
with check ((select public.current_app_role()) = any (array['dispatcher','accounting','admin','it']::text[]));

drop policy if exists paperwork_internal_select_notes on public.paperwork_notes;
create policy paperwork_internal_select_notes
on public.paperwork_notes for select to authenticated
using ((select public.current_app_role()) = any (array['dispatcher','accounting','admin','it']::text[]));

drop policy if exists paperwork_internal_insert_notes on public.paperwork_notes;
create policy paperwork_internal_insert_notes
on public.paperwork_notes for insert to authenticated
with check (
  (select public.current_app_role()) = any (array['dispatcher','accounting','admin','it']::text[])
  and created_by = (select auth.uid())
);

drop policy if exists paperwork_internal_update_notes on public.paperwork_notes;
create policy paperwork_internal_update_notes
on public.paperwork_notes for update to authenticated
using (created_by = (select auth.uid()) or (select public.current_app_role()) = any (array['admin','it']::text[]))
with check ((select public.current_app_role()) = any (array['dispatcher','accounting','admin','it']::text[]));

drop policy if exists paperwork_internal_select_events on public.paperwork_submission_events;
create policy paperwork_internal_select_events
on public.paperwork_submission_events for select to authenticated
using ((select public.current_app_role()) = any (array['dispatcher','accounting','admin','it']::text[]));

grant select on public.paperwork_submissions to authenticated;
grant update (status, match_reason, matched_source_table, matched_source_id, matched_shift_id, matched_load_number, matched_is_archived, note, deleted_at, deleted_by)
  on public.paperwork_submissions to authenticated;
grant select on public.paperwork_images to authenticated;
grant update (note) on public.paperwork_images to authenticated;
grant select, insert, update on public.paperwork_notes to authenticated;
grant select on public.paperwork_submission_events to authenticated;
grant usage, select on sequence public.paperwork_notes_id_seq to authenticated;
grant usage, select on sequence public.paperwork_submission_events_id_seq to authenticated;

-- Durable originals live outside the existing trip-sheets bucket. The archive
-- purge intentionally deletes trip-sheets objects tied to old loads; it must
-- never delete these master submissions.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'paperwork-submissions',
  'paperwork-submissions',
  false,
  15728640,
  array['image/jpeg','image/png','image/webp','image/heic','image/heif']::text[]
)
on conflict (id) do nothing;

drop policy if exists paperwork_internal_select_storage on storage.objects;
create policy paperwork_internal_select_storage
on storage.objects for select to authenticated
using (
  bucket_id = 'paperwork-submissions'
  and (select public.current_app_role()) = any (array['dispatcher','accounting','admin','it']::text[])
);
