-- The visitor boundary applies to signed-in visitor accounts only. Preserve
-- existing anonymous/public endpoint behavior without requiring a role-table read.
create or replace function public.check_visitor_request()
returns void language plpgsql stable security invoker set search_path = '' as $$
begin
  if (select auth.uid()) is null then return; end if;
  if exists(select 1 from public.user_roles where user_id=(select auth.uid()) and role='visitor')
     and trim(both '/' from coalesce(current_setting('request.path',true),'')) <> 'rpc/current_app_role' then
    raise insufficient_privilege using message='Visitor access does not include business data or changes.';
  end if;
end;
$$;
