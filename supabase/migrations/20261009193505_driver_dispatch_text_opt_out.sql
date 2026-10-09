-- Independent dispatcher opt-out; existing records retain their current behavior.
alter table public.atlanta_drivers add column if not exists do_not_text_dispatch boolean not null default false;
comment on column public.atlanta_drivers.do_not_text_dispatch is 'Exclude this dispatcher number from group texting; an allowed driver cell may still be used.';

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

