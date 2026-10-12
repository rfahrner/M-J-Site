-- Load-level parity with Atlanta. Keep source figures for undo; cancellation
-- is a zero-dollar Accounting state, not an edit to the original rate.
alter table public.mondelez_loads
  add column called_off boolean not null default false,
  add column called_off_reason text,
  add column called_off_at timestamptz,
  add column load_cancelled boolean not null default false,
  add column load_cancelled_reason text,
  add column load_cancelled_at timestamptz;

-- Server-owned backup preserves pre-existing Accounting overrides on undo.
create table app_private.mondelez_cancellation_backup (
  source_id bigint primary key references public.mondelez_loads(id) on delete cascade,
  accounting_snapshot jsonb not null
);
alter table app_private.mondelez_cancellation_backup enable row level security;
revoke all on app_private.mondelez_cancellation_backup from public, anon, authenticated;

create function app_private.record_mondelez_cancellation()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  a public.loads_accounting%rowtype;
  saved public.loads_accounting%rowtype;
  backup jsonb;
  cancelled boolean := new.called_off or new.load_cancelled;
  reason text := case when new.load_cancelled then new.load_cancelled_reason else new.called_off_reason end;
  actor text := coalesce(nullif(split_part(auth.jwt()->>'email', '@', 1), ''), auth.jwt()->>'sub', 'User not recorded');
begin
  if tg_op = 'UPDATE' and new.called_off is not distinct from old.called_off
     and new.load_cancelled is not distinct from old.load_cancelled
     and new.called_off_reason is not distinct from old.called_off_reason
     and new.load_cancelled_reason is not distinct from old.load_cancelled_reason then return new; end if;
  if tg_op = 'INSERT' and not cancelled then return new; end if;
  if cancelled and nullif(btrim(reason), '') is null then raise exception 'A cancellation reason is required'; end if;

  select * into a from public.loads_accounting where source_mondelez_id = new.id for update;
  if a.id is not null and (a.status = 'released' or a.sent or a.deleted_at is not null) then
    raise exception 'This load has been sent, released or deleted in Accounting. Resolve it there before changing its cancellation.';
  end if;
  if cancelled then
    if a.id is null then
      insert into public.loads_accounting(source_mondelez_id, location, shift_date, aljex_load_number,
        driver_id, driver_name_text, cost_level, revenue_level, status, cancelled_reason,
        total_carrier_pay, total_cost, total_revenue, fsc_payment, total_miles, total_stops)
      values(new.id, 'mondelez', new.shift_date, new.aljex_number, new.driver_id, new.driver_name,
        1, 1, 'cancelled', reason, 0, 0, 0, 0, 0, 0);
    else
      if a.status <> 'cancelled' then
        insert into app_private.mondelez_cancellation_backup values(new.id, to_jsonb(a))
          on conflict(source_id) do nothing;
      end if;
      update public.loads_accounting set status='cancelled', cancelled_reason=reason,
        total_carrier_pay=0, total_cost=0, total_revenue=0, fsc_payment=0, total_miles=0, total_stops=0
        where id=a.id;
    end if;
  else
    select accounting_snapshot into backup from app_private.mondelez_cancellation_backup where source_id=new.id;
    if backup is not null and a.status='cancelled' then
      saved := jsonb_populate_record(null::public.loads_accounting, backup);
      update public.loads_accounting set status=saved.status, cancelled_reason=saved.cancelled_reason,
        total_carrier_pay=saved.total_carrier_pay, total_cost=saved.total_cost,
        total_revenue=saved.total_revenue, fsc_payment=saved.fsc_payment,
        total_miles=saved.total_miles, total_stops=saved.total_stops,
        carrier_pay_manual=saved.carrier_pay_manual, revenue_manual=saved.revenue_manual
        where id=a.id;
      -- The existing carrier-edit trigger also copies pay into cost. Restore
      -- a distinct saved cost separately, without firing that pay trigger.
      update public.loads_accounting set total_cost=saved.total_cost where id=a.id;
    elsif backup is null then
      -- A cancellation created before the regular overnight push has no
      -- previous active record. The normal sweep can pick it up after undo.
      delete from public.loads_accounting where source_mondelez_id=new.id and status='cancelled';
    end if;
    delete from app_private.mondelez_cancellation_backup where source_id=new.id;
  end if;

  if new.called_off and (tg_op='INSERT' or not old.called_off) and new.driver_id is not null then
    insert into public.driver_notes(driver_id,note_text,created_by,note_type,
      source_shift_date,source_shift_start,source_load_label)
    values(new.driver_id, 'Mondelez ('||new.location||'): '||new.called_off_reason,actor,'cancellation',
      new.shift_date,new.start_time,new.aljex_number);
    -- source_shift_id deliberately stays null: this is not a loads_shifts ID.
  end if;
  insert into public.mondelez_change_history(mondelez_load_id,field_name,old_value,new_value,changed_by,note)
    values(new.id,'cancellation',case when tg_op='UPDATE' then concat('driver=',old.called_off,', customer=',old.load_cancelled) else 'new load' end,
      concat('driver=',new.called_off,', customer=',new.load_cancelled),actor,reason);
  return new;
end;
$$;
revoke all on function app_private.record_mondelez_cancellation() from public, anon, authenticated;
create trigger mondelez_cancellation_to_accounting after insert or update of called_off,load_cancelled,called_off_reason,load_cancelled_reason
  on public.mondelez_loads for each row execute function app_private.record_mondelez_cancellation();

-- The overnight sweep and later Accounting edits must also respect cancellation.
create function app_private.guard_mondelez_cancelled_accounting()
returns trigger language plpgsql security definer set search_path = '' as $$
declare m public.mondelez_loads%rowtype;
begin
  if new.source_mondelez_id is null then return new; end if;
  select * into m from public.mondelez_loads where id=new.source_mondelez_id;
  if m.called_off or m.load_cancelled then
    new.status := 'cancelled';
    new.cancelled_reason := case when m.load_cancelled then m.load_cancelled_reason else m.called_off_reason end;
    new.total_carrier_pay := 0; new.total_cost := 0; new.total_revenue := 0;
    new.fsc_payment := 0; new.total_miles := 0; new.total_stops := 0;
  end if;
  return new;
end;
$$;
revoke all on function app_private.guard_mondelez_cancelled_accounting() from public, anon, authenticated;
create trigger guard_mondelez_cancelled_accounting before insert or update on public.loads_accounting
  for each row execute function app_private.guard_mondelez_cancelled_accounting();
