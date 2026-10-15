-- Production trigger definitions inspected 2026-10-15. No live data.
CREATE OR REPLACE FUNCTION public.mark_accounting_manual_carrier_edit()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_catalog'
AS $function$
begin
  if new.location in ('atlanta','delaware','buildingc')
     and current_setting('app.accounting_rate_refresh',true) is distinct from 'on' then
    new.carrier_pay_manual := new.total_carrier_pay is not null;
  end if;
  return new;
end;
$function$
;
drop trigger if exists accounting_manual_carrier_from_edit on public.loads_accounting;
CREATE TRIGGER accounting_manual_carrier_from_edit BEFORE UPDATE OF total_carrier_pay ON public.loads_accounting FOR EACH ROW EXECUTE FUNCTION mark_accounting_manual_carrier_edit();

CREATE OR REPLACE FUNCTION public.clear_accounting_manual_carrier_on_push()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_catalog'
AS $function$
begin
  new.carrier_pay_manual := false;
  return new;
end;
$function$
;
drop trigger if exists clear_accounting_manual_carrier_on_push on public.loads_accounting;
CREATE TRIGGER clear_accounting_manual_carrier_on_push BEFORE UPDATE OF pushed_at ON public.loads_accounting FOR EACH ROW EXECUTE FUNCTION clear_accounting_manual_carrier_on_push();

CREATE OR REPLACE FUNCTION app_private.guard_mondelez_cancelled_accounting()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$
;
drop trigger if exists guard_mondelez_cancelled_accounting on public.loads_accounting;
CREATE TRIGGER guard_mondelez_cancelled_accounting BEFORE INSERT OR UPDATE ON public.loads_accounting FOR EACH ROW EXECUTE FUNCTION app_private.guard_mondelez_cancelled_accounting();

CREATE OR REPLACE FUNCTION public.set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  NEW.updated_at = pg_catalog.now();
  return NEW;
end;
$function$
;
drop trigger if exists loads_accounting_updated_at on public.loads_accounting;
CREATE TRIGGER loads_accounting_updated_at BEFORE UPDATE ON public.loads_accounting FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION app_private.sync_accounting_total_cost_from_carrier_edit()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_catalog'
AS $function$
begin
  if new.total_carrier_pay is distinct from old.total_carrier_pay then
    new.total_cost := new.total_carrier_pay;
  end if;
  return new;
end;
$function$
;
drop trigger if exists trg_sync_accounting_total_cost_from_carrier_edit on public.loads_accounting;
CREATE TRIGGER trg_sync_accounting_total_cost_from_carrier_edit BEFORE UPDATE OF total_carrier_pay ON public.loads_accounting FOR EACH ROW EXECUTE FUNCTION app_private.sync_accounting_total_cost_from_carrier_edit();

