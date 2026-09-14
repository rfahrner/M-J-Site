-- Delaware now uses the same mileage-tier rate-card model as Atlanta.
-- 0-25: $600
-- 26-75: $700
-- 76-150: $800
-- 151-200: $900
-- 201-250: $1000
-- >250: $4/mile

insert into public.board_rate_tiers (location, min_miles, max_miles, rate)
values
  ('delaware', 0, 25, 600),
  ('delaware', 26, 75, 700),
  ('delaware', 76, 150, 800),
  ('delaware', 151, 200, 900),
  ('delaware', 201, 250, 1000)
on conflict (location, min_miles, max_miles)
do update set rate = excluded.rate;

insert into public.board_rate_settings (location, key, value)
values ('delaware', 'over_tier_per_mile', 4)
on conflict (location, key)
do update set value = excluded.value;

-- Retire the old Delaware greater-of-flat-minimum/per-mile model.
delete from public.board_rate_settings
where location = 'delaware'
  and key in ('flat_minimum', 'per_mile');

-- Clear any obsolete date-scoped values from the retired model.
delete from public.board_rate_daily_overrides
where location = 'delaware'
  and kind = 'setting'
  and rate_key in ('flat_minimum', 'per_mile');
