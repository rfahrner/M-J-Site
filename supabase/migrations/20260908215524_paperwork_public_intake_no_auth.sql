alter table public.paperwork_submissions
  alter column sender_phone drop not null;

drop index if exists public.paperwork_submissions_sender_phone_idx;
drop index if exists public.paperwork_submissions_sender_auth_user_id_idx;

create table if not exists public.paperwork_intake_rate_limits (
  key_hash text primary key,
  window_started_at timestamptz not null default now(),
  request_count integer not null default 0,
  updated_at timestamptz not null default now(),
  constraint paperwork_intake_rate_limits_key_hash_check
    check (char_length(key_hash) between 32 and 128),
  constraint paperwork_intake_rate_limits_request_count_check
    check (request_count >= 0)
);

alter table public.paperwork_intake_rate_limits enable row level security;

revoke all on public.paperwork_intake_rate_limits from public, anon, authenticated;
grant select, insert, update, delete on public.paperwork_intake_rate_limits to service_role;

create or replace function public.consume_paperwork_rate_limit(
  p_key_hash text,
  p_window_seconds integer,
  p_max_submissions integer
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_count integer;
begin
  if p_key_hash is null
     or char_length(p_key_hash) < 32
     or char_length(p_key_hash) > 128
     or p_window_seconds < 1
     or p_window_seconds > 86400
     or p_max_submissions < 1
     or p_max_submissions > 100000
  then
    return false;
  end if;

  insert into public.paperwork_intake_rate_limits(
    key_hash, window_started_at, request_count, updated_at
  )
  values (p_key_hash, v_now, 1, v_now)
  on conflict (key_hash) do update
  set
    window_started_at = case
      when public.paperwork_intake_rate_limits.window_started_at
           <= v_now - make_interval(secs => p_window_seconds)
      then v_now
      else public.paperwork_intake_rate_limits.window_started_at
    end,
    request_count = case
      when public.paperwork_intake_rate_limits.window_started_at
           <= v_now - make_interval(secs => p_window_seconds)
      then 1
      else public.paperwork_intake_rate_limits.request_count + 1
    end,
    updated_at = v_now
  returning request_count into v_count;

  delete from public.paperwork_intake_rate_limits
  where updated_at < v_now - interval '2 days';

  return v_count <= p_max_submissions;
end;
$$;

revoke all on function public.consume_paperwork_rate_limit(text,integer,integer)
  from public, anon, authenticated;
grant execute on function public.consume_paperwork_rate_limit(text,integer,integer)
  to service_role;

comment on column public.paperwork_submissions.sender_phone is
  'Legacy optional sender phone. New M-J-App submissions do not identify senders.';
comment on column public.paperwork_submissions.sender_auth_user_id is
  'Legacy optional sender auth user. New M-J-App submissions are identity-free.';
