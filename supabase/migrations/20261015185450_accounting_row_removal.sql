-- Accounting-only removal uses the existing hidden flag as a retained marker.
-- Keeping the linked record prevents all three nightly sweeps from recreating
-- it. Deleted status already excludes it from Location Analytics.
create or replace function public.keep_removed_accounting_deleted()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.hidden is true then
    new.status := 'deleted';
    new.deleted_at := coalesce(new.deleted_at, now());
    if tg_op='UPDATE' and old.hidden is true then
      -- Later board pushes/cancellations may still address the retained row.
      -- Preserve its money for recovery while allowing foreign-key cleanup.
      new.deleted_at := coalesce(old.deleted_at,new.deleted_at);
      new.total_carrier_pay := old.total_carrier_pay;
      new.total_cost := old.total_cost;
      new.total_revenue := old.total_revenue;
      new.carrier_pay_manual := old.carrier_pay_manual;
      new.revenue_manual := old.revenue_manual;
      new.fsc_payment := old.fsc_payment;
      new.fsc_rate_snapshot := old.fsc_rate_snapshot;
      new.total_miles := old.total_miles;
      new.total_stops := old.total_stops;
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.keep_removed_accounting_deleted() from public,anon;
grant execute on function public.keep_removed_accounting_deleted() to authenticated;
-- Alphabetically after the existing cancellation and carrier-edit triggers.
create trigger zz_keep_removed_accounting_deleted before insert or update
  on public.loads_accounting for each row execute function public.keep_removed_accounting_deleted();

-- Preserve the removal when an old source is eventually exported/purged.
-- Otherwise the financial-history view labels every archived amount active,
-- allowing a deleted Accounting amount to return to Analytics months later.
alter table public.analytics_financial_history
  add column if not exists accounting_removed boolean not null default false;
create or replace function public.capture_archived_accounting_removal()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  new.accounting_removed := coalesce(
    (select a.hidden from public.loads_accounting a where a.id=new.original_accounting_id),
    new.accounting_removed,false);
  return new;
end;
$$;
revoke all on function public.capture_archived_accounting_removal() from public,anon;
grant execute on function public.capture_archived_accounting_removal() to authenticated;
create trigger capture_archived_accounting_removal before insert or update
  on public.analytics_financial_history for each row execute function public.capture_archived_accounting_removal();

create or replace view public.analytics_accounting_all as
  select a.id,a.source_shift_id,a.shift_date,a.location,a.total_cost,a.total_revenue,a.status
    from public.loads_accounting a
  union all
  select h.original_accounting_id as id,h.original_shift_id as source_shift_id,
    h.shift_date,h.location,h.total_cost,h.total_revenue,
    case when h.accounting_removed then 'deleted'::text else 'active'::text end as status
    from public.analytics_financial_history h
    where not exists(select 1 from public.loads_accounting a where a.id=h.original_accounting_id);
alter view public.analytics_accounting_all set (security_invoker = true);
