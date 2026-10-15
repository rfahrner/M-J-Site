-- MANUAL ROLLBACK ONLY. Do not run as part of deployment.
-- Reverts only ratings from the saved batch. Stops if a rating/profile/list
-- membership changed since the cleanup, so newer dispatcher work is not lost.
begin;
lock table public.atlanta_drivers in share row exclusive mode;
create temporary table rating_restore on commit drop as
select b.driver_id,b.snapshot->>'Driver Rating' old_rating,
       b.snapshot->'_rating_cleanup'->>'new_rating' expected_rating,
       (b.snapshot->>'profile_key')::uuid profile_key
from private.driver_profile_sync_backups b
where b.migration_name='atlanta_preferred_rating_cleanup_20261015';
create temporary table rating_restore_before on commit drop as
  select d.id,to_jsonb(d) snapshot from public.atlanta_drivers d;
do $$
begin
  if (select count(*) from rating_restore)<>390 then raise exception 'Expected 390 saved memberships'; end if;
  if exists(select 1 from rating_restore r left join public.atlanta_drivers d on d.id=r.driver_id
    where d.id is null or d.profile_key is distinct from r.profile_key
      or d."Driver Rating" is distinct from r.expected_rating) then
    raise exception 'A profile or rating changed after cleanup; review before rollback';
  end if;
  if exists(select 1 from public.atlanta_drivers d join rating_restore r on r.profile_key=d.profile_key
    where not exists(select 1 from rating_restore peer where peer.driver_id=d.id)) then
    raise exception 'A profile acquired an unreviewed list membership';
  end if;
end;
$$;
with representatives as (
  select distinct on (profile_key) driver_id,old_rating from rating_restore order by profile_key,driver_id
)
update public.atlanta_drivers d set "Driver Rating"=r.old_rating
from representatives r where d.id=r.driver_id;
do $$
begin
  if exists(select 1 from rating_restore r join public.atlanta_drivers d on d.id=r.driver_id
    where d."Driver Rating" is distinct from r.old_rating) then raise exception 'A rating was not restored'; end if;
  if exists(select 1 from rating_restore_before b join public.atlanta_drivers d on d.id=b.id
    where (to_jsonb(d)-'Driver Rating') is distinct from (b.snapshot-'Driver Rating')) then
    raise exception 'A non-rating field changed during rollback';
  end if;
end;
$$;
commit;
