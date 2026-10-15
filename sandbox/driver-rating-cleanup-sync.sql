CREATE OR REPLACE FUNCTION public.sync_shared_driver_profile()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
$function$
