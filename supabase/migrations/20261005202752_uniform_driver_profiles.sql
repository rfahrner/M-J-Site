-- Keep list memberships/foreign-key IDs, but share one durable profile identity.
-- Backup before reconciliation; only internal database roles can read this table.
create schema if not exists private;
create table if not exists private.driver_profile_sync_backups (
  migration_name text not null,
  driver_id bigint not null,
  snapshot jsonb not null,
  saved_at timestamptz not null default now(),
  primary key (migration_name, driver_id)
);
alter table private.driver_profile_sync_backups enable row level security;
revoke all on private.driver_profile_sync_backups from public, anon, authenticated;

alter table public.atlanta_drivers add column if not exists profile_key uuid not null default gen_random_uuid();

-- Name + MC identifies the driver, never MC alone (a carrier has many drivers).
-- After linking, changing a name or MC preserves membership through profile_key.
create temporary table driver_profile_groups on commit drop as
select lower(regexp_replace(btrim("Driver Name"), '\s+', ' ', 'g')) as name_key,
       btrim("MC") as mc_key,
       (array_agg(profile_key order by id))[1] as profile_key
from public.atlanta_drivers
where nullif(btrim("Driver Name"), '') is not null and nullif(btrim("MC"), '') is not null
group by 1, 2 having count(distinct location) > 1;

insert into private.driver_profile_sync_backups (migration_name, driver_id, snapshot)
select 'uniform_driver_profiles', d.id, to_jsonb(d)
from public.atlanta_drivers d join driver_profile_groups g
on lower(regexp_replace(btrim(d."Driver Name"), '\s+', ' ', 'g')) = g.name_key and btrim(d."MC") = g.mc_key
on conflict do nothing;

update public.atlanta_drivers d set profile_key = g.profile_key
from driver_profile_groups g
where lower(regexp_replace(btrim(d."Driver Name"), '\s+', ' ', 'g')) = g.name_key and btrim(d."MC") = g.mc_key;

-- Preferred is the source for the user's already-entered updates. Empty fields
-- fall back to an existing populated value, so missing import data cannot erase it.
-- Runs-out-of is combined, retaining all existing operational memberships.
create temporary table driver_profile_values on commit drop as
with ranked as (
  select d.profile_key, e.key, e.value,
    row_number() over (partition by d.profile_key, e.key order by
      case when d.location = 'preferred' then 0 when d.location = 'atlanta' then 1 when d.location = 'buildingc' then 2 else 3 end, d.id) as rank
  from public.atlanta_drivers d
  cross join lateral jsonb_each(to_jsonb(d) - array['id','location','profile_key','runs_out_of']) e
  where d.profile_key in (select profile_key from driver_profile_groups)
    and e.value not in ('null'::jsonb, '""'::jsonb, '{}'::jsonb, '[]'::jsonb, '{"tiers":{},"settings":{}}'::jsonb)
), values_by_profile as (
  select profile_key, jsonb_object_agg(key, value) as patch from ranked where rank = 1 group by profile_key
), runs as (
  select d.profile_key, array_agg(distinct r.location order by r.location) as locations
  from public.atlanta_drivers d cross join lateral unnest(d.runs_out_of) r(location)
  where d.profile_key in (select profile_key from driver_profile_groups)
  group by d.profile_key
)
select v.profile_key, v.patch || jsonb_build_object('runs_out_of', coalesce(to_jsonb(r.locations), 'null'::jsonb)) as patch
from values_by_profile v left join runs r using(profile_key);

-- Only known shared columns are assigned. The row id and list location stay local.
do $reconcile$
declare shared_column text; assignments text;
begin
  select string_agg(format('%I = (jsonb_populate_record(d, v.patch)).%I', column_name, column_name), ', ')
  into assignments from information_schema.columns
  where table_schema = 'public' and table_name = 'atlanta_drivers' and column_name not in ('id','location','profile_key');
  execute 'update public.atlanta_drivers d set ' || assignments ||
    ' from driver_profile_values v where d.profile_key = v.profile_key and exists (select 1 from jsonb_each(v.patch) e where to_jsonb(d)->e.key is distinct from e.value)';
end;
$reconcile$;

create index if not exists atlanta_drivers_profile_key_idx on public.atlanta_drivers(profile_key);

create or replace function public.prepare_shared_driver_profile()
returns trigger language plpgsql security invoker set search_path = '' as $function$
declare source public.atlanta_drivers; matched_keys uuid[]; inherited jsonb;
begin
  if tg_op = 'UPDATE' then
    if new.profile_key is distinct from old.profile_key then
      raise exception 'Driver profile identity cannot be changed by an edit';
    end if;
    return new;
  end if;
  if nullif(btrim(new."Driver Name"), '') is null or nullif(btrim(new."MC"), '') is null then return new; end if;
  select array_agg(distinct d.profile_key) into matched_keys from public.atlanta_drivers d
  where lower(regexp_replace(btrim(d."Driver Name"), '\s+', ' ', 'g')) = lower(regexp_replace(btrim(new."Driver Name"), '\s+', ' ', 'g'))
    and btrim(d."MC") = btrim(new."MC");
  if cardinality(matched_keys) = 1 then
    new.profile_key := matched_keys[1];
    select * into source from public.atlanta_drivers where profile_key = new.profile_key order by id limit 1;
    select jsonb_object_agg(e.key, e.value) into inherited from jsonb_each(to_jsonb(source)) e
    where e.key not in ('id','location','profile_key') and
      (to_jsonb(new)->e.key) in ('null'::jsonb, '""'::jsonb, '{}'::jsonb, '[]'::jsonb, '{"tiers":{},"settings":{}}'::jsonb);
    new := jsonb_populate_record(new, coalesce(inherited, '{}'::jsonb));
  end if;
  return new;
end;
$function$;

create or replace function public.sync_shared_driver_profile()
returns trigger language plpgsql security invoker set search_path = '' as $function$
declare patch jsonb; assignments text;
begin
  -- Peer updates run the same triggers. Do not send them back around the group.
  if pg_trigger_depth() > 1 then return new; end if;
  select jsonb_object_agg(e.key, e.value) into patch from jsonb_each(to_jsonb(new)) e
  where e.key not in ('id','location','profile_key')
    and (tg_op = 'INSERT' or e.value is distinct from to_jsonb(old)->e.key);
  if patch is null then return new; end if;
  select string_agg(format('%I = ($1).%I', key, key), ', ') into assignments from jsonb_each(patch);
  execute 'update public.atlanta_drivers d set ' || assignments ||
    ' where d.profile_key = $2 and d.id <> $3 and exists (select 1 from jsonb_each($4) e where to_jsonb(d)->e.key is distinct from e.value)'
    using new, new.profile_key, new.id, patch;
  return new;
end;
$function$;

-- Trigger functions cannot be called as ordinary RPCs; retain invoker/RLS access.
revoke all on function public.prepare_shared_driver_profile() from public, anon;
revoke all on function public.sync_shared_driver_profile() from public, anon;
grant execute on function public.prepare_shared_driver_profile() to authenticated, service_role;
grant execute on function public.sync_shared_driver_profile() to authenticated, service_role;

create trigger prepare_shared_driver_profile before insert or update on public.atlanta_drivers
for each row execute function public.prepare_shared_driver_profile();
create trigger sync_shared_driver_profile after insert or update on public.atlanta_drivers
for each row execute function public.sync_shared_driver_profile();
