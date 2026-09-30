-- Applied to the live project on 2026-09-29.
--
-- A load deleted from the board must not vanish from Accounting.
--
-- loads_accounting.source_shift_id is ON DELETE SET NULL, so deleting a shift
-- already left its billing row behind -- but silently, indistinguishable from a
-- live load, still counted in every total, with nothing pointing back at what
-- it came from. Someone reconciling the sheet had no way to know.
--
-- 'deleted' makes that state visible instead of accidental: the row stays on
-- the sheet struck through and faded, drops out of the Location Analytics
-- totals, and can be restored from the sheet if the deletion was a mistake.
-- The figures are never zeroed, because Restore has to return the real ones.
--
-- Deliberately not 'cancelled'. A cancelled load is an operational fact -- the
-- work was called off and it carries no money by design. A deleted load is a
-- record-keeping act with money still attached.

alter table public.loads_accounting
  drop constraint if exists loads_accounting_status_check;

alter table public.loads_accounting
  add constraint loads_accounting_status_check
  check (status = any (array['active'::text, 'released'::text, 'cancelled'::text, 'deleted'::text]));

alter table public.loads_accounting
  add column if not exists deleted_at timestamptz;

comment on column public.loads_accounting.deleted_at is
  'When the load behind this row was deleted from the load board. Set alongside status = ''deleted''; cleared when the row is restored from the Accounting sheet.';

create index if not exists loads_accounting_status_idx
  on public.loads_accounting (status)
  where status = 'deleted';
