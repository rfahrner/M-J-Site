-- Applied to the live project on 2026-10-06.
--
-- Location Analytics showed $0.00 in every financial column -- revenue, cost,
-- margin, GM%, and all six per-unit ratios -- for a week, on a live business.
-- Not because there was no work: the week that rendered empty held ~$90,000 of
-- Atlanta revenue across 75 loads.
--
-- 20260929180000_accounting_status_deleted.sql introduced status='deleted' and
-- Location Analytics began filtering it out at the query with
-- .neq('status','deleted'). On the analytics pages, analytics-data-compat.js
-- redirects every read of loads_accounting to analytics_accounting_all -- and
-- that view was never widened to carry `status`. PostgREST rejects the WHOLE
-- request over a column the relation does not have, so the page got nothing
-- and rendered zeros.
--
-- Same shape as the bug 20260925210000 fixed on analytics_shifts_all, one view
-- over. Two views, one week apart, the same way: a page started asking for a
-- column and the view it actually reads was left behind.
--
-- Rows out of analytics_financial_history are archived billing records no
-- longer present in loads_accounting. They have no status of their own and
-- they must keep counting, so they report 'active'. A row that WAS deleted is
-- still in loads_accounting carrying status='deleted', and the first branch
-- reports that honestly -- so the page's filter still excludes it.

create or replace view public.analytics_accounting_all as
  select a.id,
         a.source_shift_id,
         a.shift_date,
         a.location,
         a.total_cost,
         a.total_revenue,
         a.status
    from loads_accounting a
  union all
  select h.original_accounting_id as id,
         h.original_shift_id      as source_shift_id,
         h.shift_date,
         h.location,
         h.total_cost,
         h.total_revenue,
         'active'::text           as status
    from analytics_financial_history h
   where not exists (select 1 from loads_accounting a where a.id = h.original_accounting_id);

alter view public.analytics_accounting_all set (security_invoker = true);
