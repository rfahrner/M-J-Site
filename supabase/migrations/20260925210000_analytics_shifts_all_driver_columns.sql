-- Location Analytics reported $1,037,928.59 of Q3 revenue against 0 drivers,
-- 0 loads, 0 miles and 0 stops.
--
-- analytics-data-compat.js redirects every analytics-page read of loads_shifts
-- to this view. The view was built to expose exactly the columns the analytics
-- pages selected at the time. Location Analytics' select list has since grown
-- two of them -- driver_name_text and load_cancelled, both added when
-- countDrivers() started counting drivers typed by name rather than picked
-- from the list, and excluding loads we cancelled -- and the view never
-- followed.
--
-- PostgREST rejects a select naming a column the relation does not expose, and
-- it rejects the WHOLE request rather than the missing part. So the page
-- received no shifts at all. Routes are then fetched by shift_id IN (...) off
-- that empty list, which is why mileage, stops, salvage, backhauls and TONU
-- went to zero with it. Revenue and cost survived because they are queried by
-- date against analytics_accounting_all, which does expose everything asked of
-- it -- and a page showing real money beside zero drivers looks like a
-- business that had a quiet week, not a failed request.
--
-- The two columns are APPENDED. CREATE OR REPLACE VIEW keeps the existing
-- eight in their existing order and types, so nothing already reading this
-- view is affected.
--
-- The archived half is analytics_load_history, which stores the driver's name
-- as driver_name_snapshot and has no load_cancelled column at all. NULL rather
-- than false for that flag: the archive genuinely does not record it, and NULL
-- reads as "not cancelled" to countDrivers() exactly as false would without
-- asserting something the row cannot support.

create or replace view public.analytics_shifts_all as
  select
    s.id,
    s.location,
    s.shift_date,
    s.driver_id,
    s.tonu,
    s.called_off,
    s.called_off_reason,
    s.shift_complete,
    s.driver_name_text,
    s.load_cancelled
  from loads_shifts s
union all
  select
    h.original_shift_id as id,
    h.location,
    h.shift_date,
    h.driver_id,
    h.tonu,
    h.called_off,
    h.called_off_reason,
    h.shift_complete,
    h.driver_name_snapshot as driver_name_text,
    null::boolean as load_cancelled
  from analytics_load_history h
  where not exists (
    select 1 from loads_shifts s where s.id = h.original_shift_id
  );
