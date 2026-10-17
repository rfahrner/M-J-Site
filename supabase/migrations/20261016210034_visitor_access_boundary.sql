-- Visitor sessions may authenticate and discover only their own application
-- role. They have no Data API access, including RPCs and owner-backed views.
create function public.check_visitor_request()
returns void language plpgsql stable security invoker set search_path = '' as $$
begin
  if exists(select 1 from public.user_roles where user_id=(select auth.uid()) and role='visitor')
     and trim(both '/' from coalesce(current_setting('request.path',true),'')) <> 'rpc/current_app_role' then
    raise insufficient_privilege using message='Visitor access does not include business data or changes.';
  end if;
end;
$$;
revoke all on function public.check_visitor_request() from public;
grant execute on function public.check_visitor_request() to anon, authenticated, service_role;
do $$
declare configured text;
begin
  select setting into configured from pg_roles r,unnest(coalesce(r.rolconfig,'{}')) setting
    where r.rolname='authenticator' and setting like 'pgrst.db_pre_request=%';
  if configured is not null then raise exception 'Existing Data API pre-request hook must be composed, not replaced: %',configured; end if;
end;
$$;
alter role authenticator set pgrst.db_pre_request = 'public.check_visitor_request';
notify pgrst, 'reload config';

-- Defense beyond PostgREST (for example GraphQL). Preserve current staff view
-- behavior and columns, including the existing Accounting analytics permissions.
do $$
declare name text; definition text;
begin
  foreach name in array array['analytics_trips_all','analytics_accounting_all'] loop
    definition := rtrim(pg_get_viewdef(('public.'||name)::regclass,true), E';\n ');
    execute format('create or replace view public.%I with (security_barrier=true) as select visitor_view.* from (%s) visitor_view where current_user in (''postgres'',''service_role'') or exists(select 1 from public.user_roles where user_id=(select auth.uid()) and role in (''dispatcher'',''accounting'',''admin'',''it''))',name,definition);
  end loop;
end;
$$;

-- These legacy definer RPCs did not check the caller's application role.
-- Add a visitor-only denial without changing existing staff/cron behavior.
do $$
declare signature text; function_sql text; body text; language text;
begin
  foreach signature in array array['public.push_shift_to_accounting(bigint,text)','public.refresh_accounting_audit_snapshot(bigint)','public.archive_backup_status()'] loop
    select pg_get_functiondef(p.oid),p.prosrc,l.lanname into function_sql,body,language
      from pg_proc p join pg_language l on l.oid=p.prolang where p.oid=signature::regprocedure;
    if language='plpgsql' then
      body := regexp_replace(body,'\mbegin\M', E'begin\n  if exists(select 1 from public.user_roles where user_id=(select auth.uid()) and role=''visitor'') then raise insufficient_privilege using message=''Visitor access is view-only.''; end if;', 'i');
    elsif language='sql' and signature='public.archive_backup_status()' then
      body := 'select case when exists(select 1 from public.user_roles where user_id=(select auth.uid()) and role=''visitor'') then ''{}''::jsonb else ('||rtrim(body,E';\n ')||') end;';
    else raise exception 'Unexpected language for %',signature;
    end if;
    select replace(function_sql,p.prosrc,body) into function_sql from pg_proc p where p.oid=signature::regprocedure;
    execute function_sql;
  end loop;
end;
$$;

-- Signed-out callers must not bypass the visitor boundary by omitting a JWT.
revoke execute on function public.push_shift_to_accounting(bigint,text), public.refresh_accounting_audit_snapshot(bigint), public.archive_backup_status() from public, anon;
grant execute on function public.push_shift_to_accounting(bigint,text), public.refresh_accounting_audit_snapshot(bigint), public.archive_backup_status() to authenticated, service_role;
