-- The weekly Kroger invoice needs three columns the analytics views did not expose.
--
-- Location Analytics reads through analytics_data-compat.js, which redirects
-- loads_accounting and loads_trips to these views so the page also sees
-- archived history. PostgREST rejects the WHOLE request over one unknown
-- column, and the page then draws zeros -- that has taken this application
-- down twice (2026-09-25 and 2026-10-06, both recorded in CLAUDE.md). So the
-- invoice cannot simply select driver_name_text, aljex_load_number and
-- trip_number: the views have to carry them first.
--
-- What each is for:
--   driver_name_text   the name printed on every driver-detail line. It comes
--                      from the ACCOUNTING row, not the shift: shift 15904 on
--                      2026-08-17 has a null driver_name_text and only a
--                      driver_id, while its accounting row carries the
--                      resolved "Atiba Ward" that the approved invoice prints.
--   aljex_load_number  the invoice's PRO #, taken from the first detail line.
--   trip_number        picks the driver's FIRST trip of the day, which is the
--                      Trip ID the invoice shows.
--
-- The archive tables have none of the three, so archived rows read NULL. That
-- is additive and safe today -- analytics_financial_history is empty and
-- analytics_route_history holds four rows -- but it is a real edge: once
-- financial archiving starts, an invoice for an archived week would lose its
-- driver names and its PRO. Widening analytics_financial_history and
-- analytics_route_history (and the archive writer that fills them) is the
-- fix, and it belongs with that work rather than here. The invoice reports a
-- week it cannot name rather than printing blank lines.
--
-- Ordering within each view is unchanged and every existing column keeps its
-- position, so nothing that already reads these views can notice.
create or replace view public.analytics_accounting_all as
 select a.id, a.source_shift_id, a.shift_date, a.location, a.total_cost, a.total_revenue,
        a.status, a.driver_name_text, a.aljex_load_number
   from loads_accounting a
union all
 select h.original_accounting_id as id, h.original_shift_id as source_shift_id, h.shift_date,
        h.location, h.total_cost, h.total_revenue,
        case when h.accounting_removed then 'deleted'::text else 'active'::text end as status,
        null::text as driver_name_text,
        null::text as aljex_load_number
   from analytics_financial_history h
  where not (exists (select 1 from loads_accounting a where a.id = h.original_accounting_id));

create or replace view public.analytics_trips_all as
 select t.id, t.shift_id, t.route_id, t.trip_id, t.route_miles, t.stop_count, t.salvage, t.backhaul,
        t.trip_number
   from loads_trips t
union all
 select h.original_trip_id as id, h.original_shift_id as shift_id, h.route_id, h.trip_id,
        h.route_miles, h.stop_count, h.salvage, h.backhaul,
        null::integer as trip_number
   from analytics_route_history h
  where not (exists (select 1 from loads_trips t where t.id = h.original_trip_id));
