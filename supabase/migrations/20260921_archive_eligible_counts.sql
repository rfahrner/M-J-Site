-- Counting what the Archive page is about to export used to mean downloading
-- it: every eligible load with select *, then every trip, attachment and
-- accounting row for them in 150-id chunks. With ~21,000 old loads that is
-- roughly 330 sequential requests before four numbers appear on screen, which
-- is why the page looked dead on arrival and the six-month cutoff felt inert.
-- Server-side this is one query and about two seconds.
--
-- SECURITY INVOKER (the default) is deliberate: the function sees exactly what
-- the signed-in user's RLS policies let them see, so it cannot become a way to
-- count rows someone is not allowed to read.
--
-- Verified against the live data for a six-month cutoff, matching what the old
-- client-side counting produced row for row:
--   kroger 11,792 · houston 9,398 · mondelez 610 · routes 32,541
--   attachments 0 · accounting 11,678
-- No accounting row carries both a source_shift_id and a source_houston_id, so
-- the OR below cannot differ from the two separate counts it replaces, and no
-- eligible trip lacks a route_id/trip_id label, so count(*) matches the old
-- label-filtered count.
create or replace function public.archive_eligible_counts(p_cutoff date)
returns table (
  kroger_loads    bigint,
  houston_loads   bigint,
  mondelez_loads  bigint,
  routes          bigint,
  attachments     bigint,
  accounting_rows bigint
)
language sql
stable
security invoker
set search_path = public, pg_catalog
as $$
  with k as (
    select id from public.loads_shifts
    where location in ('atlanta', 'buildingc', 'delaware')
      and shift_date < p_cutoff
  ),
  h as (
    select id from public.loads_houston
    where shift_date < p_cutoff
  ),
  m as (
    select id from public.mondelez_loads
    where shift_date < p_cutoff
  )
  select
    (select count(*) from k),
    (select count(*) from h),
    (select count(*) from m),
    (select count(*) from public.loads_trips t where t.shift_id in (select id from k))
      + (select count(*) from m),
    (select count(*) from public.load_attachments a where a.shift_id in (select id from k)),
    (select count(*) from public.loads_accounting ac
      where ac.source_shift_id in (select id from k)
         or ac.source_houston_id in (select id from h));
$$;

revoke execute on function public.archive_eligible_counts(date) from public, anon;
grant execute on function public.archive_eligible_counts(date) to authenticated;
