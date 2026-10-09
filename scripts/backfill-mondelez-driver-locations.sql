-- One-time historical seed requested 2026-10-09. Snapshot every affected peer
-- before changing only Mondelez origins and missing Mondelez membership.
-- Re-running preserves manual origins and the original rollback snapshots.
-- Keep concurrent profile saves from racing the short snapshot/update transaction.
begin;
lock table public.atlanta_drivers in share row exclusive mode;
create temporary table mdz_history_matches on commit drop as
with names as (
  select lower(regexp_replace(btrim("Driver Name"), '\s+', ' ', 'g')) as name_key,
         count(distinct profile_key) as identities,
         (array_agg(distinct profile_key))[1] as profile_key
  from public.atlanta_drivers
  where nullif(btrim("Driver Name"),'') is not null group by 1
), history as (
  select l.id,l.location,l.shift_date,d.profile_key as id_profile,
    lower(regexp_replace(btrim(d."Driver Name"), '\s+', ' ', 'g')) as id_name,
    lower(regexp_replace(btrim(l.driver_name), '\s+', ' ', 'g')) as history_name,
    n.identities,n.profile_key as name_profile
  from public.mondelez_loads l
  left join public.atlanta_drivers d on d.id=l.driver_id
  left join names n on n.name_key=lower(regexp_replace(btrim(l.driver_name), '\s+', ' ', 'g'))
  where l.shift_date<=date '2026-10-09'
    and l.location in ('westchester','morris','addison','indianapolis','louisville',
      'spokane','lasvegas','boise','kent','saltlakecity','newberlin','brooklynpark','clarksville')
), matched as (
  select *,case
    when id_profile is not null and (id_name=history_name or nullif(history_name,'') is null) then id_profile
    -- A linked ID plus a compatible short name / annotation / single
    -- adjacent-letter transposition is usable only if the typed name does
    -- not identify another saved profile. Different people's names stay out.
    when id_profile is not null and (identities is null or (identities=1 and name_profile=id_profile)) and (
      split_part(history_name,' - ',1)=id_name
      or history_name=split_part(id_name,' ',1)
      or id_name=split_part(history_name,' ',1)
      or exists(select 1 from generate_series(1,length(history_name)-1) i
        where substring(history_name,1,i-1)||substring(history_name,i+1,1)||substring(history_name,i,1)||substring(history_name,i+2)=id_name)
    ) then id_profile
    when id_profile is null and identities=1 then name_profile
    else null end as matched_profile
  from history
)
select * from matched;

create temporary table mdz_location_plan on commit drop as
with targets as (
  select distinct profile_key from public.atlanta_drivers
  where location='mondelez' or 'mondelez'=any(runs_out_of)
), historical as (
  select matched_profile as profile_key,array_agg(distinct location order by location) as sites
  from mdz_history_matches where matched_profile is not null group by 1
), heads as (
  select distinct on(d.profile_key) d.* from public.atlanta_drivers d
  join targets t using(profile_key) order by d.profile_key,d.id
)
select h.profile_key,h.id as head_id,
  (select array_agg(distinct site order by site) from (
     select unnest(d.mondelez_locations) as site from public.atlanta_drivers d where d.profile_key=h.profile_key
     union select unnest(a.sites)
   ) sites) as new_locations,
  case when 'mondelez'=any(h.runs_out_of) then h.runs_out_of
       else array_append(coalesce(h.runs_out_of,array[]::text[]),'mondelez') end as new_runs
from heads h left join historical a using(profile_key);

create temporary table mdz_changed_groups on commit drop as
select p.* from mdz_location_plan p
where exists(select 1 from public.atlanta_drivers d where d.profile_key=p.profile_key
  and (d.mondelez_locations is distinct from p.new_locations or d.runs_out_of is distinct from p.new_runs));

create temporary table mdz_before_changes on commit drop as
select d.id,to_jsonb(d) as before_image
from public.atlanta_drivers d join mdz_changed_groups p using(profile_key);

insert into private.driver_profile_sync_backups(migration_name,driver_id,snapshot)
select 'mondelez_locations_history_20261009',id,before_image from mdz_before_changes
on conflict do nothing;

-- A representative with a changed value triggers synchronization. Choose it
-- separately for each field so an already-correct head cannot hide stale peers.
do $backfill$
declare plan record; target_id bigint;
begin
  for plan in select * from mdz_changed_groups loop
    select id into target_id from public.atlanta_drivers
    where profile_key=plan.profile_key and mondelez_locations is distinct from plan.new_locations
    order by id limit 1;
    if target_id is not null then
      update public.atlanta_drivers set mondelez_locations=plan.new_locations where id=target_id;
    end if;
    select id into target_id from public.atlanta_drivers
    where profile_key=plan.profile_key and runs_out_of is distinct from plan.new_runs
    order by id limit 1;
    if target_id is not null then
      update public.atlanta_drivers set runs_out_of=plan.new_runs where id=target_id;
    end if;
  end loop;
end;
$backfill$;

do $verify$
begin
  if exists(select 1 from public.atlanta_drivers d join mdz_location_plan p using(profile_key)
    where d.mondelez_locations is distinct from p.new_locations or d.runs_out_of is distinct from p.new_runs) then
    raise exception 'Mondelez assignments did not synchronize across every linked profile';
  end if;
  if exists(select 1 from public.atlanta_drivers d join mdz_before_changes b on d.id=b.id
    where (to_jsonb(d)-array['mondelez_locations','runs_out_of']) is distinct from
          (b.before_image-array['mondelez_locations','runs_out_of'])) then
    raise exception 'Backfill changed a field outside Mondelez origins/membership';
  end if;
end;
$verify$;

select
  (select count(*) from mdz_history_matches) as history_rows_checked,
  (select count(*) from mdz_history_matches where matched_profile is null) as unmatched_or_conflicting_rows,
  (select count(*) from mdz_location_plan) as mondelez_driver_identities,
  (select count(*) from mdz_location_plan where cardinality(new_locations)>0) as assigned_driver_identities,
  (select count(*) from mdz_location_plan where coalesce(cardinality(new_locations),0)=0) as unassigned_driver_identities,
  (select count(*) from mdz_changed_groups) as updated_driver_identities,
  (select count(*) from private.driver_profile_sync_backups where migration_name='mondelez_locations_history_20261009') as backed_up_profiles;
commit;
