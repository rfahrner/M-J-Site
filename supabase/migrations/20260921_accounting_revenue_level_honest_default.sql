-- Applied to the live project on 2026-09-21. Kept here so the repo and the
-- database do not drift. The full function body is in the migration applied
-- via MCP; the only edit to it is the literal 99 -> 1 in the INSERT column
-- list of new_accounting.

-- auto_send_shifts_to_accounting() prices every route from the revenue_1 tier
-- table, hardcoded, but stamped the record `revenue_level = 99`. 99 matches no
-- pricing table, so the record claimed a level it was never priced at.
--
-- That is not merely untidy. calcRoute() in the browser looks up
-- tiers['revenue_' || level]; for 99 it finds nothing, falls through to a
-- per-mile rate that also does not exist, and settles on ZERO linehaul revenue.
-- Recalculating any of these records -- which happens the moment anyone touches
-- the Cost Level dropdown on that row -- would have dropped an 84.9-mile route
-- from $465 to $100, keeping only the stop charges.
--
-- Stamping 1 makes the label agree with how the money was actually calculated.
-- No stored total changes: revenue_1 is exactly what the trigger used. Verified
-- after applying: 14,179 records relabelled, every total_revenue unchanged.
update public.loads_accounting set revenue_level = 1 where revenue_level = 99;

-- and new records are stamped 1 rather than 99 -- see the note above.
