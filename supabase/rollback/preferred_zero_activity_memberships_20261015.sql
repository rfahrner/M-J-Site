-- MANUAL ROLLBACK ONLY: restore Preferred membership without restoring old
-- ratings, contacts, notes or money. Reject newer membership edits.
begin;
lock table public.atlanta_drivers in share row exclusive mode;
create temporary table preferred_restore on commit drop as
select b.driver_id,b.snapshot->>'location' old_location,
  coalesce((b.snapshot->>'preferred_list_active')::boolean,true) old_active,
  b.snapshot->'_preferred_cleanup'->>'new_location' expected_location,
  (b.snapshot->>'profile_key')::uuid profile_key
from private.driver_profile_sync_backups b
where b.migration_name='preferred_zero_activity_memberships_20261015';
do $$
begin
  if (select count(*) from preferred_restore)<>373 then raise exception 'Expected 373 saved memberships'; end if;
  if exists(select 1 from preferred_restore r left join public.atlanta_drivers d on d.id=r.driver_id
    where d.id is null or d.profile_key is distinct from r.profile_key
      or d.location is distinct from r.expected_location or d.preferred_list_active) then
    raise exception 'A membership changed since cleanup; review before restoring';
  end if;
  if exists(select 1 from preferred_restore r join public.atlanta_drivers d on d.profile_key=r.profile_key
    where d.location='preferred' and d.preferred_list_active
      and not exists(select 1 from preferred_restore old where old.driver_id=d.id)) then
    raise exception 'A newer Preferred membership exists; review before restoring';
  end if;
end;
$$;
update public.atlanta_drivers d set location=r.old_location,preferred_list_active=r.old_active
from preferred_restore r where d.id=r.driver_id;
commit;
