-- Add a location-specific negotiated rate card for Delaware drivers.
alter table public.atlanta_drivers
  add column if not exists delaware_rate_overrides jsonb;

comment on column public.atlanta_drivers.delaware_rate_overrides is
  'Optional Delaware mileage-tier and over-tier per-mile overrides for this driver.';
