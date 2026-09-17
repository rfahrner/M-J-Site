create or replace function public.archive_backup_candidates(p_limit integer default 50)
returns table (
  object_id uuid,
  bucket_id text,
  object_name text,
  created_at timestamptz,
  bytes bigint,
  mime_type text
)
language sql
security definer
set search_path = public, storage
as $$
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
  where cfg.enabled = true
    and o.bucket_id in ('mondelez-routes','trip-sheets')
    and i.id is null
    and (
      o.created_at < now() - make_interval(days => cfg.retention_days)
      or (
        u.total_bytes >= 858993459::bigint
        and o.created_at < now() - interval '7 days'
      )
    )
  order by o.created_at asc, o.bucket_id, o.name
  limit greatest(1, least(coalesce(p_limit,50),50));
$$;

revoke all on function public.archive_backup_candidates(integer) from public, anon, authenticated;

DO $$
DECLARE
  rec record;
BEGIN
  for rec in
    select jobid from cron.job
    where jobname in ('mj-image-archive-daily','mj-image-archive-frequent')
  loop
    perform cron.unschedule(rec.jobid);
  end loop;
END $$;

select cron.schedule(
  'mj-image-archive-frequent',
  '*/15 * * * *',
  $$select public.run_image_archive_cron();$$
);
