CREATE OR REPLACE FUNCTION public.prepare_shared_driver_profile()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
    -- Adding list membership must preserve the existing dispatcher opt-out.
    new.do_not_text_dispatch := source.do_not_text_dispatch;
    new.do_not_text := source.do_not_text;
    select jsonb_object_agg(e.key, e.value) into inherited from jsonb_each(to_jsonb(source)) e
    where e.key not in ('id','location','profile_key') and
      (to_jsonb(new)->e.key) in ('null'::jsonb, '""'::jsonb, '{}'::jsonb, '[]'::jsonb, '{"tiers":{},"settings":{}}'::jsonb);
    new := jsonb_populate_record(new, coalesce(inherited, '{}'::jsonb));
  end if;
  return new;
end;
$function$;


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
$function$;
