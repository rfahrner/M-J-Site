-- Roll back the Delaware multi-board feature.
-- No load records are deleted; the temporary board metadata and slot column are removed.

drop table if exists public.delaware_daily_boards;

drop index if exists public.loads_shifts_delaware_date_board_idx;

alter table public.loads_shifts
  drop constraint if exists loads_shifts_delaware_board_slot_check;

alter table public.loads_shifts
  drop column if exists delaware_board_slot;
