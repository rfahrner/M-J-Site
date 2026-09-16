alter table public.loads_accounting
  add column if not exists notes_snapshot jsonb not null default '[]'::jsonb,
  add column if not exists change_history_snapshot jsonb not null default '[]'::jsonb;

create or replace function public.refresh_accounting_audit_snapshot(p_shift_id bigint)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  if p_shift_id is null then return; end if;

  update public.loads_accounting a
     set notes_snapshot = coalesce((
           select jsonb_agg(to_jsonb(n) order by n.created_at, n.id)
           from public.load_notes n
           where n.shift_id = p_shift_id
         ), '[]'::jsonb),
         change_history_snapshot = coalesce((
           select jsonb_agg(to_jsonb(h) order by h.changed_at, h.id)
           from public.load_change_history h
           where h.shift_id = p_shift_id
         ), '[]'::jsonb)
   where a.source_shift_id = p_shift_id;
end;
$$;

create or replace function public.sync_accounting_audit_from_source()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_shift_id bigint;
begin
  v_shift_id := coalesce(new.shift_id, old.shift_id);

  if tg_op = 'DELETE' and not exists (select 1 from public.loads_shifts s where s.id = v_shift_id) then
    return old;
  end if;

  perform public.refresh_accounting_audit_snapshot(v_shift_id);
  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_load_notes_accounting_snapshot on public.load_notes;
create trigger trg_load_notes_accounting_snapshot
after insert or update or delete on public.load_notes
for each row execute function public.sync_accounting_audit_from_source();

drop trigger if exists trg_load_history_accounting_snapshot on public.load_change_history;
create trigger trg_load_history_accounting_snapshot
after insert or update or delete on public.load_change_history
for each row execute function public.sync_accounting_audit_from_source();

create or replace function public.seed_accounting_audit_snapshot()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  if new.source_shift_id is not null then
    perform public.refresh_accounting_audit_snapshot(new.source_shift_id);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_accounting_seed_audit_snapshot on public.loads_accounting;
create trigger trg_accounting_seed_audit_snapshot
after insert or update of source_shift_id on public.loads_accounting
for each row execute function public.seed_accounting_audit_snapshot();

update public.loads_accounting a
set notes_snapshot = coalesce((
      select jsonb_agg(to_jsonb(n) order by n.created_at, n.id)
      from public.load_notes n
      where n.shift_id = a.source_shift_id
    ), '[]'::jsonb),
    change_history_snapshot = coalesce((
      select jsonb_agg(to_jsonb(h) order by h.changed_at, h.id)
      from public.load_change_history h
      where h.shift_id = a.source_shift_id
    ), '[]'::jsonb)
where a.source_shift_id is not null;
