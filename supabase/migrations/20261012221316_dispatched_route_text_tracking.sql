-- One prompt for each actual Dispatch Time entry, shared across dispatchers.
-- Existing live dispatches may show a reminder after the frontend is merged.
alter table public.loads_trips
  add column if not exists dispatch_text_event_id uuid not null default gen_random_uuid(),
  add column if not exists dispatch_text_sent_at timestamptz,
  add column if not exists dispatch_text_sent_event_id uuid,
  add column if not exists dispatch_text_sent_driver_key text;

create or replace function public.reset_dispatched_route_text()
returns trigger language plpgsql security invoker set search_path = public, pg_catalog as $$
begin
  new.dispatch_text_event_id := gen_random_uuid();
  new.dispatch_text_sent_at := null;
  new.dispatch_text_sent_event_id := null;
  new.dispatch_text_sent_driver_key := null;
  return new;
end;
$$;
revoke all on function public.reset_dispatched_route_text() from public,anon;
grant execute on function public.reset_dispatched_route_text() to authenticated;
create trigger reset_dispatched_route_text before update of dispatch_time on public.loads_trips
  for each row when (old.dispatch_time is distinct from new.dispatch_time)
  execute function public.reset_dispatched_route_text();
