-- Applied to the live project on 2026-09-18. Kept here so the repo and the
-- database do not drift.

-- 1. Copy-first mode.
-- The archive deletes a Supabase original as soon as Microsoft confirms the
-- uploaded byte count. That is correct steady-state behaviour, but there is no
-- way to prove the whole path works end to end without risking real files on
-- the very first run. With delete_after_archive = false the sweep uploads and
-- records but removes nothing; flipping it to true later lets the existing
-- cleanup pass collect the originals it already has verified copies of.
alter table public.archive_backup_config
  add column if not exists delete_after_archive boolean not null default false;

comment on column public.archive_backup_config.delete_after_archive is
  'false = copy only, Supabase originals are kept. Turn on only after archived images have been confirmed viewable in the app.';

-- 2. Candidate listing no longer hides behind the enabled flag.
-- Whether the automatic sweep is switched on is a question for the cron entry
-- point and for runArchive, both of which check it themselves. Gating the
-- read-only candidate query on it as well meant an operator could not see what
-- WOULD move, and a manual run could not be tested before enabling. Execute is
-- already restricted to service_role, so this exposes nothing new.
create or replace function public.archive_backup_candidates(p_limit integer default 50)
returns table(object_id uuid, bucket_id text, object_name text, created_at timestamp with time zone, bytes bigint, mime_type text)
language sql
security definer
set search_path to 'public', 'storage'
as $function$
  with cfg as (
    select * from public.archive_backup_config where id = true
  ),
  usage_now as (
    select coalesce(sum(coalesce(nullif(o.metadata->>'size','')::bigint, 0)), 0)::bigint as total_bytes
    from storage.objects o
    where o.bucket_id in ('mondelez-routes','trip-sheets')
  )
  select
    o.id,
    o.bucket_id,
    o.name,
    o.created_at,
    coalesce(nullif(o.metadata->>'size','')::bigint, 0)::bigint,
    coalesce(o.metadata->>'mimetype', 'application/octet-stream')
  from storage.objects o
  join cfg on true
  join usage_now u on true
  left join public.archive_backup_items i
    on i.bucket_id = o.bucket_id
   and i.object_name = o.name
   and i.status = 'archived'
  where o.bucket_id in ('mondelez-routes','trip-sheets')
    and i.id is null
    and (
      o.created_at < now() - make_interval(days => cfg.retention_days)
      or (
        u.total_bytes >= 858993459::bigint
        and o.created_at < now() - interval '7 days'
      )
    )
  order by o.created_at asc, o.bucket_id, o.name
  limit greatest(1, least(coalesce(p_limit,50),250));
$function$;

revoke all on function public.archive_backup_candidates(integer) from public, anon, authenticated;
grant execute on function public.archive_backup_candidates(integer) to service_role;

-- 3. How many are still waiting, without the batch limit -- so a run can report
-- what is left and the operator knows whether to go round again.
create or replace function public.archive_backup_remaining()
returns bigint
language sql
security definer
set search_path to 'public', 'storage'
as $function$
  with cfg as (select * from public.archive_backup_config where id = true),
  usage_now as (
    select coalesce(sum(coalesce(nullif(o.metadata->>'size','')::bigint, 0)), 0)::bigint as total_bytes
    from storage.objects o where o.bucket_id in ('mondelez-routes','trip-sheets')
  )
  select count(*)::bigint
  from storage.objects o
  join cfg on true
  join usage_now u on true
  left join public.archive_backup_items i
    on i.bucket_id = o.bucket_id and i.object_name = o.name and i.status = 'archived'
  where o.bucket_id in ('mondelez-routes','trip-sheets')
    and i.id is null
    and (
      o.created_at < now() - make_interval(days => cfg.retention_days)
      or (u.total_bytes >= 858993459::bigint and o.created_at < now() - interval '7 days')
    );
$function$;

revoke all on function public.archive_backup_remaining() from public, anon, authenticated;
grant execute on function public.archive_backup_remaining() to service_role;

-- 4. Status is read by the Archive page through the edge function, which uses
-- the service key after checking the caller is signed in. A signed-out visitor
-- has no reason to read storage totals or the destination link.
revoke execute on function public.archive_backup_status() from public, anon;
