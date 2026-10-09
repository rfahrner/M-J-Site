-- Save explicit origin assignments separately from broad driver-list membership.
-- Existing profiles stay unassigned until a dispatcher selects their locations.
alter table public.atlanta_drivers add column if not exists mondelez_locations text[];
comment on column public.atlanta_drivers.mondelez_locations is 'Mondelez origin location keys selected on the driver profile; may contain multiple sites.';
