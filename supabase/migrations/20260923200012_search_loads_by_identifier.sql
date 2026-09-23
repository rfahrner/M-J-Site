-- Find a load from the Accounting page by Trip ID, Route ID, Load # or PRO #.
--
-- The Accounting sheet shows one location on one day, so reaching a load meant
-- already knowing its date and location -- usually the thing being asked.
--
-- Exact match only, case- and whitespace-insensitive. Partial matching was
-- considered and rejected against the real data: these columns are free text in
-- practice. loads_trips.trip_id genuinely contains 'TONU', 'txt 0441' and
-- 'Truck down @ 2230', so a LIKE '%...%' on a short query buries the answer
-- under unrelated loads.
--
-- More than one row can legitimately match: as of writing, 1,314 distinct
-- trip_id values and 2,773 route_id values sit on more than one load, and
-- 'TONU' alone is on 246. The caller shows a result list rather than guessing,
-- so this returns every match with enough context to tell them apart, plus
-- total_matches -- a list that silently stops at 50 reads as "that's all".
--
-- SECURITY INVOKER (the default, stated here on purpose): the search sees
-- exactly the rows the signed-in user may read, through the same RLS policies
-- as the board. It must never be changed to SECURITY DEFINER -- that would let
-- any authenticated role read every load in the system.

create index if not exists loads_shifts_aljex_load_number_lookup
  on public.loads_shifts (lower(btrim(aljex_load_number)))
  where coalesce(btrim(aljex_load_number), '') <> '';

create index if not exists loads_shifts_pro_number_lookup
  on public.loads_shifts (lower(btrim(pro_number)))
  where coalesce(btrim(pro_number), '') <> '';

create index if not exists loads_trips_trip_id_lookup
  on public.loads_trips (lower(btrim(trip_id)))
  where coalesce(btrim(trip_id), '') <> '';

create index if not exists loads_trips_route_id_lookup
  on public.loads_trips (lower(btrim(route_id)))
  where coalesce(btrim(route_id), '') <> '';

create index if not exists loads_houston_aljex_number_lookup
  on public.loads_houston (lower(btrim(aljex_number)))
  where coalesce(btrim(aljex_number), '') <> '';

create index if not exists mondelez_loads_aljex_number_lookup
  on public.mondelez_loads (lower(btrim(aljex_number)))
  where coalesce(btrim(aljex_number), '') <> '';

drop function if exists public.search_loads_by_identifier(text);

create function public.search_loads_by_identifier(p_query text)
returns table (
  source_table  text,
  source_id     bigint,
  trip_db_id    bigint,
  shift_date    date,
  customer      text,
  location      text,
  load_number   text,
  driver_name   text,
  matched_field text,
  matched_value text,
  total_matches bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  with q as (select lower(btrim(coalesce(p_query, ''))) as needle),
  hits as (
    -- Kroger board: the load's own numbers.
    select 'loads_shifts'::text as source_table, s.id as source_id, null::bigint as trip_db_id,
           s.shift_date, 'Kroger'::text as customer, s.location,
           coalesce(nullif(btrim(s.aljex_load_number), ''), nullif(btrim(s.pro_number), '')) as load_number,
           coalesce(nullif(btrim(s.driver_name_text), ''), nullif(btrim(d."Driver Name"), '')) as driver_name,
           case when lower(btrim(s.aljex_load_number)) = (select needle from q)
                then 'Load #' else 'PRO #' end as matched_field,
           case when lower(btrim(s.aljex_load_number)) = (select needle from q)
                then btrim(s.aljex_load_number) else btrim(s.pro_number) end as matched_value
      from loads_shifts s
      left join atlanta_drivers d on d.id = s.driver_id
     where (select needle from q) <> ''
       and (lower(btrim(s.aljex_load_number)) = (select needle from q)
         or lower(btrim(s.pro_number))        = (select needle from q))

    union all
    -- Kroger board: a route on the load. Carries the loads_trips row id so the
    -- modal opens on that route -- route_id is a name and repeats within one
    -- load, so the text alone cannot say which route was meant.
    select 'loads_shifts', s.id, t.id, s.shift_date, 'Kroger', s.location,
           coalesce(nullif(btrim(s.aljex_load_number), ''), nullif(btrim(s.pro_number), '')),
           coalesce(nullif(btrim(s.driver_name_text), ''), nullif(btrim(d."Driver Name"), '')),
           case when lower(btrim(t.trip_id)) = (select needle from q) then 'Trip ID' else 'Route ID' end,
           case when lower(btrim(t.trip_id)) = (select needle from q) then btrim(t.trip_id) else btrim(t.route_id) end
      from loads_trips t
      join loads_shifts s on s.id = t.shift_id
      left join atlanta_drivers d on d.id = s.driver_id
     where (select needle from q) <> ''
       and (lower(btrim(t.trip_id))  = (select needle from q)
         or lower(btrim(t.route_id)) = (select needle from q))

    union all
    select 'loads_houston', h.id, null::bigint, h.shift_date, 'Kroger', 'houston',
           btrim(h.aljex_number), nullif(btrim(h.driver_name), ''), 'Load #', btrim(h.aljex_number)
      from loads_houston h
     where (select needle from q) <> ''
       and lower(btrim(h.aljex_number)) = (select needle from q)

    union all
    select 'mondelez_loads', m.id, null::bigint, m.shift_date, 'Mondelez', coalesce(m.location, 'unknown'),
           btrim(m.aljex_number), nullif(btrim(m.driver_name), ''), 'Load #', btrim(m.aljex_number)
      from mondelez_loads m
     where (select needle from q) <> ''
       and lower(btrim(m.aljex_number)) = (select needle from q)
  )
  select source_table, source_id, trip_db_id, shift_date, customer, location,
         load_number, driver_name, matched_field, matched_value,
         count(*) over () as total_matches
    from hits
   order by shift_date desc nulls last, source_id desc
   limit 50;
$$;

comment on function public.search_loads_by_identifier(text) is
  'Exact, case-insensitive lookup of a load by Trip ID, Route ID, Load # or PRO # across the Kroger, Houston and Mondelez tables. SECURITY INVOKER: respects the caller''s RLS.';

grant execute on function public.search_loads_by_identifier(text) to authenticated;

-- Checked against the live database on 2026-09-23:
--   '1993193'  -> 1 hit  (loads_shifts 16167, Atlanta, David Williams, PRO #)
--   '999489'   -> 1 hit  (loads_houston 6315, 2022-09-16, Lee Moore)
--   '1992938'  -> 1 hit  (mondelez_loads 1363, West Chester, Omar)
--   'TONU'     -> 50 returned, total_matches 246; 'tonu' identical
--   '  1993193  ' -> 1 hit (padding ignored)
--   '199319'   -> 0 hits (a partial must not match)
--   '%'        -> 0 hits (not a wildcard)
--   '' / null  -> 0 hits
