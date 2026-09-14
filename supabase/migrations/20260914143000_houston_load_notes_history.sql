-- Houston Load Details support: permanent Notes log + field-by-field Change History.

create table if not exists public.houston_load_notes (
  id bigserial primary key,
  houston_load_id bigint not null references public.loads_houston(id) on delete cascade,
  note_text text not null,
  source text not null default 'modal',
  created_by text,
  created_at timestamptz not null default now()
);

create index if not exists houston_load_notes_load_idx
  on public.houston_load_notes(houston_load_id, created_at);

alter table public.houston_load_notes enable row level security;

drop policy if exists internal_select on public.houston_load_notes;
create policy internal_select on public.houston_load_notes
  for select to authenticated
  using ((select public.current_app_role()) = any (array['dispatcher','accounting','admin','it']::text[]));

drop policy if exists internal_insert on public.houston_load_notes;
create policy internal_insert on public.houston_load_notes
  for insert to authenticated
  with check ((select public.current_app_role()) = any (array['dispatcher','accounting','admin','it']::text[]));

create table if not exists public.houston_change_history (
  id bigserial primary key,
  houston_load_id bigint not null references public.loads_houston(id) on delete cascade,
  changed_at timestamptz not null default now(),
  field_name text not null,
  old_value text,
  new_value text,
  changed_by text,
  note text
);

create index if not exists houston_change_history_load_idx
  on public.houston_change_history(houston_load_id, changed_at desc);

alter table public.houston_change_history enable row level security;

drop policy if exists internal_select on public.houston_change_history;
create policy internal_select on public.houston_change_history
  for select to authenticated
  using ((select public.current_app_role()) = any (array['dispatcher','accounting','admin','it']::text[]));

drop policy if exists internal_insert on public.houston_change_history;
create policy internal_insert on public.houston_change_history
  for insert to authenticated
  with check ((select public.current_app_role()) = any (array['dispatcher','accounting','admin','it']::text[]));

drop policy if exists internal_update on public.houston_change_history;
create policy internal_update on public.houston_change_history
  for update to authenticated
  using ((select public.current_app_role()) = any (array['dispatcher','accounting','admin','it']::text[]))
  with check ((select public.current_app_role()) = any (array['dispatcher','accounting','admin','it']::text[]));

create or replace function public.log_houston_load_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  actor text := coalesce(auth.jwt()->>'email', auth.jwt()->>'sub', 'unknown user');
  item record;
begin
  for item in
    select * from (values
      ('driver', old.driver_name::text, new.driver_name::text),
      ('aljex_number', old.aljex_number::text, new.aljex_number::text),
      ('time', old.time::text, new.time::text),
      ('carrier', old.carrier::text, new.carrier::text),
      ('mc', old.mc::text, new.mc::text),
      ('rating', old.rating::text, new.rating::text),
      ('driver_phone', old.driver_phone::text, new.driver_phone::text),
      ('dispatcher_phone', old.dispatcher_phone::text, new.dispatcher_phone::text),
      ('rate', old.normal_rate::text, new.normal_rate::text),
      ('ttc', old.ttc::text, new.ttc::text),
      ('ttt', old.ttt::text, new.ttt::text),
      ('comments', old.comments::text, new.comments::text),
      ('time_out_remarks', old.time_out_remarks::text, new.time_out_remarks::text),
      ('tonu', old.tonu::text, new.tonu::text),
      ('highlighted', old.highlighted::text, new.highlighted::text),
      ('shift_complete', old.shift_complete::text, new.shift_complete::text),
      ('image', old.route_image_path::text, new.route_image_path::text)
    ) as v(field_name, old_value, new_value)
  loop
    if item.old_value is distinct from item.new_value then
      insert into public.houston_change_history
        (houston_load_id, field_name, old_value, new_value, changed_by)
      values
        (new.id, item.field_name, item.old_value, item.new_value, actor);
    end if;
  end loop;
  return new;
end;
$$;

drop trigger if exists trg_log_houston_load_change on public.loads_houston;
create trigger trg_log_houston_load_change
after update on public.loads_houston
for each row execute function public.log_houston_load_change();
