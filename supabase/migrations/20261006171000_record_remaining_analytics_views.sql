-- Applied to the live project on 2026-10-06. NOT A CHANGE: these three views
-- are recorded here exactly as the database already defines them, so running
-- this migration is a no-op.
--
-- Why they are being written down. analytics-data-compat.js redirects five
-- tables to five views, and twice now a page has out-grown the view it
-- actually reads and the whole query has 400'd:
--
--   2026-09-25  analytics_shifts_all      -- 0 drivers, 0 loads, 0 miles
--   2026-10-06  analytics_accounting_all  -- $0.00 in every financial column
--
-- scripts/analytics-view-columns.test.mjs guards against exactly that, and it
-- guards by reading the view definition out of supabase/migrations. Three of
-- the five views had no migration at all -- they existed only in the live
-- database -- so the test could not see them and the next page to out-grow
-- one of THEM would have failed the same silent way. A view this repo cannot
-- read is a view this repo cannot protect.
--
-- Keep that true: a view added to the compat map belongs in a migration here,
-- or the test will say so.

create or replace view public.analytics_trips_all as
  select t.id,
         t.shift_id,
         t.route_id,
         t.trip_id,
         t.route_miles,
         t.stop_count,
         t.salvage,
         t.backhaul
    from loads_trips t
  union all
  select h.original_trip_id  as id,
         h.original_shift_id as shift_id,
         h.route_id,
         h.trip_id,
         h.route_miles,
         h.stop_count,
         h.salvage,
         h.backhaul
    from analytics_route_history h
   where not exists (select 1 from loads_trips t where t.id = h.original_trip_id);

create or replace view public.analytics_houston_all as
  select h.id,
         h.shift_date,
         h.driver_id,
         h.aljex_number,
         h.tonu,
         h.shift_complete
    from loads_houston h
  union all
  select f.original_id as id,
         f.shift_date,
         f.driver_id,
         case when f.load_number = f.original_id::text then null::text else f.load_number end as aljex_number,
         f.tonu,
         f.shift_complete
    from analytics_load_fact_history f
   where f.source_table = 'loads_houston'::text
     and not exists (select 1 from loads_houston h where h.id = f.original_id);

create or replace view public.analytics_mondelez_all as
  select m.id,
         m.shift_date,
         m.driver_id,
         m.aljex_number,
         m.miles,
         m.tonu,
         m.shift_complete
    from mondelez_loads m
  union all
  select f.original_id as id,
         f.shift_date,
         f.driver_id,
         case when f.load_number = f.original_id::text then null::text else f.load_number end as aljex_number,
         f.route_miles as miles,
         f.tonu,
         f.shift_complete
    from analytics_load_fact_history f
   where f.source_table = 'mondelez_loads'::text
     and not exists (select 1 from mondelez_loads m where m.id = f.original_id);

alter view public.analytics_trips_all    set (security_invoker = true);
alter view public.analytics_houston_all  set (security_invoker = true);
alter view public.analytics_mondelez_all set (security_invoker = true);
