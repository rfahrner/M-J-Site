alter table public.paperwork_submissions
  alter column pro_number drop not null,
  add column if not exists driver_name text,
  add column if not exists submitted_location text,
  add column if not exists inbox_status text not null default 'unread';

alter table public.paperwork_submissions
  drop constraint if exists paperwork_submissions_pro_number_check;

alter table public.paperwork_submissions
  add constraint paperwork_submissions_pro_number_check
  check (pro_number is null or (char_length(btrim(pro_number)) >= 1 and char_length(btrim(pro_number)) <= 64));

alter table public.paperwork_submissions
  add constraint paperwork_submissions_driver_name_check
  check (driver_name is null or (char_length(btrim(driver_name)) >= 1 and char_length(btrim(driver_name)) <= 120));

alter table public.paperwork_submissions
  add constraint paperwork_submissions_submitted_location_check
  check (submitted_location is null or submitted_location in ('kroger_atlanta','kroger_delaware'));

alter table public.paperwork_submissions
  add constraint paperwork_submissions_inbox_status_check
  check (inbox_status in ('unread','read','needs_review'));

create index if not exists paperwork_submissions_location_status_idx
  on public.paperwork_submissions (submitted_location, inbox_status, submitted_at desc)
  where deleted_at is null;

create or replace function public.paperwork_set_inbox_status(
  p_submission_id uuid,
  p_inbox_status text
)
returns public.paperwork_submissions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
  v_row public.paperwork_submissions;
begin
  select role into v_role from public.user_roles where user_id = auth.uid();
  if v_role is null or v_role not in ('dispatcher','accounting','admin','it') then
    raise exception 'Not authorized';
  end if;
  if p_inbox_status not in ('unread','read','needs_review') then
    raise exception 'Invalid inbox status';
  end if;
  update public.paperwork_submissions
     set inbox_status = p_inbox_status,
         updated_at = now()
   where id = p_submission_id and deleted_at is null
   returning * into v_row;
  if v_row.id is null then raise exception 'Submission not found'; end if;
  return v_row;
end;
$$;

revoke all on function public.paperwork_set_inbox_status(uuid,text) from public;
grant execute on function public.paperwork_set_inbox_status(uuid,text) to authenticated;
