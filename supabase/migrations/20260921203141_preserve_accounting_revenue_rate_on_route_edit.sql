CREATE OR REPLACE FUNCTION app_private.refresh_atlanta_accounting_route_v2()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v_location text;
  v_revenue_level integer;
  v_fsc_rate numeric;
  v_base numeric;
  v_stop numeric;
  v_fsc numeric;
  v_parent_revenue numeric;
  v_parent_fsc numeric;
  v_parent_miles numeric;
  v_parent_stops numeric;
begin
  select a.location, a.revenue_level,
         coalesce(a.fsc_rate_snapshot,
                  (select value from public.pricing_settings where key='fsc_rate' limit 1),
                  0)
    into v_location, v_revenue_level, v_fsc_rate
  from public.loads_accounting a
  where a.id=new.accounting_id;

  if v_location <> 'atlanta' then return new; end if;

  v_base := app_private.kroger_customer_base_rate(coalesce(new.miles,0), case when v_revenue_level = 2 then 'holiday' else 'weekday' end);
  v_stop := round(coalesce(new.stops,0) * 50, 2);
  v_fsc := round(v_fsc_rate * 0.133 * coalesce(new.miles,0), 2);

  update public.loads_accounting_routes
     set linehaul_cost=0,
         stop_charge=0,
         total_cost=0,
         revenue=v_base,
         stop_charge_revenue=v_stop,
         total_revenue=round(v_base + v_stop + v_fsc, 2)
   where id=new.id;

  select coalesce(sum(r.total_revenue),0),
         coalesce(sum(v_fsc_rate * 0.133 * coalesce(r.miles,0)),0),
         coalesce(sum(coalesce(r.miles,0)),0),
         coalesce(sum(coalesce(r.stops,0)),0)
    into v_parent_revenue, v_parent_fsc, v_parent_miles, v_parent_stops
  from public.loads_accounting_routes r
  where r.accounting_id=new.accounting_id;

  update public.loads_accounting
     set total_revenue=round(v_parent_revenue,2),
         fsc_payment=round(v_parent_fsc,2),
         total_miles=v_parent_miles,
         total_stops=v_parent_stops
   where id=new.accounting_id;

  return new;
end;
$function$
;
