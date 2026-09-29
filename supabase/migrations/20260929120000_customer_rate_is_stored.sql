-- Applied to the live project on 2026-09-29. Recorded here so the schema
-- history carries the reasoning, not just the result.
--
-- THE PROBLEM
--
-- The customer rate is not a calculated number. In the accounting workbook,
-- column DU ("Current Kroger Rate") holds 10,882 numbers and only 313 carry a
-- formula. The site treated it as derived and rebuilt it from pricing_tiers on
-- every route change and every rate push, so a rate someone typed survived only
-- until the next edit -- and changing the rate table, a driver rate or the FSC
-- rate silently re-priced every historical load it touched.
--
-- The rule, in the user's words: a rate change applies going forward. It does
-- not apply to the past.
--
-- THE FIX, IN FOUR PARTS
--
-- 1. loads_accounting.revenue_manual records "a person set this figure". Both
--    functions that recompute revenue check it and leave the money alone:
--    sync_standard_accounting_routes_for_shift() and, because it was a second
--    writer nobody had noticed, refresh_atlanta_accounting_route_v2(). Miles,
--    stops and FSC still refresh -- they describe the load, they do not price
--    it.
--
-- 2. fsc_rate_snapshot is stamped on EVERY row, not just rows with a
--    source_shift_id. A null falls back to today's diesel price, which is the
--    wrong day for every row but today's; 80 Delaware and 152 Mondelez rows
--    with real mileage were in that state.
--
-- 3. revenue_level 99 is gone. It matched no pricing table, and calcRoute()
--    bills zero linehaul for an unknown level.
--
-- 4. Revenue level 4 (Market) exists now: carrier cost divided by
--    market_revenue_divisor, the workbook's "Revenue Market" column
--    (IF($U=4, cost/0.85, 0)). What looked like a rival pricing formula was
--    simply this level -- about 40% of September's loads. Levels 1 and 2
--    already matched the workbook exactly: the same bands, the same 2.40 and
--    2.80 over-band rates, stops x 50, diesel x 0.133.
--
-- Verified against the workbook's own daily totals after backfilling 1,417
-- loads from columns DU and DV: 2026-08-02 revenue 22,161.22 and cost
-- 20,485.00 on both sides, and the same agreement on 08-03 and 08-04 to within
-- the cent that rounding DU's repeating decimals costs.
--
-- The statements themselves were applied as:
--   customer_rate_is_stored_not_computed
--   route_refresh_respects_stored_customer_rate
--   fsc_snapshot_every_row_and_market_level
--   market_revenue_level_four
--   revenue_rate_accepts_market_and_freezes

alter table public.loads_accounting
  add column if not exists revenue_manual boolean not null default false;

comment on column public.loads_accounting.revenue_manual is
  'True when total_revenue is a customer rate someone set (backfilled from the accounting workbook, or typed into the Customer Rate cell). While true, the recompute paths leave total_revenue alone so a later rate change cannot re-price a historical load.';
