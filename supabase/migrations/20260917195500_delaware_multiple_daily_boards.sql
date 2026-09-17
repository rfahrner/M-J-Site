-- Delaware supports one or two separately titled load boards per day.
-- Existing Delaware dates receive board 1. The current 2026-09-17 board is
-- explicitly SCHNEIDER; earlier boards retain the regular Kroger label.

create table if not exists public.delaware_daily_boards (
  id bigint generated always as identity primary key,
  shift_date date not null,
  board_slot smallint not null check (board_slot between 1 and 2),
  board_type text not null check (board_type in ('kroger', 'schneider')),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  unique (shift_date, board_slot)
);

alter table public.delaware_daily_boards enable row level security;

drop policy if exists internal_all on public.delaware_daily_boards;
create policy internal_all
on public.delaware_daily_boards
for all
using ((select public.current_app_role()) = any (array['dispatcher'::text, 'accounting'::text, 'admin'::text, 'it'::text]))
with check ((select public.current_app_role()) = any (array['dispatcher'::text, 'accounting'::text, 'admin'::text, 'it'::text]));

grant select, insert, update, delete on public.delaware_daily_boards to authenticated;
grant usage, select on sequence public.delaware_daily_boards_id_seq to authenticated;

alter table public.loads_shifts
  add column if not exists delaware_board_slot smallint;

alter table public.loads_shifts
  drop constraint if exists loads_shifts_delaware_board_slot_check;
alter table public.loads_shifts
  add constraint loads_shifts_delaware_board_slot_check
  check (delaware_board_slot is null or delaware_board_slot between 1 and 2);

insert into public.delaware_daily_boards (shift_date, board_slot, board_type)
select distinct
  shift_date,
  1,
  case when shift_date = date '2026-09-17' then 'schneider' else 'kroger' end
from public.loads_shifts
where location = 'delaware'
on conflict (shift_date, board_slot) do update
set board_type = case
  when excluded.shift_date = date '2026-09-17' then 'schneider'
  else public.delaware_daily_boards.board_type
end;

update public.loads_shifts
set delaware_board_slot = 1
where location = 'delaware'
  and delaware_board_slot is null;

create index if not exists loads_shifts_delaware_date_board_idx
  on public.loads_shifts (shift_date, delaware_board_slot)
  where location = 'delaware';

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'delaware_daily_boards'
  ) then
    alter publication supabase_realtime add table public.delaware_daily_boards;
  end if;
end
$$;
