ALTER TABLE public.board_available_drivers
  ADD COLUMN IF NOT EXISTS notes text NOT NULL DEFAULT '';
